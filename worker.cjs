// SPDX-License-Identifier: Apache-2.0
const fs = require('node:fs')
const { createEncoder } = require('./eccodes.cjs')

const eps = 1e-8
const signature = Buffer.from('GRIB')
const terminator = Buffer.from('7777')
const positiveLongitude = lon => ((lon % 360) + 360) % 360
const longitudeNear = (lon, reference) => lon + 360 * Math.round((reference - lon) / 360)
const aliases = new Map([
  ['eastward_wind', '10u'],
  ['northward_wind', '10v'],
  ['air_pressure_at_mean_sea_level', 'prmsl']
])

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

function gridGeometry(message) {
  if (message.getString('gridType') !== 'regular_ll')
    throw new Error('Spatial selection requires a regular latitude-longitude grid')
  const scanning = message.getLong('scanningMode')

  const ni = message.getLong('Ni')
  const nj = message.getLong('Nj')
  const dx = message.getDouble('iDirectionIncrementInDegrees')
  const dy = message.getDouble('jDirectionIncrementInDegrees')
  if (ni < 2 || nj < 2 || !Number.isFinite(dx) || !Number.isFinite(dy) || dx <= 0 || dy <= 0)
    throw new Error('Invalid regular latitude-longitude grid dimensions or increments')
  const iReversed = Boolean(scanning & 128)
  const jReversed = Boolean(scanning & 64)
  const lon = message.getDouble('longitudeOfFirstGridPointInDegrees') - (iReversed ? (ni - 1) * dx : 0)
  const lat = message.getDouble('latitudeOfFirstGridPointInDegrees') + (jReversed ? (nj - 1) * dy : 0)
  const span = (ni - 1) * dx
  if (!Number.isFinite(lon) || !Number.isFinite(lat) ||
      lat > 90 + eps || lat - (nj - 1) * dy < -90 - eps || span > 360 + eps)
    throw new Error('Invalid regular latitude-longitude grid bounds')
  // A global grid may include its first meridian again as the last column.
  const columns = Math.abs(span - 360) <= eps ? ni - 1 : ni
  const cyclic = Math.abs(columns * dx - 360) <= eps
  return { ni, nj, dx, dy, iReversed, jReversed, lon, lat, span, columns, cyclic, scanning }
}

const supportsScanning = scanning => [0, 64, 128, 192].includes(scanning)

function gridBounds({ lon, lat, span, nj, dy, cyclic }) {
  const west = positiveLongitude(lon + 180) - 180
  const east = west + span
  return [cyclic ? -180 : west, Math.max(-90, lat - (nj - 1) * dy),
    cyclic ? 180 : east > 180 + eps ? east - 360 : Math.min(180, east), Math.min(90, lat)]
    .map(value => Number(value.toFixed(9)))
}

function crop(message, [west, south, east, north]) {
  const { ni, nj, dx, dy, iReversed, jReversed, lon, lat, span, columns, cyclic, scanning } = gridGeometry(message)
  if (!supportsScanning(scanning))
    throw new Error('Spatial selection requires a grid scanned by rows in a constant direction')
  const westOffset = longitudeNear(west, lon + 180 - eps) - lon
  const eastOffset = westOffset + east - west
  if (!(west < east && south < north &&
        (cyclic || (westOffset >= -eps && eastOffset <= span + eps)) &&
        lat - (nj - 1) * dy - eps <= south && north <= lat + eps))
    throw new Error('Requested bounding box must be fully covered by the source grid')

  const left = Math.max(0, Math.ceil((westOffset - eps) / dx))
  const right = Math.min(cyclic ? left + columns - 1 : ni - 1, Math.floor((eastOffset + eps) / dx))
  const top = Math.max(0, Math.ceil((lat - (north + eps)) / dy))
  const bottom = Math.min(nj - 1, Math.floor((lat - (south - eps)) / dy))
  const width = right - left + 1
  const height = bottom - top + 1
  const count = width * height
  if (width < 2 || height < 2)
    throw new Error('Requested bounding box must contain at least two grid points per axis')

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
  for (let j = 0; j < height; j++) {
    const row = jReversed ? nj - 1 - bottom + j : top + j
    for (let i = 0; i < width; i++) {
      const col = (iReversed ? right - i : left + i) % columns
      const index = row * ni + (iReversed ? ni - 1 - col : col)
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
  message.setDouble('longitudeOfFirstGridPointInDegrees', positiveLongitude(lon + (iReversed ? right : left) * dx))
  message.setDouble('longitudeOfLastGridPointInDegrees', positiveLongitude(lon + (iReversed ? left : right) * dx))
  message.setDouble('latitudeOfFirstGridPointInDegrees', lat - (jReversed ? bottom : top) * dy)
  message.setDouble('latitudeOfLastGridPointInDegrees', lat - (jReversed ? top : bottom) * dy)
  message.setLong('bitmapPresent', missingCount ? 1 : 0)
  message.setValues(output)
  if (message.getLong('numberOfPoints') !== count || message.getLong('numberOfMissing') !== missingCount)
    throw new Error('Output point count or bitmap does not match the requested crop')
  return [
    longitudeNear(message.getDouble(iReversed ? 'longitudeOfLastGridPointInDegrees' : 'longitudeOfFirstGridPointInDegrees'), west),
    message.getDouble(jReversed ? 'latitudeOfFirstGridPointInDegrees' : 'latitudeOfLastGridPointInDegrees'),
    longitudeNear(message.getDouble(iReversed ? 'longitudeOfFirstGridPointInDegrees' : 'longitudeOfLastGridPointInDegrees'), east),
    message.getDouble(jReversed ? 'latitudeOfLastGridPointInDegrees' : 'latitudeOfFirstGridPointInDegrees')
  ]
}

function referenceTime(message) {
  const date = String(message.getLong('dataDate')).padStart(8, '0')
  const clock = ['hour', 'minute', 'second'].map(key => String(message.getLong(key)).padStart(2, '0')).join(':')
  return Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${clock}Z`)
}

function validityTime(message, reference = referenceTime(message)) {
  // GRIB2 code table 4.4 uses 13 for seconds. endStep refers to the end
  // of the period for statistical messages such as accumulated rain.
  message.setLong('stepUnits', 13)
  const valid = reference + message.getLong('endStep') * 1000
  if (!Number.isFinite(new Date(valid).getTime())) throw new Error('Invalid GRIB forecast time')
  return valid
}

const isoTime = time => new Date(time).toISOString().replace('.000Z', 'Z')

function singleField(bytes) {
  // The WASM reader exposes the first field only.
  let fields = 0
  const end = bytes.length - terminator.length
  for (let section = 16; section < end;) {
    if (section + 5 > end) throw new Error('Invalid GRIB2 section header')
    const size = bytes.readUInt32BE(section)
    if (size < 5 || section + size > end) throw new Error('Invalid GRIB2 section length')
    if (bytes[section + 4] === 4 && ++fields > 1) return false
    section += size
  }
  return true
}

async function analyzeGrib({ paths }) {
  const encoder = await createEncoder()
  const runs = new Set()
  const times = new Set()
  let geometry
  let bounds
  let commonGrid = true
  let bboxCrop = true
  for (const { fd, offset, length } of messages(paths)) {
    const bytes = Buffer.allocUnsafe(length)
    readExactly(fd, bytes, offset)
    if (!singleField(bytes)) return { grid: { bboxCrop: false, selectionUnsupported: true } }
    encoder.read(bytes, message => {
      const reference = referenceTime(message)
      runs.add(reference)
      times.add(validityTime(message, reference))
      if (commonGrid) {
        try {
          const current = gridGeometry(message)
          const key = JSON.stringify(current)
          if (geometry === undefined) {
            geometry = key
            bounds = gridBounds(current)
            bboxCrop = supportsScanning(current.scanning)
          } else if (key !== geometry) {
            commonGrid = false
          }
        } catch {
          commonGrid = false
        }
      }
    })
  }
  if (!times.size) throw new Error('No forecast times in the GRIB2 dataset')
  const forecastTimes = [...times].sort((a, b) => a - b).map(isoTime)
  return {
    ...(runs.size === 1 ? { run: isoTime(runs.values().next().value) } : {}),
    forecastTimes,
    ...(commonGrid ? { bounds } : {}),
    grid: { bboxCrop: commonGrid && bboxCrop }
  }
}

async function processGrib({ selection, paths, output, maxBytes }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid GRIB export size limit')
  const fields = selection.fields ?? []
  const bbox = selection.bbox
  const from = selection.from === undefined ? undefined : Date.parse(selection.from)
  const to = selection.to === undefined ? undefined : Date.parse(selection.to)
  const selectTime = from !== undefined
  if (selectTime !== (to !== undefined) || (selectTime && !(Number.isFinite(from) && Number.isFinite(to) && from <= to)))
    throw new Error('Invalid GRIB forecast interval')
  const encoder = fields.length || bbox || selectTime ? await createEncoder() : undefined
  const observed = new Set()
  const times = new Set()
  const io = Buffer.allocUnsafe(64 * 1024)
  let messageCount = 0
  let total = 0
  let bounds

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
        if (!singleField(bytes)) throw new Error('GRIB2 selection does not support multi-field messages')
        encoder.read(bytes, message => {
          const field = fields.length ? message.getString('shortName') : undefined
          const matched = fields.filter(({ parameter, level }) =>
            (parameter === field || aliases.get(parameter) === field) &&
            (!level || (level.type === message.getString('typeOfLevel') &&
              level.value === message.getDouble('level'))))
          if (fields.length && !matched.length) return
          const time = fields.length || selectTime ? validityTime(message) : undefined
          if (selectTime && (time < from || time > to)) return
          if (bbox) {
            const extent = crop(message, bbox)
            if (bounds && bounds.some((value, i) => value !== extent[i]))
              throw new Error('Selected messages have different cropped extents')
            bounds = extent
            message.writeBytes(write)
          } else write(bytes)
          messageCount++
          for (const match of matched) observed.add(match)
          if (time !== undefined) times.add(time)
        })
      }
      if (!messageCount) throw new Error('No GRIB messages match the selection')
      if (fields.some(field => !observed.has(field)))
        throw new Error('Requested fields were not all found in the selected forecast steps')
    } finally { fs.closeSync(out) }
  } catch (error) {
    fs.rmSync(output, { force: true })
    throw error
  }
  return {
    messageCount,
    ...(bounds ? { bounds } : {}),
    ...(times.size ? {
      forecastTimes: [...times].sort((a, b) => a - b).map(isoTime)
    } : {}),
  }
}

async function main() {
  if (process.argv[2] === '--check') {
    await createEncoder()
    return
  }
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const result = await (process.argv[2] === '--analyze' ? analyzeGrib(request) : processGrib(request))
  process.stdout.write(JSON.stringify(result))
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(error.message + '\n')
    process.exitCode = 1
  })
}

module.exports = { processGrib, analyzeGrib }
