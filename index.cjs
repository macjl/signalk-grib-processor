// SPDX-License-Identifier: Apache-2.0
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const exec = promisify(execFile)
const id = 'signalk-grib-processor'
const version = require('./package.json').version
const registryKey = Symbol.for('macjl.forecast-datasets.processors.v1')
const worker = path.join(__dirname, 'worker.cjs')
function capabilities(record, { timeRanges, unlistedFields } = {}) {
  if (record.format !== 'grib2') return []
  const grid = record.inventory?.metadata.grid ?? record.metadata?.grid
  const gridType = grid?.gridType
  const scanningMode = grid?.scanningMode
  const spatial = (gridType === undefined || gridType === 'regular_ll') &&
    (scanningMode === undefined || [0, 64, 128, 192].includes(scanningMode))
  const fields = record.inventory?.metadata.fields ?? record.metadata?.fields ?? []
  return [{
    operation: 'export',
    output: { format: 'grib2', layout: 'single-file' },
    selectors: [
      ...(spatial ? ['bbox'] : []),
      ...(fields.length || unlistedFields ? ['fields'] : []),
      ...(timeRanges ? ['from', 'to'] : [])
    ],
    ...(fields.length ? { fields } : {})
  }]
}

module.exports = app => {
  const registry = globalThis[registryKey] ??= new Map()
  let registered
  let starting
  let lifetime
  let scope
  async function invokeWorker(args, { signal, ...request }, pluginSignal) {
    const run = exec(process.execPath, [worker, ...args], {
      signal: AbortSignal.any([signal, pluginSignal]),
      timeout: 120000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024
    })
    const closed = new Promise(resolve => run.child.once('close', resolve))
    run.child.stdin.on('error', () => {}) // The child may exit before reading its request.
    run.child.stdin.end(JSON.stringify(request))
    try {
      return JSON.parse((await run).stdout)
    } finally {
      await closed
    }
  }
  const plugin = {
    id,
    name: 'GRIB Processor',
    description: 'Export GRIB2 selections by area, field and forecast time on the catalogue server',
    schema: { type: 'object', properties: {} },
    start() {
      const dataDir = app.getDataDirPath()
      scope = path.dirname(dataDir)
      const controller = lifetime = new AbortController()
      starting = exec(process.execPath, [worker, '--check'], {
        signal: controller.signal,
        timeout: 15000
      }).then(() => {
        if (controller.signal.aborted) return
        registered = {
          id,
          version,
          capabilities,
          run: input => invokeWorker([], input, controller.signal),
          analyze: input => invokeWorker(['--analyze'], input, controller.signal)
        }
        registry.set(scope, registered)
        app.setPluginStatus('Ready for GRIB2 processing')
      }).catch(error => {
        if (!controller.signal.aborted) {
          app.debug?.(error.stderr?.trim() || error.message)
          app.setPluginError('Unable to load ecCodes/WASM. Check that Signal K runs on Node.js 24 or later.')
        }
      })
      return starting
    },
    async stop() {
      lifetime?.abort()
      if (registry.get(scope) === registered) registry.delete(scope)
      await starting
      app.setPluginStatus('Stopped')
    }
  }
  return plugin
}
