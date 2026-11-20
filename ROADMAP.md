# GRIB Processor roadmap

## Export a GRIB at a lower resolution

- [ ] Add an explicit API option for a coarser output grid alongside the existing area and forecast-time selectors. A boat can request a smaller GRIB that still covers a whole crossing, then request the native resolution near the coast.
- [ ] Publish the result as a derived dataset through the [Forecast Dataset Provider](https://github.com/macjl/signalk-forecast-dataset-provider), preserving the original and reporting the output resolution.
