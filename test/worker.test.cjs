const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { processGrib } = require('../worker.cjs')

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
    selection: { fields: ['10u'], from: '2026-11-18T15:00:00Z', to: '2026-11-18T15:00:00Z' },
    paths: [fixture], output, maxBytes: original.length,
  })
  assert.deepEqual(result, { messageCount: 1, forecastTimes: ['2026-11-18T15:00:00Z'] })
  assert.deepEqual(fs.readFileSync(output), original.subarray(0, Number(original.readBigUInt64BE(8))))
})
