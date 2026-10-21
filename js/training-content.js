// Controlled, human-reviewable training content.
//
// Keep operational content in this file instead of embedding it in UI code.
// Copilot may help add or format records, but an authorised reviewer must
// verify every record before `status` is changed to `approved`.

export const SPEED_BOARD_PHOTOS = [
  {
    id:'outer-harbor-shared-down-80-km-6-050',
    status:'approved',
    lines:['outer_harbor','grange','port_dock'],
    direction:'down',
    km:6.050,
    speed:80,
    src:'./images/speed-boards/outer-harbor-shared-down-80-km-6-050.jpg',
    fullSrc:'./images/speed-boards/outer-harbor-shared-down-80-km-6-050-full.jpg',
    alt:'Driver view of the 80 km/h Down speed board between Kilkenny and Woodville Park',
    caption:'Driver view · Kilkenny to Woodville Park',
    route:'Kilkenny → Woodville Park',
    source:'User-supplied training photograph',
    effectiveDate:null,
    reviewedBy:'Project owner',
    reviewedDate:'2026-08-30'
  }
];

// Reserved for future clickable signal markers. Draft records must not be
// exposed to learners. See the Copilot handover guide for the required fields.
export const SIGNAL_LOCATIONS = [];

// Reserved for future operational scenarios. Only `approved` records may be
// rendered by a future scenario engine.
export const TRAINING_SCENARIOS = [];
