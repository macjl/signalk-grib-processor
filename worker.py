#!/usr/bin/env python3
"""Local proof of concept for assembling and cropping AROME 0.025° GRIB2."""

import argparse
import json
import math
import resource
import tempfile
from pathlib import Path
from datetime import datetime, timedelta, timezone

import eccodes as grib
import numpy as np


def crop(handle, bbox):
    def get(key):
        return grib.codes_get(handle, key)

    if get('gridType') != 'regular_ll' or get('scanningMode') != 0:
        raise ValueError(
            'Expected a regular latitude/longitude grid scanned west to east, north to south'
        )

    ni, nj = get('Ni'), get('Nj')
    dx, dy = get('iDirectionIncrementInDegrees'), get('jDirectionIncrementInDegrees')
    if not (math.isclose(dx, 0.025) and math.isclose(dy, 0.025)):
        raise ValueError('Expected the AROME 0.025-degree grid')

    lon = (get('longitudeOfFirstGridPointInDegrees') + 180) % 360 - 180
    lat = get('latitudeOfFirstGridPointInDegrees')
    xs, ys = lon + np.arange(ni) * dx, lat - np.arange(nj) * dy
    west, south, east, north = bbox
    eps = 1e-8
    if not (
        xs[0] - eps <= west < east <= xs[-1] + eps
        and ys[-1] - eps <= south < north <= ys[0] + eps
    ):
        raise ValueError('Requested bounding box must be fully covered by the source grid')

    cols = np.flatnonzero((xs >= west - eps) & (xs <= east + eps))
    rows = np.flatnonzero((ys >= south - eps) & (ys <= north + eps))
    if len(cols) < 2 or len(rows) < 2 or len(cols) * len(rows) == ni * nj:
        raise ValueError('Requested bounding box must produce a smaller grid with at least two points per axis')

    window = np.s_[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
    subset = grib.codes_get_values(handle).reshape(nj, ni)[window].copy()
    if get('bitmapPresent'):
        valid = grib.codes_get_array(handle, 'bitmap').reshape(nj, ni)[window].astype(bool)
        if not valid.any():
            raise ValueError('Crop contains only missing values')
    elif get('numberOfMissing'):
        raise ValueError('Missing values without a bitmap are outside this prototype')
    else:
        valid = np.ones(subset.shape, dtype=bool)

    # ecCodes uses a sentinel to rebuild the bitmap while packing the values.
    # Choose one outside the range of valid values even if the original collides.
    missing = float(np.nextafter(subset[valid].max(), np.inf))
    subset[~valid] = missing
    for key, value in {
        'Ni': len(cols),
        'Nj': len(rows),
        'longitudeOfFirstGridPointInDegrees': float(xs[cols[0]] % 360),
        'longitudeOfLastGridPointInDegrees': float(xs[cols[-1]] % 360),
        'latitudeOfFirstGridPointInDegrees': float(ys[rows[0]]),
        'latitudeOfLastGridPointInDegrees': float(ys[rows[-1]]),
        'missingValue': missing,
        'bitmapPresent': int(not valid.all()),
    }.items():
        grib.codes_set(handle, key, value)
    grib.codes_set_values(handle, np.ravel(subset))
    if (
        get('numberOfPoints') != subset.size
        or get('numberOfMissing') != subset.size - valid.sum()
    ):
        raise ValueError('Output point count or bitmap does not match the requested crop')


def process(args, output):
    count = 0
    actual_bounds = None
    selecting = args.field or args.bbox or args.start or args.end
    observed = {}
    run = None
    found = set()
    for source in args.inputs:
        with source.open('rb') as stream:
            end = 0
            while (handle := grib.codes_grib_new_from_file(stream)) is not None:
                try:
                    if (
                        grib.codes_get(handle, 'edition') != 2
                        or grib.codes_get_message_offset(handle) != end
                    ):
                        raise ValueError(f'Expected contiguous GRIB2 messages in {source.name}')
                    end += grib.codes_get_message_size(handle)
                    if not selecting:
                        grib.codes_write(handle, output)
                        count += 1
                        continue
                    cycle = tuple(grib.codes_get(handle, key) for key in ('dataDate', 'dataTime'))
                    if run is None:
                        run = cycle
                    if cycle != run:
                        raise ValueError('All inputs must come from the same model run')
                    field = grib.codes_get(handle, 'shortName')
                    if args.field and field not in args.field:
                        continue
                    valid_time = datetime.strptime(
                        f"{grib.codes_get(handle, 'validityDate'):08d}{grib.codes_get(handle, 'validityTime'):04d}",
                        '%Y%m%d%H%M',
                    ).replace(tzinfo=timezone.utc)
                    if (args.start and valid_time < args.start) or (args.end and valid_time > args.end):
                        continue
                    if args.bbox:
                        crop(handle, args.bbox)
                        bounds = [
                            (grib.codes_get(handle, 'longitudeOfFirstGridPointInDegrees') + 180) % 360 - 180,
                            grib.codes_get(handle, 'latitudeOfLastGridPointInDegrees'),
                            (grib.codes_get(handle, 'longitudeOfLastGridPointInDegrees') + 180) % 360 - 180,
                            grib.codes_get(handle, 'latitudeOfFirstGridPointInDegrees'),
                        ]
                        if actual_bounds is not None and bounds != actual_bounds:
                            raise ValueError('Selected messages have different cropped extents')
                        actual_bounds = bounds
                    grib.codes_write(handle, output)
                    count += 1
                    found.add(field)
                    if args.field or args.start or args.end:
                        observed.setdefault(field, set()).add(valid_time)
                finally:
                    grib.codes_release(handle)
            if end == 0 or end != source.stat().st_size:
                raise ValueError(f'Empty or trailing non-GRIB data in {source.name}')
    if not count or set(args.field) - found:
        raise ValueError('Requested fields were not all found in the selected forecast steps')
    if args.start and args.end:
        wanted = {
            args.start + timedelta(hours=i)
            for i in range(int((args.end - args.start).total_seconds() // 3600) + 1)
        }
        if any(not wanted.issubset(observed.get(field, set())) for field in args.field):
            raise ValueError('A requested field is missing at one or more requested hourly forecast times')
    return {
        'messageCount': count,
        **({'bounds': actual_bounds} if actual_bounds is not None else {}),
        **({'forecastTimes': sorted({time.isoformat().replace('+00:00', 'Z') for times in observed.values() for time in times})} if observed else {}),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bbox', type=float, nargs=4, metavar=('W', 'S', 'E', 'N'))
    parser.add_argument('--field', action='append', default=[], help='ecCodes shortName; repeat for multiple fields')
    parser.add_argument('--from', dest='start', type=datetime.fromisoformat)
    parser.add_argument('--to', dest='end', type=datetime.fromisoformat)
    parser.add_argument('--max-bytes', type=int, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New output file')
    parser.add_argument('inputs', type=Path, nargs='+', help='GRIB2 assets in the desired output order')
    args = parser.parse_args()
    if args.bbox and not all(math.isfinite(value) for value in args.bbox):
        parser.error('bounding box coordinates must be finite')
    resource.setrlimit(resource.RLIMIT_FSIZE, (args.max_bytes, args.max_bytes))
    try:
        with tempfile.NamedTemporaryFile(dir=args.output.parent) as output:
            result = process(args, output)
            output.flush()
            args.output.hardlink_to(output.name)
    except (OSError, ValueError, grib.CodesInternalError) as error:
        parser.exit(1, f'{error}\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
