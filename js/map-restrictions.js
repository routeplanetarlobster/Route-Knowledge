// Operational conditions shown on the Speed Map only. These cap the set
// addenda speed; they never raise a lower permanent speed and are deliberately
// kept out of Track Speeds and quizzes.
export const SPEED_MAP_OPERATIONAL_RESTRICTIONS = [
  {
    id: 'adelaide-yard-35',
    lines: ['gawler', 'outer_harbor', 'grange', 'port_dock'],
    directions: ['down', 'up'],
    fromKm: 0.633,
    toKm: 1.380,
    speed: 35,
    location: 'GM & OM Adelaide Yard',
    source: 'Train Notice 238 — 26 August 2026'
  }
];

export function applyOperationalRestrictions(intervals, line, direction, restrictions = SPEED_MAP_OPERATIONAL_RESTRICTIONS){
  const applicable = restrictions.filter(restriction =>
    restriction.lines.includes(line) && restriction.directions.includes(direction)
  );
  if(!applicable.length) return intervals;

  return intervals.flatMap(interval => {
    const cuts = new Set([interval.lo, interval.hi]);
    applicable.forEach(restriction => {
      if(restriction.fromKm > interval.lo && restriction.fromKm < interval.hi) cuts.add(restriction.fromKm);
      if(restriction.toKm > interval.lo && restriction.toKm < interval.hi) cuts.add(restriction.toKm);
    });

    const points = [...cuts].sort((a, b) => a - b);
    const pieces = [];
    for(let index = 0; index < points.length - 1; index++){
      const lo = points[index], hi = points[index + 1], midpoint = (lo + hi) / 2;
      const restriction = applicable.find(item => midpoint >= item.fromKm && midpoint <= item.toKm);
      const descending = interval.startKm > interval.endKm;
      const startKm = descending ? hi : lo;
      const startsAtSourcePoint = Math.abs(startKm - interval.startKm) < 1e-6;
      const restrictionBoundary = applicable.find(item =>
        Math.abs(startKm - item.fromKm) < 1e-6 || Math.abs(startKm - item.toKm) < 1e-6
      ) || null;
      pieces.push({
        ...interval,
        speed: restriction ? Math.min(interval.speed, restriction.speed) : interval.speed,
        startKm,
        endKm: descending ? lo : hi,
        lo,
        hi,
        comment: startsAtSourcePoint ? interval.comment : null,
        row: startsAtSourcePoint ? interval.row : null,
        approximate: startsAtSourcePoint ? interval.approximate : false,
        mapReference: startsAtSourcePoint ? interval.mapReference : null,
        operationalRestriction: restriction || null,
        restrictionBoundary
      });
    }
    return interval.startKm > interval.endKm ? pieces.reverse() : pieces;
  });
}

// Produce one numbered bubble for each speed that actually begins on the
// rendered map. This keeps marker positions aligned after an operational cap
// splits or masks a permanent-speed interval.
export function effectiveSpeedMarkers(intervals){
  return intervals.filter((interval, index) => {
    if(index === 0) return true;
    const previous = intervals[index - 1];
    const contiguous = Math.abs(previous.endKm - interval.startKm) < 1e-6;
    return !contiguous || previous.speed !== interval.speed;
  }).map(interval => ({...interval, plotKm:interval.startKm}));
}
