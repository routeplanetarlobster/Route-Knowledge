// One-time compatibility logic for the temporary v2.0 quiz derivation. It uses
// only keys shared by v2.0 and the restored study plan as evidence, so deleted
// attempts are never invented and partial directions remain partial.

const NON_STATION_LABEL = /^(?:buffer|point\b|points\b|gawler platform|port dock loop|neutral section)/i;

function v2Point(row, index){
  const raw = String(row.label || '').trim();
  const isStation = raw && !NON_STATION_LABEL.test(raw);
  if(isStation){
    return raw
      .replace(/^Adelaide Showground$/i, 'Showgrounds')
      .replace(/^Noarlunga Centre$/i, 'Noarlunga')
      .replace(/\s+(?:Up|Down)$/i, '');
  }
  if(raw) return `(${raw})`;
  return row.km == null ? `(speed change ${index + 1})` : `km ${Number(row.km).toFixed(3)}`;
}

function deriveTemporaryV2Segments(lineId, rows){
  const lastStationIndex = rows.reduce((found, row, index) => {
    const raw = String(row.label || '').trim();
    return raw && !NON_STATION_LABEL.test(raw) ? index : found;
  }, -1);
  const segments = [];
  let previousPoint = null;
  let lastStationPoint = null;
  let activeSpeed = null;
  let terminalPoint = null;

  rows.forEach((row, index) => {
    let point = v2Point(row, index);
    let namedPoint = !point.startsWith('(') && !point.toLowerCase().startsWith('km ');
    if(lineId.endsWith('_up') && index === lastStationIndex && index < rows.length - 1){
      terminalPoint = point;
      point = `(${point} approach)`;
      namedPoint = false;
    }
    if(namedPoint) lastStationPoint = point;
    if(activeSpeed != null && previousPoint && previousPoint !== point){
      segments.push({from:previousPoint, to:point, speed:String(activeSpeed)});
    }
    const startsSpeedSequence = activeSpeed == null && row.speed != null;
    if(row.speed != null){
      if(startsSpeedSequence && lastStationPoint) previousPoint = lastStationPoint;
      activeSpeed = Number(row.speed);
    }
    if(!(startsSpeedSequence && lastStationPoint) && (activeSpeed != null || namedPoint)) previousPoint = point;
  });
  if(terminalPoint && activeSpeed != null && previousPoint && previousPoint !== terminalPoint){
    segments.push({from:previousPoint, to:terminalPoint, speed:String(activeSpeed)});
  }
  return segments;
}

function isNamedStation(name){
  return Boolean(name) && !name.toLowerCase().startsWith('km ') && !name.includes('(');
}

function pairKeys(lineId, segments){
  if(!segments.length) return [];
  const points = [segments[0].from, ...segments.map(segment => segment.to)];
  const namedIndexes = points.map((point, index) => isNamedStation(point) ? index : -1).filter(index => index >= 0);
  const keys = [];
  for(let pairIndex=0; pairIndex<namedIndexes.length-1; pairIndex++){
    const start = namedIndexes[pairIndex];
    const end = namedIndexes[pairIndex + 1];
    const speeds = [];
    for(let index=start; index<end; index++){
      const speed = segments[index].speed;
      if(speeds.at(-1) !== speed) speeds.push(speed);
    }
    speeds.forEach((speed, index) => keys.push(`${lineId}::${points[start]}→${points[end]}::${index}`));
  }
  return keys;
}

export function v2CoverageWitnessKeys(lineId, trackRows, studySegments){
  const current = new Set(pairKeys(lineId, studySegments || []));
  return pairKeys(lineId, deriveTemporaryV2Segments(lineId, trackRows || []))
    .filter(key => current.has(key));
}

export function inferV2CompletedDirections(trackData, studyData, stats){
  const completed = [];
  Object.keys(studyData || {}).forEach(lineId => {
    const witnesses = v2CoverageWitnessKeys(lineId, trackData[lineId], studyData[lineId]);
    if(witnesses.length >= 5 && witnesses.every(key => Number(stats[key] && stats[key].attempts || 0) >= 1)){
      completed.push(lineId);
    }
  });
  return completed;
}
