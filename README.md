# GRIB Processor for Signal K

GRIB Processor provides single-file exports to the companion Forecast Dataset
Provider. The beta assembles GRIB2 messages without repacking and clips
AROME 0.025° SP1 fields (10 m wind and mean sea-level pressure) on the original
grid. It ships ecCodes/WASM and runs each export in a separate Node.js process
on the catalogue server.

## Install the beta

Use Signal K 2.35.1 with Node.js 24+ and Forecast Dataset Provider
0.3.0-beta.1. Install both packages from the Signal K configuration
directory as the user running Signal K:

```sh
npm install signalk-forecast-dataset-provider@0.3.0-beta.1 signalk-grib-processor@0.1.0-beta.2
```

Restart Signal K, then enable GRIB Processor in Plugin Config. The npm package
supplies the entire processing runtime, including the WASM binary.

## Use the API

Find the export operation in a dataset's `capabilities.operations`. POST
to its `href` with a Signal K write identity. An empty request assembles all
assets into one GRIB2. If the job is running, poll its `href` using the indicated
delay. A completed job returns a catalogue dataset. Download it through
`result.assets[0].href`.

The provider publishes the result automatically. It expires 20 minutes after
commit by default. Send `"expiresInSeconds": null` to keep it without expiry,
or send a positive duration for a custom lifetime. See `docs/grib-export-alpha.md`
in [Forecast Dataset Provider](https://github.com/macjl/signalk-forecast-dataset-provider/blob/v0.3.0-beta.1/docs/grib-export-alpha.md) for selectors and job details.

This beta runs one export at a time. Its source limit is 1 GiB, and the
output limit advertised on each operation also respects the provider settings.

The [build sources for the bundled module](vendor/README.md) are documented for
maintainers.
