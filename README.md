# TCX Concatenation and Heart-Rate Merger

This repository can join recordings of an activity saved in parts, or combine
a cycling recording with heart-rate data recorded separately.

This project is a fork of [dumpeldown/tcx-hr-merger](https://github.com/dumpeldown/tcx-hr-merger).

## Which script to use

| Script | Purpose | Inputs | Output |
| --- | --- | --- | --- |
| [concatenate-tcx.py](./concatenate-tcx.py) | Join consecutive parts of one activity, such as an accidental save followed by a new recording | Two or more original TCX files that do not overlap in time | One TCX activity preserving laps, GPS, sensor readings, and breaks |
| [merge-tcx-to-fit.js](./merge-tcx-to-fit.js) | Add separately recorded heart rate to a bike recording from the same session | A bike file and a heart-rate file with overlapping timestamps; TCX, GPX, or FIT | One indoor-cycling FIT activity, interpolated to one-second intervals |
| [merge-from-downloads.sh](./merge-from-downloads.sh) | Run the JavaScript bike/heart-rate merger on Downloads, once or continuously | Automatically selected bike and heart-rate files | The same FIT output as the JavaScript merger |
| [mergeHR2tcx.py](./mergeHR2tcx.py) | Legacy workflow: add heart rate from a daily Garmin JSON export | An activity TCX and heart-rate JSON | Updated TCX, using the legacy CSV/conversion helpers |

The concatenation command takes explicit file paths. The Downloads automation
applies to the bike/heart-rate FIT workflow only. Concatenation keeps original
samples and shifts cumulative distances; the FIT workflow combines simultaneous
streams and interpolates their samples.

## Join an activity accidentally saved in parts

Use [concatenate-tcx.py](./concatenate-tcx.py) to combine **sequential recordings**
into one Garmin-compatible TCX activity. This is separate from the overlapping
bike/heart-rate merger described below.

Requires **Python 3.9 or newer**, with no additional dependencies or installation.
Run from this directory, using the original Garmin TCX exports:

```bash
python3 concatenate-tcx.py /path/to/first.tcx /path/to/second.tcx -o /path/to/combined.tcx
```

For Windows Downloads from WSL, for example:

```bash
python3 concatenate-tcx.py "/mnt/c/Users/julio/Downloads/first.tcx" \
  "/mnt/c/Users/julio/Downloads/second.tcx" \
  -o "/mnt/c/Users/julio/Downloads/combined.tcx"
```

On Windows, use `py -3 concatenate-tcx.py` and normal Windows paths instead.
You can also run `npm run concatenate-tcx -- first.tcx second.tcx -o combined.tcx`
if Python is available as `python3`.

You may supply more than two files, in any order; the command sorts them by
their first trackpoint timestamps. The destination directory must exist. Inputs
are never changed, and existing output files are never overwritten.

The command:

- Creates one activity with all original laps, retaining the earliest recording's
  activity ID, creator, and document metadata.
- Adds each preceding recording's cumulative distance to the next recording's
  trackpoints. It uses the larger of the lap total and final trackpoint distance
  to accommodate small rounding differences without a backwards step.
- Keeps each lap's distance, timer time, calories, and other summaries intact.
  Garmin therefore receives lap totals for the complete activity.
- Preserves original timestamps, GPS, sensor readings, and extension fields,
  without interpolation. A meal break stays a gap between recordings, while
  recorded timer time remains the sum of the original lap timer times.
- Reparses and validates the generated XML, sample count, totals, timestamps,
  and distance continuity before writing it.

Inputs must be TCX v2 files with one activity each, matching sports, strictly
increasing timestamps, and cumulative trackpoint distances. Overlapping files,
distance resets within a file, missing lap summaries, and a mismatch exceeding
one meter between lap totals and final trackpoint distance are rejected. Use
the original exports: an online merge may already contain inconsistent summaries.
The tool preserves each lap's supplied summaries; it does not repair bad source data.

For example, the October 17, 2026 recordings totaled **86.38603 km** with
**16,589 trackpoints**, two laps, and **16,586.345 seconds** of recorded timer
time. The online merger's output reached the combined distance in its trackpoints
but retained about **78.71 km** in its single lap summary, explaining the
distance discrepancy seen on import.

The output is validated locally; Garmin Connect acceptance is only confirmed
by uploading it. Since the original activity ID is retained, an existing
activity can be flagged as a duplicate.

## Combine a bike recording with separate heart-rate data

The FIT workflow is designed for activity exports placed in the Windows
Downloads folder. The merger automatically finds supported files, identifies
which file contains bike data and which contains heart-rate data, verifies that
the activities overlap in time, and writes the finished FIT file beside the
bike activity.

It creates an indoor-cycling FIT activity from two overlapping activity
exports, typically:

- a bike or indoor-bike file containing distance, cadence, power, and/or speed;
- a watch or heart-rate file containing heart-rate samples.

Inputs may be `.tcx`, `.gpx`, or `.fit`. The output is tagged as
`cycling` / `indoor_cycling` and includes one record per second with available
distance, speed, cadence, power, and heart-rate data.

### Automatic workflow

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

### Explicit workflow

Files can also be supplied directly. The first input must be the bike file and
the second must be the heart-rate file:

```bash
node merge-tcx-to-fit.js bike-file watch-file merged-indoor-cycling.fit
```

Activities that do not overlap in time are rejected.

### FIT output

The generated file contains:

- cycling / indoor-cycling sport metadata;
- timestamped records with distance, speed, cadence, power, and heart rate;
- lap and session summaries, including calories when available;
- Garmin FIT integrity validation before the command completes successfully.

## Development

With Python 3.9+, Node.js, and the npm dependencies installed, run the test suite with:

```bash
npm test
```

This checks both TCX concatenation and the bike/heart-rate FIT merger.

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
