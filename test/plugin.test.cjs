const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const create = require('../index.cjs')
const { createEncoder } = require('../eccodes.cjs')

test('the WASM worker advertises model-independent area, time and field selections', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-grib-worker-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const errors = []
  const statuses = []
  const plugin = create({
    getDataDirPath: () => path.join(directory, 'processor'),
    setPluginStatus: status => statuses.push(status),
    setPluginError: error => errors.push(error)
  })
  t.after(() => plugin.stop())
  const registry = globalThis[Symbol.for('macjl.forecast-datasets.processors.v1')]
  await plugin.start()
  assert.deepEqual(errors, [])
  assert.deepEqual(statuses, ['Ready for GRIB2 processing'])
  assert.deepEqual(plugin.schema.properties, {})
  const processor = registry.get(directory)
  const compatibleProvider = { timeRanges: true, unlistedFields: true }
  const record = { format: 'grib2', metadata: { model: 'Arbitrary model' }, assets: [{ id: 'import' }] }
  assert.deepEqual(processor.capabilities(record)[0].selectors, ['bbox'])
  assert.deepEqual(processor.capabilities({
    format: 'grib2',
    metadata: { model: 'arbitrary', grid: { gridType: 'reduced_gg' }, fields: [{ parameter: 't' }] },
    assets: []
  }, compatibleProvider)[0].selectors, ['fields', 'from', 'to'])
  assert.deepEqual(processor.capabilities(record, compatibleProvider)[0], {
    operation: 'export',
    output: { format: 'grib2', layout: 'single-file' },
    selectors: ['bbox', 'fields', 'from', 'to'],
  })
  const output = path.join(directory, 'selection.grib2')
  const fixture = path.join(__dirname, 'fixtures', 'arome-grid.grib2')
  assert.deepEqual(await processor.analyze({ paths: [fixture], signal: new AbortController().signal }), {
    run: '2026-11-18T15:00:00Z',
    forecastTimes: ['2026-11-18T15:00:00Z', '2026-11-18T16:00:00Z']
  })
  const result = await processor.run({
    selection: {
      bbox: [-5.975, 45.025, -5.925, 45.075],
      fields: [{ parameter: 'eastward_wind', level: { type: 'heightAboveGround', value: 10, unit: 'm' } }],
      from: '2026-11-18T15:00:00Z', to: '2026-11-18T15:00:00Z',
    },
    paths: [fixture],
    output,
    maxBytes: 1024,
    signal: new AbortController().signal,
  })
  assert.equal(result.messageCount, 1)
  assert.deepEqual(result.forecastTimes, ['2026-11-18T15:00:00Z'])
  assert.deepEqual(result.bounds.map(value => +value.toFixed(6)), [-5.975, 45.025, -5.925, 45.075])
  const encoder = await createEncoder()
  encoder.read(fs.readFileSync(output), message => {
    assert.equal(message.getLong('Ni'), 3)
    assert.equal(message.getLong('Nj'), 3)
    assert.equal(message.getString('packingType'), 'grid_ccsds')
    assert.equal(message.getString('shortName'), '10u')
    const bitmap = Array.from(message.bitmap(9))
    assert.deepEqual(bitmap, [1, 1, 1, 1, 0, 1, 1, 1, 1])
    assert.deepEqual(Array.from(message.values()).filter((_, i) => bitmap[i]), [6, 7, 8, 11, 13, 16, 17, 18])
  })

  await plugin.stop()
  assert.equal(registry.get(directory), undefined)
})
