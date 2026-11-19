// SPDX-License-Identifier: Apache-2.0
const fs = require('node:fs')
const { createEncoder } = require('./eccodes.cjs')

const hour = 60 * 60 * 1000
const eps = 1e-8
const signature = Buffer.from('GRIB')
const terminator = Buffer.from('7777')
const positiveLongitude = lon => ((lon % 360) + 360) % 360
const signedLongitude = lon => positiveLongitude(lon + 180) - 180

function readExactly(fd, buffer, position) {
  let bytes = 0
  while (bytes < buffer.length) {
    const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, position + bytes)
    if (!count) throw new Error('Unexpected end of GRIB asset')
    bytes += count
  }
}

function *messages(paths) {
  const header = Buffer.alloc(16)
  const trailer = Buffer.alloc(4)
  for (const path of paths) {
    const fd = fs.openSync(path, 'r')
    try {
      const size = fs.fstatSync(fd).size
      if (!size) throw new Error('Empty GRIB asset')
      for (let offset = 0; offset < size;) {
        readExactly(fd, header, offset)
        const length = Number(header.readBigUInt64BE(8))
        if (!header.subarray(0, 4).equals(signature) || header[7] !== 2 ||
            !Number.isSafeInteger(length) || length < 20 || length > size - offset)
          throw new Error('Expected contiguous GRIB2 messages')
        readExactly(fd, trailer, offset + length - 4)
        if (!trailer.equals(terminator)) throw new Error('Invalid GRIB2 message terminator')
        yield { fd, offset, length }
        offset += length
      }
    } finally { fs.closeSync(fd) }
  }
}

function nextFloat(value) {
  if (value === 0) return Number.MIN_VALUE
  const bits = new DataView(new ArrayBuffer(8))
  bits.setFloat64(0, value)
  bits.setBigUint64(0, bits.getBigUint64(0) + (value > 0 ? 1n : -1n))
  return bits.getFloat64(0)
}

function crop(message, [west, south, east, north]) {
  if (message.getString('gridType') !== 'regular_ll' || message.getLong('scanningMode') !== 0)
    throw new Error('Expected a regular latitude/longitude grid scanned west to east, north to south')

  const ni = message.getLong('Ni')
  const nj = message.getLong('Nj')
  const dx = message.getDouble('iDirectionIncrementInDegrees')
  const dy = message.getDouble('jDirectionIncrementInDegrees')
  if (Math.abs(dx - 0.025) > 1e-10 || Math.abs(dy - 0.025) > 1e-10)
    throw new Error('Expected the AROME 0.025-degree grid')
  const lon = signedLongitude(message.getDouble('longitudeOfFirstGridPointInDegrees'))
  const lat = message.getDouble('latitudeOfFirstGridPointInDegrees')
  if (!(lon - eps <= west && west < east && east <= lon + (ni - 1) * dx + eps &&
        lat - (nj - 1) * dy - eps <= south && south < north && north <= lat + eps))
    throw new Error('Requested bounding box must be fully covered by the source grid')

  const left = Math.max(0, Math.ceil((west - eps - lon) / dx))
  const right = Math.min(ni - 1, Math.floor((east + eps - lon) / dx))
  const top = Math.max(0, Math.ceil((lat - (north + eps)) / dy))
  const bottom = Math.min(nj - 1, Math.floor((lat - (south - eps)) / dy))
  const width = right - left + 1
  const height = bottom - top + 1
  const count = width * height
  if (width < 2 || height < 2 || count === ni * nj)
    throw new Error('Requested bounding box must produce a smaller grid with at least two points per axis')

  const values = message.values()
  if (values.length !== ni * nj) throw new Error('Invalid GRIB grid value count')
  const hasBitmap = message.getLong('bitmapPresent')
  if (!hasBitmap && message.getLong('numberOfMissing'))
    throw new Error('Missing GRIB values require a bitmap')
  const bitmap = hasBitmap ? message.bitmap(values.length) : undefined
  const output = new Float64Array(count)
  let out = 0
  let missingCount = 0
  let maximum = -Infinity
  for (let row = top; row <= bottom; row++) {
    for (let col = left; col <= right; col++) {
      const index = row * ni + col
      if (bitmap && !bitmap[index]) {
        output[out++] = NaN
        missingCount++
      } else {
        const value = values[index]
        output[out++] = value
        maximum = Math.max(maximum, value)
      }
    }
  }
  if (missingCount === count) throw new Error('Crop contains only missing values')
  if (!Number.isFinite(maximum)) throw new Error('Crop contains non-finite values')
  if (missingCount) {
    // ecCodes uses a sentinel to rebuild the bitmap. Make it distinct from
    // all retained values, even if the input sentinel equals a real value.
    const missing = nextFloat(maximum)
    for (let i = 0; i < count; i++) if (Number.isNaN(output[i])) output[i] = missing
    message.setDouble('missingValue', missing)
  }
  message.setLong('Ni', width)
  message.setLong('Nj', height)
  message.setDouble('longitudeOfFirstGridPointInDegrees', positiveLongitude(lon + left * dx))
  message.setDouble('longitudeOfLastGridPointInDegrees', positiveLongitude(lon + right * dx))
  message.setDouble('latitudeOfFirstGridPointInDegrees', lat - top * dy)
  message.setDouble('latitudeOfLastGridPointInDegrees', lat - bottom * dy)
  message.setLong('bitmapPresent', missingCount ? 1 : 0)
  message.setValues(output)
  if (message.getLong('numberOfPoints') !== count || message.getLong('numberOfMissing') !== missingCount)
    throw new Error('Output point count or bitmap does not match the requested crop')
  return [
    signedLongitude(message.getDouble('longitudeOfFirstGridPointInDegrees')),
    message.getDouble('latitudeOfLastGridPointInDegrees'),
    signedLongitude(message.getDouble('longitudeOfLastGridPointInDegrees')),
    message.getDouble('latitudeOfFirstGridPointInDegrees')
  ]
}

function validityTime(message) {
  const date = String(message.getLong('validityDate'))
  const time = String(message.getLong('validityTime')).padStart(4, '0')
  const stamp = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${time.slice(0, 2)}:${time.slice(2)}:00Z`)
  if (!Number.isFinite(stamp)) throw new Error('Invalid GRIB forecast time')
  return stamp
}

async function processGrib({ selection, paths, output, maxBytes }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid GRIB export size limit')
  const fields = new Set(selection.fields)
  const bbox = selection.bbox
  const from = selection.from === undefined ? undefined : Date.parse(selection.from)
  const to = selection.to === undefined ? undefined : Date.parse(selection.to)
  const selectTime = from !== undefined
  if (selectTime !== (to !== undefined) || (selectTime && !(Number.isFinite(from) && Number.isFinite(to) && from <= to)))
    throw new Error('Invalid GRIB forecast interval')
  const encoder = fields.size || bbox || selectTime ? await createEncoder() : undefined
  const observed = new Map()
  const io = Buffer.allocUnsafe(64 * 1024)
  let messageCount = 0
  let total = 0
  let bounds
  let cycle

  const out = fs.openSync(output, 'wx')
  function write(bytes) {
    if (bytes.length > maxBytes - total) throw new Error('GRIB export exceeds its output size limit')
    for (let offset = 0; offset < bytes.length;) {
      const written = fs.writeSync(out, bytes, offset, bytes.length - offset)
      if (!written) throw new Error('Could not write GRIB export')
      offset += written
    }
    total += bytes.length
  }

  function copy({ fd, offset, length }) {
    for (let bytes = 0; bytes < length;) {
      const chunk = io.subarray(0, Math.min(io.length, length - bytes))
      readExactly(fd, chunk, offset + bytes)
      write(chunk)
      bytes += chunk.length
    }
  }

  try {
    try {
      for (const input of messages(paths)) {
        if (!encoder) {
          copy(input)
          messageCount++
          continue
        }
        const bytes = Buffer.allocUnsafe(input.length)
        readExactly(input.fd, bytes, input.offset)
        encoder.read(bytes, message => {
          const currentCycle = `${message.getLong('dataDate')}:${message.getLong('dataTime')}`
          cycle ??= currentCycle
          if (cycle !== currentCycle) throw new Error('All inputs must come from the same model run')
          const field = message.getString('shortName')
          if (fields.size && !fields.has(field)) return
          const time = validityTime(message)
          if (selectTime && (time < from || time > to)) return
          if (bbox) {
            const extent = crop(message, bbox)
            if (bounds && bounds.some((value, i) => value !== extent[i]))
              throw new Error('Selected messages have different cropped extents')
            bounds = extent
            message.writeBytes(write)
          } else write(bytes)
          messageCount++
          if (!observed.has(field)) observed.set(field, new Set())
          observed.get(field).add(time)
        })
      }
      if (!messageCount || [...fields].some(field => !observed.has(field)))
        throw new Error('Requested fields were not all found in the selected forecast steps')
      if (selectTime) {
        for (let time = from; time <= to; time += hour) {
          if ([...fields].some(field => !observed.get(field).has(time)))
            throw new Error('A requested field is missing at one or more requested hourly forecast times')
        }
      }
    } finally { fs.closeSync(out) }
  } catch (error) {
    fs.rmSync(output, { force: true })
    throw error
  }
  const times = fields.size || selectTime
    ? Array.from(new Set([...observed.values()].flatMap(set => [...set]))).sort((a, b) => a - b)
    : []
  return {
    messageCount,
    ...(bounds ? { bounds } : {}),
    ...(times.length ? { forecastTimes: times.map(time => new Date(time).toISOString().replace('.000Z', 'Z')) } : {}),
  }
}

async function main() {
  if (process.argv[2] === '--check') {
    await createEncoder()
    return
  }
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const result = await processGrib(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  process.stdout.write(JSON.stringify(result))
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(error.message + '\n')
    process.exitCode = 1
  })
}

module.exports = { processGrib }
