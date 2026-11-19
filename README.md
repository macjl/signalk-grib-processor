# GRIB Processor for Signal K

GRIB Processor provides single-file exports to the companion Forecast Dataset
Provider. It assembles GRIB2 messages without repacking and crops regular
latitude-longitude grids on their original grid. It ships ecCodes/WASM and runs
each export in a separate Node.js process on the catalogue server.

## Install the beta

Use Signal K 2.35.1 with Node.js 24+ and Forecast Dataset Provider
0.3.0-beta.2. Install both packages from the Signal K configuration
directory as the user running Signal K:

```sh
npm install signalk-forecast-dataset-provider@0.3.0-beta.2 signalk-grib-processor@0.1.0-beta.3
```

Restart Signal K, then enable GRIB Processor in Plugin Config. The npm package
supplies the entire processing runtime, including the WASM binary.

## Use the API

Find the export operation in a dataset's `capabilities.operations`. POST
to its `href` with a Signal K write identity. An empty request assembles all
assets into one GRIB2. If the job is running, poll its `href` using the indicated
delay. A completed job returns a catalogue dataset. Download it through
`result.assets[0].href`.

When the operation lists the `bbox` selector, send a bounding box in
`[west, south, east, north]` order. Cropping supports regular latitude-longitude
grids scanned by rows, at any resolution. The requested box must be covered by
the source and contain at least two points per axis. If the catalogue has no
grid metadata, the worker checks the actual GRIB2 grid when it runs the export.
A grid that fails this check can still be exported without `bbox`.

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
[export API and curl examples](https://github.com/macjl/signalk-forecast-dataset-provider/blob/v0.3.0-beta.2/docs/grib-export-alpha.md).

This beta runs one export at a time. Its source limit is 1 GiB, and the
output limit advertised on each operation also respects the provider settings.

The [build sources for the bundled module](vendor/README.md) are documented for
maintainers.
