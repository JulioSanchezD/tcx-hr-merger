# TCX/GPX/FIT Heart-Rate Merger

This repository combines a cycling activity stream with a separate heart-rate
activity and produces a Garmin-compatible indoor-cycling `.fit` file.

This project is a fork of [dumpeldown/tcx-hr-merger](https://github.com/dumpeldown/tcx-hr-merger).

The current workflow is designed for activity exports placed in the Windows
Downloads folder. The merger automatically finds supported files, identifies
which file contains bike data and which contains heart-rate data, verifies that
the activities overlap in time, and writes the finished FIT file beside the
bike activity.

## Current objective

Create a usable indoor-cycling FIT activity from two overlapping activity
exports, typically:

- a bike or indoor-bike file containing distance, cadence, power, and/or speed;
- a watch or heart-rate file containing heart-rate samples.

Inputs may be `.tcx`, `.gpx`, or `.fit`. The output is tagged as
`cycling` / `indoor_cycling` and includes one record per second with available
distance, speed, cadence, power, and heart-rate data.

## Automatic workflow

Requirements: Node.js 16 or newer.

Install dependencies once:

```bash
npm install
```

Place the activity files in Windows Downloads, then run:

```bash
node merge-tcx-to-fit.js
```

The command writes:

```text
merged-indoor-cycling.fit
```

to the directory containing the selected bike file. It consolidates duplicate
timestamps, interpolates missing values to one-second intervals, and validates
the generated FIT file before reporting success.

To run the same workflow through the shell wrapper:

```bash
./merge-from-downloads.sh
```

To keep watching Downloads and rerun automatically when activity files are
added or replaced:

```bash
./merge-from-downloads.sh --watch
```

The watcher checks every 10 seconds by default. Change the interval with
`TCX_HR_POLL_SECONDS`.

If the files are in another directory, set `TCX_HR_DOWNLOADS`:

```bash
TCX_HR_DOWNLOADS=/path/to/Downloads ./merge-from-downloads.sh
```

## Explicit workflow

Files can also be supplied directly. The first input must be the bike file and
the second must be the heart-rate file:

```bash
node merge-tcx-to-fit.js bike-file watch-file merged-indoor-cycling.fit
```

Activities that do not overlap in time are rejected.

## FIT output

The generated file contains:

- cycling / indoor-cycling sport metadata;
- timestamped records with distance, speed, cadence, power, and heart rate;
- lap and session summaries, including calories when available;
- Garmin FIT integrity validation before the command completes successfully.

## Development

Run the test suite with:

```bash
npm test
```

The main implementation is [merge-tcx-to-fit.js](./merge-tcx-to-fit.js), and
the automated Downloads wrapper is [merge-from-downloads.sh](./merge-from-downloads.sh).

## Legacy Python workflow

The original Python scripts remain in the repository for the older workflow
that merges manually exported daily Garmin heart-rate JSON into a TCX file:

```bash
python mergeHR2tcx.py activity.tcx hr.json updated_activity.tcx
```

That workflow is separate from the current automatic TCX/GPX/FIT-to-FIT
merger. The conversion helpers (`tcx2csv.py`, `csv2tcx.py`, `addHR2csv.py`,
and `interpHR.py`) support the legacy process.

## Acknowledgements

Thanks to [coreysiegel/tcx-gpx-csv](https://github.com/coreysiegel/tcx-gpx-csv)
for the original TCX-to-CSV conversion script.
