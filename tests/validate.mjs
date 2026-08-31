import assert from 'node:assert/strict';
import fs from 'node:fs';
import {TRACK_SPEED_DATA} from '../js/route-data.js';
import {STUDY_SEGMENTS} from '../js/study-data.js';
import {applyStatDeltas, mergeCoverageStates} from '../js/progress-sync.js';
import {inferV2CompletedDirections, v2CoverageWitnessKeys} from '../js/coverage-recovery.js';
import {SPEED_MAP_OPERATIONAL_RESTRICTIONS, applyOperationalRestrictions, effectiveSpeedMarkers} from '../js/map-restrictions.js';

const expectedLines = [
  'belair_down','belair_up','gawler_down','gawler_up','grange_down','grange_up',
  'outerharbor_down','outerharbor_up','portdock_down','portdock_up',
  'seaford_down','seaford_up','tonsley_down','tonsley_up'
];
assert.deepEqual(Object.keys(TRACK_SPEED_DATA).sort(), expectedLines);
assert.deepEqual(Object.keys(STUDY_SEGMENTS).sort(), expectedLines);

for(const [lineId, rows] of Object.entries(TRACK_SPEED_DATA)){
  assert.ok(rows.length > 10, `${lineId} has route rows`);
  const knownKm = rows.filter(row => row.km != null).map(row => Number(row.km));
  for(let i=1;i<knownKm.length;i++){
    if(lineId.endsWith('_down')) assert.ok(knownKm[i] >= knownKm[i-1], `${lineId} kilometrage rises`);
    else assert.ok(knownKm[i] <= knownKm[i-1], `${lineId} kilometrage falls`);
  }
  for(const row of rows.filter(row => row.speed != null)){
    assert.ok(Number.isFinite(Number(row.speed)) && row.speed >= 5 && row.speed <= 110, `${lineId} speed is valid`);
  }
  const segments = STUDY_SEGMENTS[lineId];
  assert.ok(segments.length > 5, `${lineId} has curated study segments`);
  const canonicalSpeeds = new Set(rows.filter(row => row.speed != null).map(row => String(row.speed)));
  segments.forEach(segment => assert.ok(canonicalSpeeds.has(segment.speed), `${lineId} study speed exists in the addenda data`));
}

const isNamedStation = name => Boolean(name) && !name.toLowerCase().startsWith('km ') && !name.includes('(');
function studyPairs(lineId){
  const segments = STUDY_SEGMENTS[lineId];
  const points = [segments[0].from, ...segments.map(segment => segment.to)];
  const named = points.map((point, index) => isNamedStation(point) ? index : -1).filter(index => index >= 0);
  return named.slice(0, -1).map((start, pairIndex) => {
    const end = named[pairIndex + 1];
    const speeds = [];
    for(let index=start; index<end; index++){
      const speed = segments[index].speed;
      if(speeds.at(-1) !== speed) speeds.push(speed);
    }
    return {from:points[start], to:points[end], speeds};
  });
}

const grangePairs = [...studyPairs('grange_down'), ...studyPairs('grange_up')];
assert.ok(!grangePairs.some(pair => /End of Grange Line|End of Line/.test(`${pair.from} ${pair.to}`)), 'Grange terminal addenda note is not a quiz boundary');
assert.ok(grangePairs.filter(pair => /Grange/.test(pair.from) && /Grange/.test(pair.to)).every(pair => pair.speeds.length <= 2), 'Grange terminal study stretches remain concise');

const gawlerDownPairs = studyPairs('gawler_down');
assert.ok(gawlerDownPairs.some(pair => pair.from === 'Salisbury' && pair.to === 'Nurlutta' && pair.speeds.join(',') === '15,110'), 'Salisbury siding stays inside the Salisbury–Nurlutta stretch');
assert.ok(gawlerDownPairs.some(pair => pair.from === 'Elizabeth' && pair.to === 'Womma' && pair.speeds.join(',') === '85'), 'Elizabeth–Womma keeps the original single learning speed');
assert.ok(!gawlerDownPairs.some(pair => /Siding/.test(`${pair.from} ${pair.to}`)), 'sidings are not learner-facing station boundaries');
const gawlerUpPlatform3 = STUDY_SEGMENTS.gawler_up.find(segment => segment.speed === '20' && /Platform 3/.test(segment.to));
assert.equal(gawlerUpPlatform3?.note, 'Platform 3', 'Gawler Up identifies the Platform 3 speed before the quiz answer');

for(const lineId of ['belair_down','belair_up']){
  assert.ok(!studyPairs(lineId).some(pair => /Tunnel|Loop/.test(`${pair.from} ${pair.to}`)), `${lineId} technical points do not fragment the quiz`);
}

for(const lineId of expectedLines){
  const pairs = studyPairs(lineId);
  const frequencies = new Map();
  pairs.forEach(pair => {
    const signature = pair.speeds.join('>');
    frequencies.set(signature, (frequencies.get(signature) || 0) + 1);
  });
  const unambiguous = pairs.filter(pair => frequencies.get(pair.speeds.join('>')) === 1);
  assert.ok(unambiguous.length >= 2, `${lineId} has unambiguous reverse-location questions`);
  assert.ok(pairs.length >= 3, `${lineId} has enough station pairs for three location choices`);
}

const grangeUp = TRACK_SPEED_DATA.grange_up;
const grangeSequence = grangeUp.map(row => `${row.label || ''}|${row.km ?? ''}|${row.speed ?? ''}`);
assert.ok(grangeSequence.some(value => value.includes('|7.347|70')), 'Grange Up inherits 70 km/h at 7.347');
assert.ok(grangeSequence.some(value => value.startsWith('Woodville Park|')), 'Grange Up includes Woodville Park');
assert.ok(grangeSequence.some(value => value.startsWith('Kilkenny|')), 'Grange Up includes Kilkenny');
assert.ok(grangeSequence.some(value => value.includes('|5.788|90')), 'Grange Up inherits 90 km/h at 5.788');

const gawlerUp = TRACK_SPEED_DATA.gawler_up.slice(0, 8);
assert.deepEqual(gawlerUp.map(row => [row.label, row.km, row.speed]), [
  ['End of Gawler Line',42.183,25],
  ['Gawler Central',41.997,50],
  ['Gawler Oval',41.43,null],
  [null,39.94,20],
  ['Gawler Platform 3',39.847,null],
  [null,39.789,50],
  ['Gawler Platforms 1 & 2',39.789,30],
  [null,39.62,50],
]);

const key = 'gawler_up::A→B::0';
let merged = applyStatDeltas({}, {[key]:{attempts:1,correct:1,box:2,nextDueAt:20,lastAt:10,stateAt:10}});
merged = applyStatDeltas(merged, {[key]:{attempts:2,correct:1,box:1,nextDueAt:40,lastAt:30,stateAt:30}});
assert.equal(merged[key].attempts, 3, 'concurrent attempt counts are additive');
assert.equal(merged[key].correct, 2, 'concurrent correct counts are additive');
assert.equal(merged[key].box, 1, 'latest scheduling state wins');
assert.deepEqual(applyStatDeltas(merged, {[key]:{deleted:true,stateAt:50}}), {});

const repairedCoverage = mergeCoverageStates(
  {belair_down:{complete:true,stateAt:20}, gawler_up:{complete:false,stateAt:30}},
  {belair_down:{complete:false,stateAt:10}, gawler_up:{complete:true,stateAt:25}, seaford_down:{complete:true,stateAt:15}},
);
assert.equal(repairedCoverage.belair_down.complete, true, 'newer local coverage repair wins');
assert.equal(repairedCoverage.gawler_up.complete, false, 'a newer explicit removal wins');
assert.equal(repairedCoverage.seaford_down.complete, true, 'cloud-only coverage repair is retained');

const recoveryWitnesses = v2CoverageWitnessKeys('belair_down', TRACK_SPEED_DATA.belair_down, STUDY_SEGMENTS.belair_down);
assert.ok(recoveryWitnesses.length >= 5, 'v2 recovery has conservative shared-key evidence');
const completedBelairStats = Object.fromEntries(recoveryWitnesses.map(key => [key, {attempts:1, correct:1}]));
assert.ok(inferV2CompletedDirections(TRACK_SPEED_DATA, STUDY_SEGMENTS, completedBelairStats).includes('belair_down'), 'a completed v2 direction is recovered automatically');
delete completedBelairStats[recoveryWitnesses[0]];
assert.ok(!inferV2CompletedDirections(TRACK_SPEED_DATA, STUDY_SEGMENTS, completedBelairStats).includes('belair_down'), 'partial directions are not marked complete');

const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
assert.ok(!index.includes('maximum-scale'), 'browser zoom remains available');
assert.ok(index.includes('rk-auth-local'), 'local-only study is available');
assert.ok(index.includes('aria-modal="true"'), 'dialogs expose modal semantics');
assert.ok(!app.includes('SEED_DATA'), 'quiz speeds are not duplicated');
assert.ok(!app.includes('hasClaudeStorage'), 'legacy host storage is removed');
assert.ok(!/show(?:Network|SpeedMap|Progress|Review|Landing)\s*=/.test(app), 'one active view controls navigation');
assert.ok(worker.includes("route-knowledge-pwa-v25"), 'service-worker cache is versioned');
assert.ok(worker.includes("images/speed-boards/outer-harbor-shared-down-80-km-6-050.jpg"), 'pilot speed-board photo is available offline');
assert.ok(worker.includes("images/speed-boards/outer-harbor-shared-down-80-km-6-050-full.jpg"), 'full pilot speed-board photo is available offline');
assert.ok(app.includes("rk-sm-info-tabs") && app.includes("data-sm-view=\"photo\""), 'speed-board panel includes Details and Driver view tabs');
assert.ok(app.includes("Tap to enlarge") && app.includes("openSpeedBoardPhoto(boardPhoto)"), 'driver-view photograph opens the full-size viewer');
assert.ok(app.includes("rk-sm-slide-from-left") && app.includes("rk-sm-slide-from-right"), 'speed-board view switch has directional motion');
const adelaideYard = SPEED_MAP_OPERATIONAL_RESTRICTIONS.find(item => item.id === 'adelaide-yard-35');
assert.deepEqual(
  {lines:adelaideYard.lines, directions:adelaideYard.directions, fromKm:adelaideYard.fromKm, toKm:adelaideYard.toKm, speed:adelaideYard.speed},
  {lines:['gawler','outer_harbor','grange','port_dock'], directions:['down','up'], fromKm:0.633, toKm:1.380, speed:35},
  'only the supplied Adelaide Yard restriction is represented on the GM and OM corridors'
);
const restrictedDown = applyOperationalRestrictions([{speed:60,startKm:0.5,endKm:1.5,lo:0.5,hi:1.5}], 'gawler', 'down');
assert.deepEqual(restrictedDown.map(item => [item.lo,item.hi,item.speed]), [[0.5,0.633,60],[0.633,1.38,35],[1.38,1.5,60]], 'the operational cap splits a Down interval exactly');
assert.deepEqual(effectiveSpeedMarkers(restrictedDown).map(item => [item.plotKm,item.speed]), [[0.5,60],[0.633,35],[1.38,60]], 'number bubbles follow effective Down speed boundaries');
const lowerSetSpeed = applyOperationalRestrictions([{speed:15,startKm:0.5,endKm:1.0,lo:0.5,hi:1.0}], 'outer_harbor', 'down');
assert.ok(lowerSetSpeed.every(item => item.speed === 15), 'the 35 km/h cap never raises a lower set speed');
const restrictedUp = applyOperationalRestrictions([{speed:60,startKm:1.5,endKm:0.5,lo:0.5,hi:1.5}], 'port_dock', 'up');
assert.deepEqual(restrictedUp.map(item => [item.startKm,item.endKm,item.speed]), [[1.5,1.38,60],[1.38,0.633,35],[0.633,0.5,60]], 'the operational cap preserves Up travel order');
assert.deepEqual(effectiveSpeedMarkers(restrictedUp).map(item => [item.plotKm,item.speed]), [[1.5,60],[1.38,35],[0.633,60]], 'number bubbles follow effective Up speed boundaries');
assert.deepEqual(effectiveSpeedMarkers([
  {speed:35,startKm:1.5,endKm:1.0},{speed:35,startKm:1.0,endKm:0.5}
]).map(item => [item.plotKm,item.speed]), [[1.5,35]], 'masked permanent boundaries do not create duplicate bubbles');
assert.equal(applyOperationalRestrictions([{speed:60,startKm:0.5,endKm:1.5,lo:0.5,hi:1.5}], 'seaford', 'down')[0].speed, 60, 'Seaford is not affected by the GM and OM restriction');
assert.ok(app.includes('recoverCoverageAutomatically'), 'coverage recovery runs without manual input');
assert.ok(!app.includes('Repair coverage'), 'manual coverage repair is not required');
assert.ok(app.includes("role:'trunk', name:'Outer Harbor Line'"), 'Outer Harbor is the parent corridor in Network Overview');
assert.ok(app.includes("role:'trunk', name:'Seaford Line'"), 'Seaford is the parent corridor in Network Overview');
assert.ok(app.includes('renderQuizSummary'), 'completed range quizzes render a summary');
assert.ok(app.includes("retryBtn.textContent = 'Retry '"), 'quiz summary offers mistake-only retry');
assert.ok(app.includes('rk-answer-comparison'), 'mistakes separate the entered and correct speeds');
assert.ok(app.includes('rk-summary-review-head'), 'mistake review has a distinct readable heading');
assert.ok(app.includes("summary.classList.add('is-perfect')"), 'perfect summaries expose a compact completion state');
assert.ok(app.includes('row.replaceChildren(makeResultChip())'), 'range quiz answers update without rebuilding the whole page');
assert.ok(app.includes("input.enterKeyHint = Number(row.dataset.order) === totalBoxes - 1 ? 'done' : 'next'"), 'mobile keyboards expose next and done actions');
assert.ok(app.includes("{id:'speeds', label:'Quiz Speeds'}") && app.includes("{id:'locations', label:'Quiz Locations'}"), 'Browse Lines offers both quiz recall modes');
assert.ok(app.includes('buildLocationQuizQuestions') && app.includes('frequencies[locationSequenceKey(pair)] === 1'), 'location questions only use unique visible speed sequences');
assert.ok(!app.includes("id: 'complete::' + pair.key"), 'location quizzes retain the harder exact-section matching format');
assert.ok(app.includes("pair.from === 'Salisbury' && pair.to === 'Nurlutta'"), 'the infrequently used Salisbury siding stretch is excluded from location recall');
assert.ok(app.includes('rk-location-speed-note') && app.includes('note.textContent = speed.note'), 'operational platform qualifiers appear beneath their speed boards');
assert.ok(app.includes("speed.note || '\\u00a0'"), 'unlabelled location speeds reserve the same alignment space as qualified boards');
assert.ok(app.includes("storageAdapter.set('locationQuizStats:v1'"), 'location-quiz results use their own local statistics store');
assert.ok(app.includes('renderLocationQuizSummary'), 'location quizzes provide results and mistake review');
const styles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
assert.ok(styles.includes('-webkit-text-size-adjust:100%'), 'mobile text scaling stays at the intended layout size');
assert.match(styles, /\.rk-input\{[\s\S]*?font-size:16px;/, 'quiz inputs avoid iOS focus zoom');
const rangeCommit = app.slice(app.indexOf('const commitAnswer = () =>'), app.indexOf("input.addEventListener('blur', commitAnswer)"));
assert.ok(rangeCommit.indexOf('nextInput.focus()') < rangeCommit.indexOf('row.replaceChildren(makeResultChip())'), 'mobile quiz focus transfers before the submitted input is replaced');
for(const asset of ['styles.css','js/app.js','js/route-data.js','js/study-data.js','js/map-data.js','js/map-restrictions.js','js/storage.js','js/progress-sync.js','js/coverage-recovery.js']){
  assert.ok(worker.includes(`'./${asset}'`), `${asset} is in the app shell`);
}

console.log(`Validated ${expectedLines.length} directions, curated study boundaries, sync merging, accessibility, and PWA shell.`);
