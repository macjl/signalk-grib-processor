# GRIB Processor for Signal K

GRIB Processor provides single-file exports to the companion Forecast Dataset
Provider. It assembles GRIB2 messages without repacking and crops regular
latitude-longitude grids on their original grid. It ships ecCodes/WASM and runs
each export in a separate Node.js process on the catalogue server.

A compatible Forecast Dataset Provider also delegates background GRIB2
inventory analysis to this plugin. The worker reads the reference and validity
times and regular-grid geometry from the message headers without unpacking
values or rewriting source assets. A file can contain multiple GRIB2 messages.
Messages that carry several fields can be assembled unchanged. They are not
eligible for selection with the current worker.

## Install

Use Signal K 2.35.1 with Node.js 24+ and Forecast Dataset Provider 0.3.0
or later. Install GRIB Processor from the Signal K App Store, or install both
packages from the Signal K configuration directory as the user running Signal K:

```sh
npm install signalk-forecast-dataset-provider@latest signalk-grib-processor@latest
```

Restart Signal K. On a fresh installation, GRIB Processor starts automatically.
If you previously disabled it, enable it in Plugin Config when you want to use
it again. The npm package includes the processing runtime and WASM binary.

## Use the API

Find the export operation in a dataset's `capabilities.operations`. POST
to its `href` with a Signal K write identity. An empty request assembles all
assets into one GRIB2. If the job is running, poll its `href` using the indicated
delay. A completed job returns a catalogue dataset. Download it through
`result.assets[0].href`.

When the operation lists the `bbox` selector, send a bounding box in
`[west, south, east, north]` order. Cropping supports regular latitude-longitude
grids scanned by rows, at any resolution. The requested box must be covered by
the source and contain at least two points per axis. With a catalogue that
supports verified grid capabilities, `bbox` appears after automatic analysis
has confirmed that the messages share a compatible grid. The worker also
validates the grid when it runs the export.

When the operation lists `from` and `to`, supply both as UTC timestamps.
The worker keeps messages whose actual forecast validity is in that inclusive
range, at any cadence. For an accumulated quantity, it uses the end of the
accumulation period. The job reports the retained forecast times. A request
with no matching message fails. Time filtering can be combined with `bbox`
and `fields`.

Use an advertised parameter and level when the operation lists fields. If it
advertises the `fields` selector without a list, pass an ecCodes short name
and optionally its GRIB level. The generic time range and unlisted field
selectors require a catalogue that supports those selectors.

The provider publishes the result automatically. It expires 20 minutes after
commit by default. Send `"expiresInSeconds": null` to keep it without expiry,
or send a positive duration for a custom lifetime. See the catalogue
[export API and curl examples](https://github.com/macjl/signalk-forecast-dataset-provider/blob/v0.3.0/docs/grib-export-alpha.md).

The catalogue controls concurrency. The source limit per export is 1 GiB, and
the advertised output limit also respects the provider settings.

The [build sources for the bundled module](vendor/README.md) are documented for
maintainers.
