function copy(value){
  return JSON.parse(JSON.stringify(value || {}));
}

export function mergePendingBatches(currentBatch, restoredBatch){
  const merged = copy(currentBatch);
  Object.entries(restoredBatch || {}).forEach(([key, incoming]) => {
    const current = merged[key] || {attempts:0, correct:0, stateAt:0};
    const attempts = Number(current.attempts || 0) + Number(incoming.attempts || 0);
    const correct = Number(current.correct || 0) + Number(incoming.correct || 0);
    if(Number(incoming.stateAt || 0) >= Number(current.stateAt || 0)) Object.assign(current, incoming);
    current.attempts = attempts;
    current.correct = correct;
    merged[key] = current;
  });
  return merged;
}

/** Merge per-direction coverage repairs without changing quiz accuracy data. */
export function mergeCoverageStates(localState, cloudState){
  const merged = copy(cloudState || {});
  Object.entries(localState || {}).forEach(([lineId, local]) => {
    const cloud = merged[lineId];
    if(!cloud || Number(local.stateAt || 0) >= Number(cloud.stateAt || 0)){
      merged[lineId] = {
        complete: Boolean(local.complete),
        stateAt: Number(local.stateAt || 0),
      };
    }
  });
  return merged;
}

/** Apply device-local deltas to the latest cloud snapshot inside a transaction. */
export function applyStatDeltas(cloudSnapshot, deltaBatch){
  const cloud = copy(cloudSnapshot);
  Object.entries(deltaBatch || {}).forEach(([key, delta]) => {
    if(delta.deleted){
      delete cloud[key];
      return;
    }
    const item = cloud[key] || {attempts:0, correct:0, box:1, nextDueAt:0};
    item.attempts = Number(item.attempts || 0) + Number(delta.attempts || 0);
    item.correct = Number(item.correct || 0) + Number(delta.correct || 0);
    if(Number(delta.stateAt || 0) >= Number(item.stateAt || item.lastAt || 0)){
      if(delta.lastAt != null) item.lastAt = delta.lastAt;
      if(delta.box != null) item.box = delta.box;
      if(delta.nextDueAt != null) item.nextDueAt = delta.nextDueAt;
      item.stateAt = delta.stateAt;
    }
    cloud[key] = item;
  });
  return cloud;
}
