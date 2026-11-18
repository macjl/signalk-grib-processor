const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const create = require('../index.cjs')

test('processor with a broken runtime does not register capabilities', async () => {
  const errors = []
  const plugin = create({
    getDataDirPath: () => '/test/processor',
    setPluginStatus() {},
    setPluginError: error => errors.push(error)
  })
  await plugin.start({ python: process.execPath })
  assert.equal(errors.length, 1, 'a missing Python runtime prevents registration')
  await plugin.stop()
  assert.equal(globalThis[Symbol.for('macjl.forecast-datasets.processors.v1')].get(path.resolve('/test')), undefined)
})
