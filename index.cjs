// SPDX-License-Identifier: Apache-2.0
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const exec = promisify(execFile)
const id = 'signalk-grib-processor'
const version = require('./package.json').version
const registryKey = Symbol.for('macjl.forecast-datasets.processors.v1')
const worker = path.join(__dirname, 'worker.py')
const aromeFields = new Map([
  ['eastward_wind', '10u'],
  ['northward_wind', '10v'],
  ['air_pressure_at_mean_sea_level', 'prmsl']
])
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
    schema: {
      type: 'object',
      properties: {
        python: {
          type: 'string',
          title: 'Python executable with ecCodes and NumPy',
          default: ''
        }
      }
    },
    start(options = {}) {
      const dataDir = app.getDataDirPath()
      scope = path.dirname(dataDir)
      const python = options.python || path.join(dataDir, 'venv', 'bin', 'python')
      const controller = lifetime = new AbortController()
      starting = exec(python, ['-c', 'import eccodes, numpy'], {
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
              selectors: isArome(record) ? ['bbox', 'fields', 'from', 'to'] : []
            }]
          },
          async run({ selection, paths, output, maxBytes, signal }) {
            const args = [worker, '--output', output, '--max-bytes', String(maxBytes)]
            if (selection.bbox) args.push('--bbox', ...selection.bbox.map(String))
            for (const field of selection.fields ?? []) args.push('--field', aromeFields.get(field.parameter))
            if (selection.from) args.push('--from', selection.from, '--to', selection.to)
            const { stdout } = await exec(python, [...args, '--', ...paths], {
              signal: AbortSignal.any([signal, controller.signal]),
              timeout: 120000,
              killSignal: 'SIGKILL',
              maxBuffer: 256 * 1024
            })
            return JSON.parse(stdout)
          }
        }
        registry.set(scope, registered)
        app.setPluginStatus('Ready for GRIB2 exports and AROME 0.025° selections')
      }).catch(() => {
        if (!controller.signal.aborted)
          app.setPluginError('Configure Python with ecCodes and NumPy')
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
