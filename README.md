# GRIB Processor for Signal K

GRIB Processor provides single-file exports to the companion Forecast Dataset
Provider. The alpha assembles GRIB2 messages without repacking and clips
AROME 0.025° SP1 fields (10 m wind and mean sea-level pressure) on the original
grid. It runs ecCodes in a bounded Python subprocess on the catalogue server.

## Local installation

Use Signal K 2.35.1 with Node 22+ and Forecast Dataset Provider
0.3.0-alpha.1. Install the packed plugin through Signal K, then create a
Python 3.11+ virtual environment in the processor's plugin data directory.

```sh
processor_dir=~/.signalk/plugin-config-data/signalk-grib-processor
mkdir -p "$processor_dir"
python3 -m venv "$processor_dir/venv"
"$processor_dir/venv/bin/pip" install eccodes==2.50.1 numpy==2.5.5
```

Enable GRIB Processor in Plugin Config. The optional **Python executable**
setting points to an alternative environment. This alpha runs on Linux with
ecCodes and NumPy wheels available for the target architecture. Refresh the
Signal K webapps list and open **GRIB Processor**. Sign in with a write access
role to start an export.

Select an AROME dataset, enter west, south, east and north and choose a period
within the dataset. The preset requests the first 12 hours of the selected run.
For an unfiltered GRIB2 export select **Assemble into one GRIB2**. Download the
result once ready. Result links are authenticated and valid for 20 minutes.

Clients can use the provider's `/datasets/{id}/versions/{version}/requests`
and the returned job/result links. The provider owns result delivery and
expiry. This alpha runs one export at a time, holds up to four results or
failed jobs and limits sources and individual output to 1 GiB.
