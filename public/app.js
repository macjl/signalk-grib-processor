const prefix = /^(.*)\/signalk-grib-processor(?:\/|$)/.exec(location.pathname)?.[1] ?? ''
const api = '/plugins/signalk-forecast-dataset-provider'
const form = document.querySelector('#export')
const find = id => document.getElementById(id)
const { dataset, mode, selection, submit, status, result, from, to } =
  Object.fromEntries(['dataset', 'mode', 'selection', 'submit', 'status', 'result', 'from', 'to'].map(id => [id, find(id)]))

let entries = []
let busy = false
const toUtcField = date => date.toISOString().slice(0, 16)

async function request(route, options) {
  const response = await fetch(prefix + route, {
    credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(10_000), ...options
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.message ?? (response.status === 401 || response.status === 403
      ? 'Sign in to Signal K with an account that can start exports.'
      : `HTTP ${response.status}`))
  }
  return response.json()
}

function updateMode() {
  const entry = entries[Number(dataset.value)]
  mode.options[1].disabled = !entry?.capability.selectors.includes('bbox')
  if (mode.options[1].disabled) mode.value = 'assemble'
  selection.hidden = selection.disabled = mode.value !== 'crop'
  submit.disabled = busy || !entry
}

function updateDataset() {
  const entry = entries[Number(dataset.value)]
  from.value = to.value = ''
  if (entry?.run) {
    const date = new Date(entry.run)
    if (Number.isFinite(date.getTime())) {
      from.value = toUtcField(date)
      to.value = toUtcField(new Date(date.getTime() + 12 * 3600_000))
    }
  }
  updateMode()
}
mode.addEventListener('change', updateMode)
dataset.addEventListener('change', updateDataset)

form.addEventListener('submit', async event => {
  event.preventDefault()
  if (busy) return
  const entry = entries[Number(dataset.value)]
  if (!entry) return
  busy = true
  submit.disabled = true
  result.hidden = true
  status.textContent = 'Preparing GRIB2…'
  try {
    const body = { operation: 'export', output: entry.capability.output }
    if (mode.value === 'crop') {
      const bbox = ['west', 'south', 'east', 'north'].map(id => find(id).valueAsNumber)
      if (!bbox.every(Number.isFinite) || !from.value || !to.value) throw new Error('Enter all coordinates and both forecast times.')
      const choices = new FormData(form).getAll('fields')
      const fields = []
      if (choices.includes('wind')) {
        const level = { type: 'heightAboveGround', value: 10, unit: 'm' }
        fields.push({ parameter: 'eastward_wind', level }, { parameter: 'northward_wind', level })
      }
      if (choices.includes('pressure')) fields.push({ parameter: 'air_pressure_at_mean_sea_level' })
      if (!fields.length) throw new Error('Select wind or pressure.')
      body.selection = { bbox, fields, from: from.value + ':00Z', to: to.value + ':00Z' }
    }
    let job = await request(`${api}/datasets/${entry.id}/versions/${entry.version}/requests`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    while (job.state === 'running') {
      await new Promise(resolve => setTimeout(resolve, 750))
      job = await request(job.href)
    }
    if (job.state !== 'complete') throw new Error(job.error ?? 'GRIB generation failed')
    const { size, actual, expires, href } = job.result
    status.textContent = `${actual.messageCount} messages · ${new Intl.NumberFormat().format(size)} bytes · expires ${new Date(expires).toLocaleTimeString()}`
    result.href = prefix + href
    result.hidden = false
  } catch (error) {
    status.textContent = error.message
  } finally {
    busy = false
    updateMode()
  }
})

try {
  for (let offset = 0; ; offset += 100) {
    const page = Object.values(await request(`${api}/datasets?format=grib2&limit=100&offset=${offset}`))
    for (const entry of page) {
      const capability = entry.capabilities?.operations?.find(item => item.operation === 'export')
      if (capability) entries.push({ ...entry, capability })
    }
    if (page.length < 100) break
  }
  for (const [index, entry] of entries.entries()) {
    const option = new Option(`${entry.name || entry.model || entry.id} · ${entry.run || entry.createdAt} · ${entry.assetCount} assets`, String(index))
    dataset.add(option)
  }
  const firstCrop = entries.findIndex(entry => entry.capability.selectors.includes('bbox'))
  if (firstCrop >= 0) {
    dataset.value = String(firstCrop)
    mode.value = 'crop'
  }
  updateDataset()
  if (!entries.length) status.textContent = 'No exportable GRIB2 dataset. Check that Forecast Dataset Provider and GRIB Processor are running.'
} catch (error) {
  status.textContent = error.message
}
