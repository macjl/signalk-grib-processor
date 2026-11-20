const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { processGrib, analyzeGrib } = require('../worker.cjs')
const { createEncoder } = require('../eccodes.cjs')

const fixture = path.join(__dirname, 'fixtures', 'arome-grid.grib2')
const original = fs.readFileSync(fixture)

function outputPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-grib-export-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'export.grib2')
}

test('assembling assets streams the original messages unchanged', async t => {
  const output = outputPath(t)
  const result = await processGrib({
    selection: {}, paths: [fixture, fixture], output, maxBytes: 2 * original.length,
  })
  assert.deepEqual(result, { messageCount: 8 })
  assert.deepEqual(fs.readFileSync(output), Buffer.concat([original, original]))
})

test('malformed input and output limits leave no partial export', async t => {
  const output = outputPath(t)
  const broken = path.join(path.dirname(output), 'truncated.grib2')
  fs.writeFileSync(broken, original.subarray(0, -1))
  await assert.rejects(processGrib({
    selection: {}, paths: [fixture, broken], output, maxBytes: 2 * original.length,
  }), /Expected contiguous GRIB2 messages/)
  assert.equal(fs.existsSync(output), false)
  await assert.rejects(processGrib({
    selection: {}, paths: [fixture, fixture], output, maxBytes: original.length,
  }), /exceeds its output size limit/)
  assert.equal(fs.existsSync(output), false)
})

test('time and field selection keeps the selected GRIB message bytes', async t => {
  const output = outputPath(t)
  const result = await processGrib({
    selection: { fields: [{ parameter: '10u' }], from: '2026-11-18T15:00:00Z', to: '2026-11-18T15:00:00Z' },
    paths: [fixture], output, maxBytes: original.length,
  })
  assert.deepEqual(result, { messageCount: 1, forecastTimes: ['2026-11-18T15:00:00Z'] })
  assert.deepEqual(fs.readFileSync(output), original.subarray(0, Number(original.readBigUInt64BE(8))))
})

test('a time range keeps actual irregular and sub-hourly steps, without requiring fields', async t => {
  const output = outputPath(t)
  const input = path.join(path.dirname(output), 'irregular.grib2')
  const first = original.subarray(0, Number(original.readBigUInt64BE(8)))
  const encoder = await createEncoder()
  const steps = [0, 1800, 10805].map(seconds => encoder.read(first, message => {
    message.setLong('second', 15)
    message.setLong('stepUnits', 13)
    message.setLong('endStep', seconds)
    let encoded
    message.writeBytes(bytes => { encoded = Buffer.from(bytes) })
    return encoded
  }))
  fs.writeFileSync(input, Buffer.concat(steps))
  assert.deepEqual(await analyzeGrib({ paths: [input, input] }), {
    run: '2026-11-18T15:00:15Z',
    forecastTimes: ['2026-11-18T15:00:15Z', '2026-11-18T15:30:15Z', '2026-11-18T18:00:20Z'],
    bounds: [-6, 45, -5.9, 45.1],
    grid: { bboxCrop: true }
  })
  const result = await processGrib({
    selection: { from: '2026-11-18T15:00:16Z', to: '2026-11-18T18:00:20Z' },
    paths: [input], output, maxBytes: original.length,
  })
  assert.deepEqual(result, {
    messageCount: 2, forecastTimes: ['2026-11-18T15:30:15Z', '2026-11-18T18:00:20Z'],
  })
  assert.deepEqual(fs.readFileSync(output), Buffer.concat(steps.slice(1)))
  fs.unlinkSync(output)
  await assert.rejects(processGrib({
    selection: { from: '2026-11-18T15:30:16Z', to: '2026-11-18T18:00:19Z' },
    paths: [input], output, maxBytes: original.length,
  }), /No GRIB messages match/)
  assert.equal(fs.existsSync(output), false)
})

test('a global grid scanned from the south can be cropped across Greenwich', async t => {
  const output = outputPath(t)
  const input = path.join(path.dirname(output), 'global.grib2')
  const encoder = await createEncoder()
  encoder.read(original.subarray(0, Number(original.readBigUInt64BE(8))), message => {
    message.setLong('Ni', 1440)
    message.setLong('scanningMode', 64)
    message.setLong('bitmapPresent', 0)
    message.setDouble('longitudeOfFirstGridPointInDegrees', 0)
    message.setDouble('longitudeOfLastGridPointInDegrees', 359.75)
    message.setDouble('latitudeOfFirstGridPointInDegrees', 44)
    message.setDouble('latitudeOfLastGridPointInDegrees', 45)
    message.setDouble('iDirectionIncrementInDegrees', 0.25)
    message.setDouble('jDirectionIncrementInDegrees', 0.25)
    message.setValues(Float64Array.from({ length: 1440 * 5 }, (_, i) => i))
    message.writeBytes(bytes => fs.writeFileSync(input, bytes))
  })
  const result = await processGrib({
    selection: { bbox: [-0.25, 44.25, 0.25, 44.75] },
    paths: [input], output, maxBytes: 1024,
  })
  assert.deepEqual((await analyzeGrib({ paths: [input] })).bounds, [-180, 44, 180, 45])
  assert.deepEqual(result, { messageCount: 1, bounds: [-0.25, 44.25, 0.25, 44.75] })
  encoder.read(fs.readFileSync(output), message => {
    assert.equal(message.getLong('Ni'), 3)
    assert.equal(message.getLong('Nj'), 3)
    assert.equal(message.getLong('scanningMode'), 64)
    assert.deepEqual(Array.from(message.values()), [2879, 1440, 1441, 4319, 2880, 2881, 5759, 4320, 4321])
  })
})

test('multi-field messages are preserved by assembly and rejected by all selectors', async t => {
  const output = outputPath(t)
  const input = path.join(path.dirname(output), 'multi-field.grib2')
  const first = original.subarray(0, Number(original.readBigUInt64BE(8)))
  const encoder = await createEncoder()
  const later = encoder.read(first, message => {
    message.setLong('stepUnits', 13)
    message.setLong('endStep', 3600)
    let encoded
    message.writeBytes(bytes => { encoded = Buffer.from(bytes) })
    return encoded
  })
  let section = 16
  while (later[section + 4] !== 4) section += later.readUInt32BE(section)
  const multi = Buffer.concat([first.subarray(0, -4), later.subarray(section)])
  multi.writeBigUInt64BE(BigInt(multi.length), 8)
  fs.writeFileSync(input, multi)
  assert.deepEqual(await analyzeGrib({ paths: [input] }), {
    grid: { bboxCrop: false, selectionUnsupported: true }
  })
  const request = { paths: [input], output, maxBytes: multi.length }
  await assert.rejects(processGrib({ ...request,
    selection: { from: '2026-11-18T15:00:00Z', to: '2026-11-18T15:00:00Z' }
  }), /multi-field/)
  assert.equal(fs.existsSync(output), false)
  await processGrib({ ...request, selection: {} })
  assert.deepEqual(fs.readFileSync(output), multi)
})

test('a rotated grid still has a forecast timeline and cannot be cropped by area', async t => {
  const input = outputPath(t)
  const first = original.subarray(0, Number(original.readBigUInt64BE(8)))
  const encoder = await createEncoder()
  encoder.read(first, message => {
    message.setLong('gridDefinitionTemplateNumber', 1)
    assert.equal(message.getString('gridType'), 'rotated_ll')
    message.writeBytes(bytes => fs.writeFileSync(input, bytes))
  })
  assert.deepEqual(await analyzeGrib({ paths: [input] }), {
    run: '2026-11-18T15:00:00Z',
    forecastTimes: ['2026-11-18T15:00:00Z'],
    grid: { bboxCrop: false }
  })
})
