import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverInputs,
  encodeFit,
  mergeStreams,
  parseActivity,
  verifyFit,
} from "../merge-tcx-to-fit.js";

function point(second, values) {
  return { timestamp: new Date(`2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`), ...values };
}

function tcx(points) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities><Activity Sport="Biking"><Lap StartTime="2026-01-01T00:00:00.000Z">
    <TotalTimeSeconds>2</TotalTimeSeconds><DistanceMeters>20</DistanceMeters>
    <Track>${points.map((sample) => `<Trackpoint>
      <Time>${sample.time}</Time>
      <DistanceMeters>${sample.distance ?? 0}</DistanceMeters>
      ${sample.cadence == null ? "" : `<Cadence>${sample.cadence}</Cadence>`}
      ${sample.heartRate == null ? "" : `<HeartRateBpm><Value>${sample.heartRate}</Value></HeartRateBpm>`}
    </Trackpoint>`).join("")}</Track>
  </Lap></Activity></Activities>
</TrainingCenterDatabase>`;
}

test("merges and interpolates bike and heart-rate streams", () => {
  const bike = [
    point(0, { distance: 0, cadence: 80, power: 100 }),
    point(2, { distance: 20, cadence: 84, power: 120 }),
  ];
  const heartRate = [
    point(0, { heartRate: 100 }),
    point(2, { heartRate: 120 }),
  ];
  const records = mergeStreams(bike, heartRate, { totalDistance: 10 });

  assert.equal(records.length, 3);
  assert.equal(records[1].heartRate, 110);
  assert.equal(records[1].cadence, 82);
  assert.equal(records.at(-1).distance, 10);
  assert.equal(records[1].speed, 5);
});

test("rejects activities that do not overlap", () => {
  const bike = [point(0, { distance: 0 }), point(1, { distance: 1 })];
  const heartRate = [point(10, { heartRate: 100 }), point(11, { heartRate: 101 })];
  assert.throws(() => mergeStreams(bike, heartRate), /do not overlap/);
});

test("encodes a valid indoor-cycling FIT activity", () => {
  const records = mergeStreams(
    [point(0, { distance: 0, cadence: 80, power: 100 }), point(2, { distance: 20, cadence: 84, power: 120 })],
    [point(0, { heartRate: 100 }), point(2, { heartRate: 120 })],
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tcx-hr-merger-"));
  const output = path.join(directory, "activity.fit");
  try {
    encodeFit(records, output, { totalCalories: 42 });
    const messages = verifyFit(output);
    assert.equal(messages.sessionMesgs[0].sport, "cycling");
    assert.equal(messages.sessionMesgs[0].subSport, "indoorCycling");
    assert.equal(messages.sessionMesgs[0].totalCalories, 42);
    assert.equal(messages.recordMesgs.length, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("automatically identifies bike and heart-rate files in a Downloads directory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tcx-hr-discovery-"));
  const bikeFilename = path.join(directory, "watch-export.tcx");
  const heartRateFilename = path.join(directory, "bike-export.tcx");
  const outputFilename = path.join(directory, "merged-indoor-cycling.fit");
  try {
    fs.writeFileSync(bikeFilename, tcx([
      { time: "2026-01-01T00:00:00.000Z", distance: 0, cadence: 80 },
      { time: "2026-01-01T00:00:01.000Z", distance: 10, cadence: 82 },
    ]));
    fs.writeFileSync(heartRateFilename, tcx([
      { time: "2026-01-01T00:00:00.000Z", heartRate: 100 },
      { time: "2026-01-01T00:00:01.000Z", heartRate: 110 },
    ]));

    const inputs = discoverInputs({ directories: [directory], outputFilename });
    assert.equal(inputs.bikeFilename, bikeFilename);
    assert.equal(inputs.heartRateFilename, heartRateFilename);
    assert.equal(inputs.outputFilename, outputFilename);
    assert.equal(parseActivity(inputs.bikeFilename).stats.cadence, 2);
    assert.equal(parseActivity(inputs.heartRateFilename).stats.heartRate, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
