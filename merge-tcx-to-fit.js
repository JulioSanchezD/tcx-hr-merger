#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Decoder, Encoder, Profile, Stream } from "@garmin/fitsdk";
import { XMLParser } from "fast-xml-parser";

function usage() {
  return `Usage:
  node merge-tcx-to-fit.js
  node merge-tcx-to-fit.js <bike-file> <heart-rate-file> <output.fit>

With no arguments, the program searches the Windows Downloads folder for TCX,
GPX, and FIT activities, identifies the bike and heart-rate files by their
trackpoint fields, and writes merged-indoor-cycling.fit beside them.

The bike file supplies timestamps, distance, cadence, and/or power. The
heart-rate file supplies heart rate. The output is a FIT Activity with
sport=cycling and sub_sport=indoor_cycling.`;
}

function array(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function finiteNumber(value) {
  if (value == null || value === "") return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function parseTimestamp(value, filename) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Invalid trackpoint timestamp in ${filename}: ${value}`);
  }
  return timestamp;
}

function findActivities(document, filename) {
  const database = document.TrainingCenterDatabase;
  const activities = array(database?.Activities?.Activity);
  if (activities.length === 0) {
    throw new Error(`No TCX activities found in ${filename}`);
  }
  return activities;
}

function activityData(points, { totalDistance, totalCalories } = {}) {
  return {
    points,
    totalDistance: totalDistance > 0 ? totalDistance : undefined,
    totalCalories: totalCalories > 0 ? totalCalories : undefined,
    stats: {
      heartRate: points.filter((point) => Number.isFinite(point.heartRate)).length,
      distance: points.filter((point) => Number.isFinite(point.distance) && point.distance > 0).length,
      cadence: points.filter((point) => Number.isFinite(point.cadence) && point.cadence > 0).length,
      power: points.filter((point) => Number.isFinite(point.power) && point.power >= 0).length,
      speed: points.filter((point) => Number.isFinite(point.speed) && point.speed > 0).length,
    },
  };
}

export function parseTcx(filename) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
  });
  const document = parser.parse(fs.readFileSync(filename, "utf8"));
  const points = [];
  let totalDistance = 0;
  let totalCalories = 0;

  for (const activity of findActivities(document, filename)) {
    for (const lap of array(activity.Lap)) {
      totalDistance += finiteNumber(lap.DistanceMeters) ?? 0;
      totalCalories += finiteNumber(lap.Calories) ?? 0;
      for (const track of array(lap.Track)) {
        for (const point of array(track.Trackpoint)) {
          if (!point.Time) continue;
          const extension = point.Extensions?.TPX;
          points.push({
            timestamp: parseTimestamp(point.Time, filename),
            distance: finiteNumber(point.DistanceMeters),
            cadence: finiteNumber(point.Cadence),
            heartRate: finiteNumber(point.HeartRateBpm?.Value),
            power: finiteNumber(extension?.Watts),
            speed: finiteNumber(extension?.Speed),
          });
        }
      }
    }
  }

  points.sort((left, right) => left.timestamp - right.timestamp);
  if (points.length === 0) throw new Error(`No timed trackpoints found in ${filename}`);
  return activityData(points, { totalDistance, totalCalories });
}

function numericField(value, keys) {
  if (value == null || typeof value !== "object") return undefined;
  for (const key of keys) {
    const number = finiteNumber(value[key]);
    if (number !== undefined) return number;
  }
  for (const child of Object.values(value)) {
    const number = numericField(child, keys);
    if (number !== undefined) return number;
  }
  return undefined;
}

function haversineMeters(left, right) {
  if (!left || !right) return 0;
  const radians = Math.PI / 180;
  const latitude = (right.latitude - left.latitude) * radians;
  const longitude = (right.longitude - left.longitude) * radians;
  const a = Math.sin(latitude / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians)
    * Math.sin(longitude / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function parseGpx(filename) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
  });
  const document = parser.parse(fs.readFileSync(filename, "utf8"));
  const tracks = array(document.gpx?.trk);
  const points = [];
  let previousCoordinate;
  let cumulativeDistance = 0;

  for (const track of tracks) {
    for (const segment of array(track.trkseg)) {
      for (const point of array(segment.trkpt)) {
        if (!point.time) continue;
        const latitude = finiteNumber(point.lat);
        const longitude = finiteNumber(point.lon);
        const coordinate = Number.isFinite(latitude) && Number.isFinite(longitude)
          ? { latitude, longitude }
          : undefined;
        if (coordinate && previousCoordinate) cumulativeDistance += haversineMeters(previousCoordinate, coordinate);
        previousCoordinate = coordinate ?? previousCoordinate;
        points.push({
          timestamp: parseTimestamp(point.time, filename),
          distance: numericField(point, ["distance", "DistanceMeters"]) ?? (cumulativeDistance || undefined),
          cadence: numericField(point, ["cadence", "cad"]),
          heartRate: numericField(point, ["heartRate", "heartrate", "hr"]),
          power: numericField(point, ["power", "watts", "Watts"]),
          speed: numericField(point, ["speed", "Speed"]),
        });
      }
    }
  }

  if (points.length === 0) throw new Error(`No timed GPX trackpoints found in ${filename}`);
  const metadata = document.gpx?.metadata;
  return activityData(points, {
    totalDistance: cumulativeDistance,
    totalCalories: numericField(metadata, ["calories", "Calories"]),
  });
}

export function parseFit(filename) {
  const stream = Stream.fromBuffer(fs.readFileSync(filename));
  const decoder = new Decoder(stream);
  if (!decoder.isFIT()) throw new Error(`Not a FIT file: ${filename}`);
  if (!decoder.checkIntegrity()) throw new Error(`Invalid FIT file: ${filename}`);
  const { messages, errors } = decoder.read();
  if (errors.length) throw errors[0];

  const points = array(messages.recordMesgs).filter((record) => record.timestamp).map((record) => ({
    timestamp: parseTimestamp(record.timestamp, filename),
    distance: finiteNumber(record.distance),
    cadence: finiteNumber(record.cadence),
    heartRate: finiteNumber(record.heartRate),
    power: finiteNumber(record.power),
    speed: finiteNumber(record.speed),
  }));
  if (points.length === 0) throw new Error(`No timed FIT record messages found in ${filename}`);
  const session = array(messages.sessionMesgs)[0] ?? {};
  const lap = array(messages.lapMesgs)[0] ?? {};
  return activityData(points, {
    totalDistance: finiteNumber(session.totalDistance) ?? finiteNumber(lap.totalDistance),
    totalCalories: finiteNumber(session.totalCalories) ?? finiteNumber(lap.totalCalories),
  });
}

export function parseActivity(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".tcx") return parseTcx(filename);
  if (extension === ".gpx") return parseGpx(filename);
  if (extension === ".fit") return parseFit(filename);
  throw new Error(`Unsupported activity file type: ${filename}`);
}

const activityExtensions = new Set([".tcx", ".gpx", ".fit"]);

function windowsPathForCurrentUser() {
  const user = process.env.USERNAME || process.env.USER;
  if (!user) return undefined;
  if (process.platform === "win32") return path.join("C:", "Users", user, "Downloads");
  return path.join("/mnt/c", "Users", user, "Downloads");
}

export function downloadDirectories() {
  const candidates = [
    process.env.TCX_HR_DOWNLOADS,
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Downloads"),
    process.env.HOME && path.join(process.env.HOME, "Downloads"),
    windowsPathForCurrentUser(),
    "/mnt/c/Users/Public/Downloads",
  ];
  return [...new Set(candidates.filter(Boolean))].filter((directory) => {
    try {
      return fs.statSync(directory).isDirectory();
    } catch {
      return false;
    }
  });
}

function bikeSignalScore(activity) {
  const { stats } = activity;
  return stats.distance * 4 + stats.cadence * 3 + stats.power * 4 + stats.speed * 2;
}

function timeRange(activity) {
  const timestamps = activity.points.map((point) => point.timestamp.getTime());
  return [Math.min(...timestamps), Math.max(...timestamps)];
}

function overlapSeconds(left, right) {
  const [leftStart, leftEnd] = timeRange(left);
  const [rightStart, rightEnd] = timeRange(right);
  return (Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart)) / 1000;
}

function candidateSummary(candidate) {
  const { stats } = candidate.activity;
  return `${path.basename(candidate.filename)} (HR ${stats.heartRate}, distance ${stats.distance}, cadence ${stats.cadence}, power ${stats.power}, speed ${stats.speed})`;
}

export function discoverActivityFiles(directories = downloadDirectories()) {
  const files = [];
  for (const directory of directories) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filename = path.join(directory, entry.name);
      if (activityExtensions.has(path.extname(entry.name).toLowerCase())) files.push(filename);
    }
  }
  return [...new Set(files)].sort();
}

export function discoverInputs({ directories, outputFilename } = {}) {
  const files = discoverActivityFiles(directories);
  const excludedOutput = outputFilename ? path.resolve(outputFilename) : undefined;
  const candidates = [];
  const unreadable = [];

  for (const filename of files) {
    if (path.basename(filename).toLowerCase() === "merged-indoor-cycling.fit"
      || path.resolve(filename) === excludedOutput) continue;
    try {
      candidates.push({ filename, activity: parseActivity(filename) });
    } catch (error) {
      unreadable.push(`${path.basename(filename)}: ${error.message}`);
    }
  }

  let best;
  for (const bike of candidates) {
    const bikeScore = bikeSignalScore(bike.activity);
    if (bikeScore === 0) continue;
    for (const heartRate of candidates) {
      if (bike === heartRate || heartRate.activity.stats.heartRate === 0) continue;
      const overlap = overlapSeconds(bike.activity, heartRate.activity);
      if (overlap < 0) continue;
      const score = bikeScore * 10
        + heartRate.activity.stats.heartRate
        - bikeSignalScore(heartRate.activity) * 5
        + Math.min(overlap, 3600);
      if (!best || score > best.score) best = { bike, heartRate, score, overlap };
    }
  }

  if (!best) {
    const details = candidates.length
      ? candidates.map(candidateSummary).join("; ")
      : "no readable TCX, GPX, or FIT activities";
    const skipped = unreadable.length ? ` Skipped: ${unreadable.join("; ")}` : "";
    throw new Error(`Could not identify overlapping bike and heart-rate files in Downloads: ${details}.${skipped}`);
  }

  const defaultOutput = path.join(path.dirname(best.bike.filename), "merged-indoor-cycling.fit");
  return {
    bikeFilename: best.bike.filename,
    heartRateFilename: best.heartRate.filename,
    outputFilename: outputFilename ?? defaultOutput,
    overlap: best.overlap,
    candidates,
  };
}

function average(values) {
  const known = values.filter(Number.isFinite);
  if (known.length === 0) return undefined;
  return known.reduce((sum, value) => sum + value, 0) / known.length;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return undefined;
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

// FIT timestamps have one-second resolution. Collapse duplicate TCX timestamps;
// use the furthest distance and average instantaneous sensor readings.
export function collapseToSeconds(points) {
  const buckets = new Map();
  for (const point of points) {
    const second = Math.round(point.timestamp.getTime() / 1000);
    const bucket = buckets.get(second) ?? [];
    bucket.push(point);
    buckets.set(second, bucket);
  }

  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([second, bucket]) => ({
    second,
    timestamp: new Date(second * 1000),
    distance: Math.max(...bucket.map((point) => point.distance).filter(Number.isFinite), -Infinity),
    cadence: average(bucket.map((point) => point.cadence)),
    heartRate: average(bucket.map((point) => point.heartRate)),
    power: average(bucket.map((point) => point.power)),
    speed: average(bucket.map((point) => point.speed)),
  })).map((point) => ({
    ...point,
    distance: Number.isFinite(point.distance) ? point.distance : undefined,
  }));
}

function interpolate(points, second, field, { nearestOutside = false } = {}) {
  if (points.length === 0) return undefined;
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].second < second) low = middle + 1;
    else if (points[middle].second > second) high = middle - 1;
    else return points[middle][field];
  }

  const before = points[high];
  const after = points[low];
  if (!before || !after) {
    if (!nearestOutside) return undefined;
    return (before ?? after)?.[field];
  }
  const beforeValue = before[field];
  const afterValue = after[field];
  if (!Number.isFinite(beforeValue)) return afterValue;
  if (!Number.isFinite(afterValue)) return beforeValue;
  const fraction = (second - before.second) / (after.second - before.second);
  return beforeValue + (afterValue - beforeValue) * fraction;
}

export function mergeStreams(bikePoints, heartRatePoints, { totalDistance } = {}) {
  const bike = collapseToSeconds(bikePoints);
  const heartRate = collapseToSeconds(heartRatePoints).filter((point) => Number.isFinite(point.heartRate));
  if (!bike.some((point) => Number.isFinite(point.distance) || Number.isFinite(point.power) || Number.isFinite(point.cadence))) {
    throw new Error("The bike TCX has no distance, power, or cadence data");
  }
  if (bike.length < 2 || bike[0].second === bike.at(-1).second) {
    throw new Error("The bike TCX must span at least two distinct seconds");
  }
  if (heartRate.length === 0) throw new Error("The heart-rate TCX has no heart-rate data");
  if (bike.at(-1).second < heartRate[0].second || heartRate.at(-1).second < bike[0].second) {
    throw new Error("The bike and heart-rate activities do not overlap in time");
  }

  const startSecond = bike[0].second;
  const endSecond = bike.at(-1).second;
  const records = [];
  for (let second = startSecond; second <= endSecond; second += 1) {
    records.push({
      timestamp: new Date(second * 1000),
      distance: interpolate(bike, second, "distance", { nearestOutside: true }),
      cadence: interpolate(bike, second, "cadence", { nearestOutside: true }),
      power: interpolate(bike, second, "power", { nearestOutside: true }),
      sourceSpeed: interpolate(bike, second, "speed", { nearestOutside: true }),
      heartRate: interpolate(heartRate, second, "heartRate", { nearestOutside: true }),
    });
  }

  const hasSourceSpeed = records.some((record) => Number.isFinite(record.sourceSpeed));
  if (hasSourceSpeed) {
    for (let index = 0; index < records.length; index += 1) {
      const previous = records[Math.max(0, index - 1)];
      const next = records[Math.min(records.length - 1, index + 1)];
      const elapsed = (next.timestamp - previous.timestamp) / 1000;
      const fallback = elapsed > 0 && Number.isFinite(previous.distance) && Number.isFinite(next.distance)
        ? Math.max(0, (next.distance - previous.distance) / elapsed)
        : undefined;
      records[index].speed = Number.isFinite(records[index].sourceSpeed) ? records[index].sourceSpeed : fallback;
      delete records[index].sourceSpeed;
    }
    const recordedDistance = records.at(-1).distance;
    if (Number.isFinite(totalDistance) && totalDistance > 0 && Number.isFinite(recordedDistance) && recordedDistance > 0) {
      const scale = totalDistance / recordedDistance;
      for (const record of records) if (Number.isFinite(record.distance)) record.distance *= scale;
    }
  } else {
    // If no explicit speed exists, derive it from distance. Corrupt TCX samples
    // can contain huge distance jumps, so cap the top 5% of interval speeds,
    // then normalize and rebuild distance to exactly match the lap total.
    const intervalSpeeds = records.slice(1).map((record, index) => {
      const previous = records[index];
      const elapsed = (record.timestamp - previous.timestamp) / 1000;
      return elapsed > 0 && Number.isFinite(record.distance) && Number.isFinite(previous.distance)
        ? Math.max(0, (record.distance - previous.distance) / elapsed)
        : 0;
    });
    const speedCap = percentile(intervalSpeeds, 0.95);
    const cleanedSpeeds = intervalSpeeds.map((speed) => Math.min(speed, speedCap));
    const cleanedDistance = cleanedSpeeds.reduce((sum, speed) => sum + speed, 0);
    const recordedDistance = records.at(-1).distance - records[0].distance;
    const targetDistance = Number.isFinite(totalDistance) && totalDistance > 0 ? totalDistance : recordedDistance;
    const scale = cleanedDistance > 0 && Number.isFinite(targetDistance) ? targetDistance / cleanedDistance : 1;
    records[0].distance = 0;
    records[0].speed = cleanedSpeeds[0] * scale;
    for (let index = 1; index < records.length; index += 1) {
      records[index].speed = cleanedSpeeds[index - 1] * scale;
      records[index].distance = records[index - 1].distance + records[index].speed;
    }
    for (const record of records) delete record.sourceSpeed;
  }
  return records;
}

function rounded(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function maximum(records, field) {
  const values = records.map((record) => record[field]).filter(Number.isFinite);
  return values.length ? Math.max(...values) : undefined;
}

function mean(records, field) {
  return average(records.map((record) => record[field]));
}

function summaryFields(records, totalCalories) {
  const first = records[0];
  const last = records.at(-1);
  const totalTimerTime = (last.timestamp - first.timestamp) / 1000;
  return {
    timestamp: last.timestamp,
    startTime: first.timestamp,
    totalElapsedTime: totalTimerTime,
    totalTimerTime,
    totalDistance: last.distance,
    totalCalories: rounded(totalCalories),
    avgSpeed: mean(records, "speed"),
    maxSpeed: maximum(records, "speed"),
    avgHeartRate: rounded(mean(records, "heartRate")),
    maxHeartRate: rounded(maximum(records, "heartRate")),
    avgCadence: rounded(mean(records, "cadence")),
    maxCadence: rounded(maximum(records, "cadence")),
    avgPower: rounded(mean(records, "power")),
    maxPower: rounded(maximum(records, "power")),
  };
}

export function encodeFit(records, outputFilename, { totalCalories } = {}) {
  const encoder = new Encoder();
  const first = records[0];
  const last = records.at(-1);
  const summary = summaryFields(records, totalCalories);

  encoder.onMesg(Profile.MesgNum.FILE_ID, {
    type: "activity",
    manufacturer: "development",
    product: 1,
    serialNumber: 1,
    timeCreated: first.timestamp,
  });
  encoder.onMesg(Profile.MesgNum.FILE_CREATOR, {
    softwareVersion: 100,
    hardwareVersion: 1,
  });
  encoder.onMesg(Profile.MesgNum.EVENT, {
    timestamp: first.timestamp,
    event: "timer",
    eventType: "start",
    eventGroup: 0,
  });

  for (const record of records) {
    encoder.onMesg(Profile.MesgNum.RECORD, {
      timestamp: record.timestamp,
      distance: record.distance,
      speed: record.speed,
      heartRate: rounded(record.heartRate),
      cadence: rounded(record.cadence),
      power: rounded(record.power),
    });
  }

  encoder.onMesg(Profile.MesgNum.EVENT, {
    timestamp: last.timestamp,
    event: "timer",
    eventType: "stopAll",
    eventGroup: 0,
  });
  encoder.onMesg(Profile.MesgNum.LAP, {
    ...summary,
    messageIndex: 0,
    event: "lap",
    eventType: "stop",
    sport: "cycling",
    subSport: "indoorCycling",
    intensity: "active",
    lapTrigger: "sessionEnd",
  });
  encoder.onMesg(Profile.MesgNum.SESSION, {
    ...summary,
    messageIndex: 0,
    event: "session",
    eventType: "stop",
    sport: "cycling",
    subSport: "indoorCycling",
    firstLapIndex: 0,
    numLaps: 1,
    trigger: "activityEnd",
  });
  encoder.onMesg(Profile.MesgNum.ACTIVITY, {
    timestamp: last.timestamp,
    totalTimerTime: summary.totalTimerTime,
    numSessions: 1,
    type: "manual",
    event: "activity",
    eventType: "stop",
  });

  fs.writeFileSync(outputFilename, encoder.close());
}

export function verifyFit(filename) {
  const stream = Stream.fromBuffer(fs.readFileSync(filename));
  const decoder = new Decoder(stream);
  if (!decoder.isFIT() || !decoder.checkIntegrity()) {
    throw new Error(`Generated file failed FIT integrity validation: ${filename}`);
  }
  const { messages, errors } = decoder.read();
  if (errors.length) throw errors[0];
  return messages;
}

function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }

  let inputs;
  if (args.length === 0 || (args.length === 1 && args[0] === "--auto")) {
    inputs = discoverInputs();
    console.log(`Auto-detected bike file: ${path.resolve(inputs.bikeFilename)}`);
    console.log(`Auto-detected heart-rate file: ${path.resolve(inputs.heartRateFilename)}`);
  } else if (args.length === 3) {
    inputs = {
      bikeFilename: args[0],
      heartRateFilename: args[1],
      outputFilename: args[2],
    };
  } else {
    console.log(usage());
    process.exitCode = 2;
    return;
  }

  const { bikeFilename, heartRateFilename, outputFilename } = inputs;
  const heartRateActivity = parseActivity(heartRateFilename);
  const parsedBikeActivity = parseActivity(bikeFilename);
  const records = mergeStreams(parsedBikeActivity.points, heartRateActivity.points, {
    totalDistance: parsedBikeActivity.totalDistance,
  });
  encodeFit(records, outputFilename, {
    // Garmin's HR-based estimate is generally the more useful calorie source.
    totalCalories: heartRateActivity.totalCalories ?? parsedBikeActivity.totalCalories,
  });
  const messages = verifyFit(outputFilename);
  const session = messages.sessionMesgs?.[0];
  console.log(`Created ${path.resolve(outputFilename)}`);
  console.log(`Records: ${records.length}; sport: ${session?.sport}; sub-sport: ${session?.subSport}`);
  console.log(`Time: ${session?.totalTimerTime}s; distance: ${(session?.totalDistance / 1000).toFixed(2)}km`);
  console.log(`Heart rate: ${session?.avgHeartRate}/${session?.maxHeartRate} bpm avg/max`);
  console.log(`Power: ${session?.avgPower}/${session?.maxPower} W avg/max`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
