# GRIB Processor for Signal K

GRIB Processor provides single-file exports to the companion Forecast Dataset
Provider. The alpha assembles GRIB2 messages without repacking and clips
AROME 0.025° SP1 fields (10 m wind and mean sea-level pressure) on the original
grid. It runs ecCodes in a bounded Python subprocess on the catalogue server.

## Local installation

Use Signal K 2.35.1 with Node 22+ and Forecast Dataset Provider
0.3.0-alpha.3. Install the packed plugin through Signal K, then create a
Python 3.11+ virtual environment in the processor's plugin data directory.

```sh
processor_dir=~/.signalk/plugin-config-data/signalk-grib-processor
mkdir -p "$processor_dir"
python3 -m venv "$processor_dir/venv"
"$processor_dir/venv/bin/pip" install eccodes==2.50.1 numpy==2.5.5
```

Enable GRIB Processor in Plugin Config. The optional **Python executable**
setting points to an alternative environment. This alpha runs on Linux with
ecCodes and NumPy wheels available for the target architecture.

## Use the API

Find the export operation in a dataset's `capabilities.operations`. POST
to its `href` with a Signal K write identity. An empty request assembles all
assets into one GRIB2. If the job is running, poll its `href` using the indicated
delay. A completed job returns a catalogue dataset. Download it through
`result.assets[0].href`.

The provider publishes the result automatically. It expires 20 minutes after
commit by default. Send `"expiresInSeconds": null` to keep it without expiry,
or send a positive duration for a custom lifetime. See `docs/grib-export-alpha.md`
in Forecast Dataset Provider for selectors and job details.

This alpha runs one export at a time. Its source limit is 1 GiB, and the
output limit advertised on each operation also respects the provider settings.
