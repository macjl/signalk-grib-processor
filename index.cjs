// SPDX-License-Identifier: Apache-2.0
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const exec = promisify(execFile)
const id = 'signalk-grib-processor'
const version = require('./package.json').version
const registryKey = Symbol.for('macjl.forecast-datasets.processors.v1')
const worker = path.join(__dirname, 'worker.cjs')
const windLevel = { type: 'heightAboveGround', value: 10, unit: 'm' }
const aromeFields = [
  { parameter: 'eastward_wind', level: windLevel, shortName: '10u' },
  { parameter: 'northward_wind', level: windLevel, shortName: '10v' },
  { parameter: 'air_pressure_at_mean_sea_level', shortName: 'prmsl' }
]
const isArome = record =>
  record.metadata?.model === 'AROME' &&
  record.assets.every(asset => asset.id.startsWith('arome-0025__'))

module.exports = app => {
  const registry = globalThis[registryKey] ??= new Map()
  let registered
  let starting
  let lifetime
  let scope
  const plugin = {
    id,
    name: 'GRIB Processor',
    description: 'Export GRIB2 files and crop AROME on the catalogue server',
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
          capabilities(record) {
            if (record.format !== 'grib2') return []
            return [{
              operation: 'export',
              output: { format: 'grib2', layout: 'single-file' },
              ...(isArome(record) ? {
                selectors: ['bbox', 'fields', 'from', 'to'],
                fields: aromeFields.map(({ shortName, ...field }) => field),
                forecastInterval: { stepSeconds: 3600, maxHours: 51 }
              } : { selectors: [] })
            }]
          },
          async run({ selection, paths, output, maxBytes, signal }) {
            const fields = (selection.fields ?? []).map(field => {
              const supported = aromeFields.find(available => available.parameter === field.parameter)
              if (!supported) throw new Error('Unsupported field')
              return supported.shortName
            })
            const run = exec(process.execPath, [worker], {
              signal: AbortSignal.any([signal, controller.signal]),
              timeout: 120000,
              killSignal: 'SIGKILL',
              maxBuffer: 256 * 1024
            })
            const closed = new Promise(resolve => run.child.once('close', resolve))
            run.child.stdin.on('error', () => {}) // The child may exit before reading its request.
            run.child.stdin.end(JSON.stringify({ selection: { ...selection, fields }, paths, output, maxBytes }))
            try {
              return JSON.parse((await run).stdout)
            } finally {
              await closed
            }
          }
        }
        registry.set(scope, registered)
        app.setPluginStatus('Ready for GRIB2 exports and AROME 0.025° selections')
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
