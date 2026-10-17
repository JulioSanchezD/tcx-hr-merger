import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const script = fileURLToPath(new URL('../concatenate-tcx.py', import.meta.url));
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

function fixture({ start, distances, total = distances.at(-1), sport = 'Biking', prefix = 'sensor', laps } = {}) {
  const lap = (values, index) => `<Lap StartTime="2026-01-01T00:00:${String(start + index * 2).padStart(2, '0')}Z">
    <TotalTimeSeconds>1</TotalTimeSeconds><DistanceMeters>${values.at(-1) - (index ? distances[1] : 0)}</DistanceMeters>
    <Calories>12</Calories><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod><Track>
    ${values.map((d, i) => `<Trackpoint><Time>2026-01-01T00:00:${String(start + index * 2 + i).padStart(2, '0')}Z</Time>
      <Position><LatitudeDegrees>19.4326</LatitudeDegrees><LongitudeDegrees>-99.1332</LongitudeDegrees></Position>
      <DistanceMeters>${d}</DistanceMeters><HeartRateBpm><Value>135</Value></HeartRateBpm><Cadence>80</Cadence>
      <Extensions><${prefix}:TPX><${prefix}:Watts>150</${prefix}:Watts></${prefix}:TPX></Extensions></Trackpoint>`).join('')}
    </Track><Extensions><${prefix}:LapData>unchanged</${prefix}:LapData></Extensions></Lap>`;
  let lapXml = laps ? laps.map(lap).join('') : lap(distances, 0);
  if (!laps) lapXml = lapXml.replace(`<DistanceMeters>${distances.at(-1)}</DistanceMeters>`, `<DistanceMeters>${total}</DistanceMeters>`);
  return `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
    xmlns:${prefix}="urn:extensions:${prefix}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:types="urn:custom-types">
    <Activities><Activity Sport="${sport}"><Id>2026-01-01T00:00:${String(start).padStart(2, '0')}Z</Id>${lapXml}
    <Creator xsi:type="types:Device"><Name>Original Garmin</Name></Creator></Activity></Activities>
    <Author><Name>Original author</Name></Author></TrainingCenterDatabase>`;
}

function runCase(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'concatenate-tcx-'));
  const first = path.join(directory, 'first.tcx'), second = path.join(directory, 'second.tcx');
  const output = path.join(directory, 'combined.tcx');
  fs.writeFileSync(first, fixture({ start: 0, distances: [0, 10.0005], total: 10 }));
  fs.writeFileSync(second, fixture({ start: 30, distances: [0, 5], prefix: 'other' }));
  const run = (...inputs) => spawnSync('python3', [script, ...inputs, '-o', output], { encoding: 'utf8' });
  try { callback({ directory, first, second, output, run }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('joins originals in time order, preserves samples and namespaces, and verifies summaries', () => runCase(({ first, second, output, run }) => {
  const originals = [first, second].map(p => fs.readFileSync(p, 'utf8'));
  const result = run(second, first);
  assert.equal(result.status, 0, result.stderr);
  const xml = fs.readFileSync(output, 'utf8');
  assert.equal(XMLValidator.validate(xml), true);
  const database = parser.parse(xml).TrainingCenterDatabase;
  assert.deepEqual(database.Author, { Name: 'Original author' });
  const activity = database.Activities.Activity;
  assert.equal(activity.Id, '2026-01-01T00:00:00Z');
  assert.equal(activity.Creator.Name, 'Original Garmin');
  assert.match(xml, /xmlns:types="urn:custom-types"/);
  const laps = activity.Lap;
  assert.equal(laps.length, 2);
  assert.equal(laps.reduce((s, lap) => s + lap.DistanceMeters, 0), 15);
  assert.equal(laps.reduce((s, lap) => s + lap.TotalTimeSeconds, 0), 2);
  assert.equal(laps[1].Track.Trackpoint[0].Time, '2026-01-01T00:00:30Z');
  assert.deepEqual(laps.flatMap(l => l.Track.Trackpoint.map(p => p.DistanceMeters)), [0, 10.0005, 10.0005, 15.0005]);
  for (let i = 0; i < 2; i++) {
    const source = parser.parse(originals[i]).TrainingCenterDatabase.Activities.Activity.Lap;
    for (const key of ['TotalTimeSeconds', 'DistanceMeters', 'Calories', 'Extensions']) assert.deepEqual(laps[i][key], source[key]);
    for (let j = 0; j < 2; j++) {
      const { DistanceMeters: a, ...before } = source.Track.Trackpoint[j];
      const { DistanceMeters: b, ...after } = laps[i].Track.Trackpoint[j];
      assert.deepEqual(after, before);
    }
  }
  assert.match(xml, /xmlns:other="urn:extensions:other"/);
  assert.deepEqual([first, second].map(p => fs.readFileSync(p, 'utf8')), originals);
}));

test('supports more than two recordings and preserves multiple laps', () => runCase(({ directory, first, second, output, run }) => {
  fs.writeFileSync(first, fixture({ start: 0, distances: [0, 10, 10, 15], laps: [[0, 10], [10, 15]] }));
  const third = path.join(directory, 'third.tcx');
  fs.writeFileSync(third, fixture({ start: 40, distances: [0, 3] }));
  const result = run(third, second, first);
  assert.equal(result.status, 0, result.stderr);
  const laps = parser.parse(fs.readFileSync(output, 'utf8')).TrainingCenterDatabase.Activities.Activity.Lap;
  assert.equal(laps.length, 4);
  assert.deepEqual(laps.map(l => l.DistanceMeters), [10, 5, 5, 3]);
  assert.equal(laps.at(-1).Track.Trackpoint.at(-1).DistanceMeters, 23);
}));

for (const [name, replacement, message] of [
  ['overlap', { start: 1, distances: [0, 5] }, /overlap/],
  ['different sports', { start: 30, distances: [0, 5], sport: 'Running' }, /same Sport/],
  ['distance reset', { start: 30, distances: [5, 0] }, /distance resets/],
  ['bad summary', { start: 30, distances: [0, 5], total: 50 }, /summaries/],
]) {
  test(`rejects ${name} before writing output`, () => runCase(({ first, second, output, run }) => {
    fs.writeFileSync(second, fixture(replacement));
    const result = run(first, second);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(fs.existsSync(output), false);
  }));
}

test('protects existing outputs and rejects duplicate inputs', () => runCase(({ first, second, output, run }) => {
  assert.match(run(first, first).stderr, /same input/);
  fs.writeFileSync(output, 'keep this');
  assert.match(run(first, second).stderr, /already exists/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep this');
  const before = fs.readFileSync(first, 'utf8');
  const result = spawnSync('python3', [script, first, second, '-o', first], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(first, 'utf8'), before);
}));
