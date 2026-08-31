import { ROUTE_DATA_VERSION, TRACK_SPEED_DATA, TRACK_SPEED_GROUPS } from './route-data.js';
import { STUDY_SEGMENTS } from './study-data.js';
import { SPEED_MAP_LINES, SPEED_MAP_META, SPEED_MAP_ANCHORS, SPEED_MAP_ORDER, SPEED_MAP_ADELAIDE_15_REFERENCE, SPEED_MAP_ADELAIDE_15_CACHE } from './map-data.js';
import { applyOperationalRestrictions, effectiveSpeedMarkers } from './map-restrictions.js';
import { storageAdapter } from './storage.js';
import { applyStatDeltas, mergePendingBatches, mergeCoverageStates } from './progress-sync.js';
import { inferV2CompletedDirections } from './coverage-recovery.js';

(function(){
  const LINES = [
    {id:'gawler_down', name:'Gawler Line', hue:'#e8636b', direction:'Down'},
    {id:'gawler_up', name:'Gawler Line', hue:'#e8636b', direction:'Up'},
    {id:'grange_down', name:'Grange Line', hue:'#29c4e0', direction:'Down'},
    {id:'grange_up', name:'Grange Line', hue:'#29c4e0', direction:'Up'},
    {id:'outerharbor_down', name:'Outer Harbor Line', hue:'#29c4e0', direction:'Down'},
    {id:'outerharbor_up', name:'Outer Harbor Line', hue:'#29c4e0', direction:'Up'},
    {id:'portdock_down', name:'Port Dock Line', hue:'#29c4e0', direction:'Down'},
    {id:'portdock_up', name:'Port Dock Line', hue:'#29c4e0', direction:'Up'},
    {id:'seaford_down', name:'Seaford Line', hue:'#e8a830', direction:'Down'},
    {id:'seaford_up', name:'Seaford Line', hue:'#e8a830', direction:'Up'},
    {id:'belair_down', name:'Belair Line', hue:'#44b87f', direction:'Down'},
    {id:'belair_up', name:'Belair Line', hue:'#44b87f', direction:'Up'},
    {id:'tonsley_down', name:'Flinders Line', hue:'#e8a830', direction:'Down'},
    {id:'tonsley_up', name:'Flinders Line', hue:'#e8a830', direction:'Up'},
  ];

  // Physical board photographs are intentionally opt-in. A marker only shows
  // a photo when an exact line, direction, speed and source kilometre match is
  // present here, so incomplete photographic coverage never creates clutter.
  const SPEED_BOARD_PHOTOS = [
    {
      lines:['outer_harbor','grange','port_dock'],
      direction:'down',
      km:6.050,
      speed:80,
      src:'./images/speed-boards/outer-harbor-shared-down-80-km-6-050.jpg',
      fullSrc:'./images/speed-boards/outer-harbor-shared-down-80-km-6-050-full.jpg',
      alt:'Driver view of the 80 km/h Down speed board between Kilkenny and Woodville Park',
      caption:'Driver view · Kilkenny to Woodville Park',
      route:'Kilkenny → Woodville Park'
    }
  ];

  let activeLine = LINES[0].id;
  let selectedLineGroup = LINES[0].name;
  let quizModeType = null; // null | 'segment' | 'range' | 'locations'
  let quizRecallType = 'speeds'; // 'speeds' keeps the original quiz; 'locations' reverses the recall
  let quizRangeGuesses = {}; // pairKey -> array of per-box guess strings
  let quizRangeBoxChecked = {}; // pairKey -> array of booleans
  let quizRangeRecorded = {}; // pairKey -> array of booleans (has this box's stat attempt already been logged?)
  let quizRangeHintUsed = false; // one hint per whole line quiz session
  let quizRangeHintActive = null; // { pairKey, index } of the box currently showing the hint choice, or null
  let quizRangeHintFlag = {}; // pairKey -> array of booleans (was this specific box resolved via hint?)
  let quizRetryKeys = null; // Set of pair/index keys when retrying only mistakes
  let locationQuizState = null; // independent reverse-recall session; never contributes to route coverage
  let locationQuizStats = {}; // locationKey -> { attempts, correct, lastAt }, stored separately from speed stats
  let locationQuizStatsLoaded = false;
  let mysteryRound = null; // { lineId, lineLabel, fromLabel, toLabel, values: [{value,note,boxFrom,boxTo}], guesses: [], checked: [] }
  let statsData = {}; // statKey -> { attempts, correct, lastAt }
  let statsReconciled = false; // prune saved review keys that no longer exist after route-data updates
  let statsLoaded = false;
  let coverageState = {}; // lineId -> { complete, stateAt }; independent from accuracy
  let coverageLoaded = false;
  let coverageAutoRecoveryChecked = false;
  let activeView = 'home';
  let focusRound = null; // [{ lineId, lineLabel, from, to, value, note, key }]
  let focusGuesses = [];
  let focusChecked = [];
  let focusRecorded = [];
  let focusHintUsed = false;
  let focusHintActiveIndex = null;
  let focusHintFlags = [];
  let journeyState = null; // { lineId, lineLabel, pairs, index, guesses: [], checked: [] }
  let journeyPickerGroup = null;
  let focusQuizOrigin = 'progress'; // 'progress' | 'review'
  let comparePickerGroup = null;
  let hideSpeeds = true;
  let showLineHeatmap = false;
  let heatmapExpanded = {};
  let showByLineExpanded = false;
  let segCache = {}; // lineId -> array

  const root = document.getElementById('rk-root');
  const tabsEl = document.getElementById('rk-tabs');
  const bodyEl = document.getElementById('rk-body');
  const menuBtn = document.getElementById('rk-menu-btn');
  const menuDropdown = document.getElementById('rk-menu-dropdown');
  const navRow = document.getElementById('rk-nav-row');
  const lineSelect = document.getElementById('rk-line-select');
  const dirToggle = document.getElementById('rk-dir-toggle');
  const importFileInput = document.getElementById('rk-import-file');
  const accountBtn = document.getElementById('rk-account-btn');
  const accountNameEl = document.getElementById('rk-account-name');
  const accountDropdown = document.getElementById('rk-account-dropdown');
  const syncDotEl = document.getElementById('rk-sync-dot');
  const authOverlay = document.getElementById('rk-auth-overlay');
  const authForm = document.getElementById('rk-auth-form');
  const authUsernameInput = document.getElementById('rk-auth-username');
  const authPasswordInput = document.getElementById('rk-auth-password');
  const authSubmitBtn = document.getElementById('rk-auth-submit');
  const authModeBtn = document.getElementById('rk-auth-mode');
  const authLocalBtn = document.getElementById('rk-auth-local');
  const authMessageEl = document.getElementById('rk-auth-message');
  const authSubtitleEl = document.getElementById('rk-auth-subtitle');
  const authLoadingEl = document.getElementById('rk-auth-loading');
  const authLoadingTextEl = document.getElementById('rk-auth-loading-text');
  const choiceOverlay = document.getElementById('rk-choice-overlay');
  const choiceTitleEl = document.getElementById('rk-choice-title');
  const choiceMessageEl = document.getElementById('rk-choice-message');
  const choicePrimaryBtn = document.getElementById('rk-choice-primary');
  const choiceSecondaryBtn = document.getElementById('rk-choice-secondary');
  const pwaOverlay = document.getElementById('rk-pwa-overlay');
  const pwaTitleEl = document.getElementById('rk-pwa-title');
  const pwaMessageEl = document.getElementById('rk-pwa-message');
  const pwaStepsEl = document.getElementById('rk-pwa-steps');
  const pwaActionBtn = document.getElementById('rk-pwa-action');
  const pwaCloseBtn = document.getElementById('rk-pwa-close');
  const pwaStatusEl = document.getElementById('rk-pwa-status');
  const pwaUpdateEl = document.getElementById('rk-pwa-update');
  const pwaUpdateBtn = document.getElementById('rk-pwa-update-btn');
  let deferredInstallPrompt = null;
  let pwaRegistration = null;
  let speedMapLine = 'gawler';
  let speedMapDirection = 'down';
  let speedMapBasemap = 'map'; // 'map' | 'satellite'
  let speedMapInstance = null;
  let trackSpeedsDir = 'seaford_down';

  // Firebase account + cloud progress sync
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyAlkFq1LOQcDm8ipGFG10JmHwtpHolDp1A",
    authDomain: "adelaide-route-knowledge.firebaseapp.com",
    projectId: "adelaide-route-knowledge",
    storageBucket: "adelaide-route-knowledge.firebasestorage.app",
    messagingSenderId: "501631841892",
    appId: "1:501631841892:web:22a379775f7157852d1171"
  };
  const RK_INTERNAL_EMAIL_DOMAIN = 'routeknowledge.app';
  let firebaseApp = null;
  let firebaseSdk = null;
  let firebaseInitPromise = null;
  let firebaseAuth = null;
  let firestoreDb = null;
  let currentFirebaseUser = null;
  let currentUsername = '';
  let cloudSyncState = 'idle'; // idle | syncing | synced | error
  let authMode = 'login'; // login | register
  let cloudWriteTimer = null;
  let localModeChosen = localStorage.getItem('rk:localMode') === '1';
  let pendingStatDeltas = {};
  try{ pendingStatDeltas = JSON.parse(localStorage.getItem('rk:pendingStatDeltas') || '{}') || {}; }catch(e){ pendingStatDeltas = {}; }

  function persistPendingStatDeltas(){
    localStorage.setItem('rk:pendingStatDeltas', JSON.stringify(pendingStatDeltas));
  }

  function queueStatDelta(key, change){
    const current = pendingStatDeltas[key] || {attempts:0, correct:0, stateAt:0};
    const attempts = Number(current.attempts || 0) + Number(change.attempts || 0);
    const correct = Number(current.correct || 0) + Number(change.correct || 0);
    if(Number(change.stateAt || 0) >= Number(current.stateAt || 0)){
      Object.assign(current, change);
    }
    if(change.deleted !== true) current.deleted = false;
    current.attempts = attempts;
    current.correct = correct;
    pendingStatDeltas[key] = current;
    persistPendingStatDeltas();
  }

  const externalAssets = new Map();
  function loadScript(src){
    if(externalAssets.has(src)) return externalAssets.get(src);
    const task = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(script);
    });
    externalAssets.set(src, task);
    return task;
  }

  function loadStylesheet(href){
    if(externalAssets.has(href)) return externalAssets.get(href);
    const task = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = resolve;
      link.onerror = () => reject(new Error('Could not load ' + href));
      document.head.appendChild(link);
    });
    externalAssets.set(href, task);
    return task;
  }

  async function loadFirebaseSdk(){
    if(firebaseSdk) return firebaseSdk;
    await loadScript('https://www.gstatic.com/firebasejs/12.17.1/firebase-app-compat.js');
    await Promise.all([
      loadScript('https://www.gstatic.com/firebasejs/12.17.1/firebase-auth-compat.js'),
      loadScript('https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore-compat.js'),
    ]);
    firebaseSdk = window.firebase;
    return firebaseSdk;
  }

  async function loadMapLibre(){
    await Promise.all([
      loadStylesheet('https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.css'),
      loadScript('https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.js'),
    ]);
    return window.maplibregl;
  }

  const NETWORK_TREE = [
    { type:'line', name:'Gawler Line', lineId:'gawler_down' },
    { type:'line', role:'trunk', name:'Outer Harbor Line', lineId:'outerharbor_down', children: [
        { type:'junction', name:'Woodville', children: [
            { type:'line', name:'Grange Line', lineId:'grange_down' },
        ]},
        { type:'junction', name:'Alberton', children: [
            { type:'line', name:'Port Dock Line', lineId:'portdock_down' },
        ]},
    ]},
    { type:'line', role:'trunk', name:'Seaford Line', lineId:'seaford_down', children: [
        { type:'junction', name:'Goodwood', children: [
            { type:'line', name:'Belair Line', lineId:'belair_down' },
        ]},
        { type:'junction', name:'Tonsley (before Ascot Park)', children: [
            { type:'line', name:'Flinders Line', lineId:'tonsley_down' },
        ]},
    ]},
  ];

  function lineColor(lineId){
    const l = LINES.find(x => x.id === lineId);
    return l ? l.hue : '#8b93a1';
  }

  // Combines Down + Up stats under one line NAME (e.g. "Gawler Line"), since the
  // network diagram shows one physical line, not separate branches per direction.
  function computeLineNameStats(){
    const byName = {};
    Object.keys(statsData).forEach(k => {
      const { lineId } = parseStatKey(k);
      const s = statsData[k];
      const lineObj = LINES.find(l => l.id === lineId);
      if(!lineObj) return;
      const name = lineObj.name;
      if(!byName[name]) byName[name] = { attempts: 0, correct: 0 };
      byName[name].attempts += s.attempts;
      byName[name].correct += s.correct;
    });
    const result = {};
    Object.entries(byName).forEach(([name, v]) => {
      result[name] = { attempts: v.attempts, correct: v.correct, pct: v.attempts > 0 ? Math.round((v.correct / v.attempts) * 100) : null };
    });
    return result;
  }

  function accuracyColor(pct){
    if(pct === null || pct === undefined) return null;
    if(pct < 60) return 'var(--red)';
    if(pct < 85) return 'var(--yellow)';
    return 'var(--green)';
  }

  async function renderLineHeatmap(segs, line){
    await loadStatsIfNeeded();
    const pairs = computeRangePairs(segs);
    const wrap = document.createElement('div');
    wrap.className = 'rk-net-tree';
    addSectionHeader(wrap, 'Accuracy Map \u2014 ' + line.name + (line.direction ? ' \u2014 ' + line.direction : ''));

    if(pairs.length === 0){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.innerHTML = '<div class="big">Not enough data yet</div>Add named-station segments to this line to see an accuracy map.';
      wrap.appendChild(empty);
      bodyEl.appendChild(wrap);
      return;
    }

    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex; gap:14px; flex-wrap:wrap; margin-bottom:16px; font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--muted);';
    [
      { color: 'var(--green)', label: '85%+' },
      { color: 'var(--yellow)', label: '60\u201384%' },
      { color: 'var(--red)', label: 'Under 60%' },
      { color: 'var(--steel)', label: 'Not attempted' },
    ].forEach(it => {
      const item = document.createElement('span');
      item.style.cssText = 'display:flex; align-items:center; gap:5px;';
      item.innerHTML = '<span style="width:9px; height:9px; border-radius:50%; background:' + it.color + '; display:inline-block;"></span>' + it.label;
      legend.appendChild(item);
    });
    wrap.appendChild(legend);

    const track = document.createElement('div');
    track.className = 'rk-track';

    pairs.forEach(pair => {
      let attempts = 0, correct = 0;
      const perSpeed = pair.speeds.map((sp, i) => {
        const key = statKey(line.id, pair.from, pair.to, i);
        const s = statsData[key];
        if(s){ attempts += s.attempts; correct += s.correct; }
        const spPct = s && s.attempts > 0 ? Math.round((s.correct / s.attempts) * 100) : null;
        return { value: sp.value, note: sp.note, pct: spPct, attempts: s ? s.attempts : 0, correct: s ? s.correct : 0 };
      });
      const pct = attempts > 0 ? Math.round((correct / attempts) * 100) : null;
      const heatColor = pct === null ? 'var(--steel)' : accuracyColor(pct);
      const expandKey = line.id + '::' + pair.key;
      const isExpanded = !!heatmapExpanded[expandKey];

      const card = document.createElement('div');
      card.className = 'rk-seg';
      card.style.setProperty('--line-hue', heatColor);
      card.style.cursor = 'pointer';
      card.title = isExpanded ? 'Tap to collapse' : 'Tap to reveal the speeds in this stretch';
      card.onclick = () => { heatmapExpanded[expandKey] = !isExpanded; renderBody(); };

      const top = document.createElement('div');
      top.className = 'rk-seg-top';
      const left = document.createElement('div');
      left.style.flex = '1';
      const stations = document.createElement('div');
      stations.className = 'rk-stations';
      stations.innerHTML = escapeHtml(pair.from) + '<span class="arrow">\u2192</span>' + escapeHtml(pair.to) + (pair.speeds.length > 1 ? ' <span style="font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--muted); font-weight:400;">' + (isExpanded ? '\u25b4' : '\u25be') + '</span>' : '');
      left.appendChild(stations);
      top.appendChild(left);

      if(pct !== null){
        const badge = document.createElement('div');
        badge.className = 'rk-board';
        badge.style.background = heatColor;
        badge.style.color = '#0d1410';
        badge.innerHTML = pct + '%<span class="u">' + correct + '/' + attempts + '</span>';
        top.appendChild(badge);
      } else {
        const badge = document.createElement('span');
        badge.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--muted);';
        badge.textContent = 'no attempts yet';
        top.appendChild(badge);
      }

      card.appendChild(top);

      if(isExpanded){
        const speedRow = document.createElement('div');
        speedRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; margin-top:12px;';
        perSpeed.forEach(sp => {
          const spColor = sp.pct === null ? 'var(--steel)' : accuracyColor(sp.pct);
          const chip = document.createElement('div');
          chip.style.cssText = 'background:' + spColor + '; color:#0d1410; border-radius:6px; padding:6px 10px; text-align:center; min-width:64px;';
          chip.innerHTML = '<div style="font-family:\'DM Sans\',sans-serif; font-weight:600; font-size:15px;">' + sp.value + '</div>' +
            '<div style="font-family:\'JetBrains Mono\',monospace; font-size:9px;">' + (sp.pct !== null ? sp.pct + '% (' + sp.correct + '/' + sp.attempts + ')' : 'untested') + '</div>';
          if(sp.note){
            const noteEl = document.createElement('div');
            noteEl.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-size:9px; margin-top:2px; opacity:0.85;';
            noteEl.textContent = sp.note;
            chip.appendChild(noteEl);
          }
          speedRow.appendChild(chip);
        });
        card.appendChild(speedRow);
      }

      track.appendChild(card);
    });

    wrap.appendChild(track);
    bodyEl.appendChild(wrap);
  }

  function buildNetNode(node, lineNameStats){
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'rk-net-row';
    if(node.type === 'line'){
      const stat = lineNameStats[node.name];
      const heatColor = stat ? accuracyColor(stat.pct) : null;
      const btn = document.createElement('button');
      btn.className = 'rk-net-line-btn';
      if(node.role === 'trunk') btn.classList.add('rk-net-trunk-btn');
      btn.style.setProperty('--line-hue', lineColor(node.lineId));
      btn.style.borderLeftColor = heatColor || lineColor(node.lineId);
      btn.style.display = 'flex';
      btn.style.alignItems = 'center';
      btn.style.justifyContent = 'space-between';
      btn.style.gap = '10px';
      if(heatColor){
        btn.style.background = 'color-mix(in srgb, ' + heatColor + ' 10%, transparent)';
      }
      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'display:flex; align-items:center; gap:8px;';
      const dot = document.createElement('span');
      dot.style.cssText = 'width:8px; height:8px; border-radius:50%; background:' + lineColor(node.lineId) + '; flex-shrink:0; display:inline-block;';
      nameSpan.appendChild(dot);
      const nameText = document.createElement('span');
      nameText.textContent = node.name;
      nameSpan.appendChild(nameText);
      btn.appendChild(nameSpan);
      if(stat && stat.pct !== null){
        const badge = document.createElement('span');
        badge.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-size:12px; font-weight:600; color:' + heatColor + '; white-space:nowrap;';
        badge.textContent = stat.pct + '%';
        btn.appendChild(badge);
      }
      btn.onclick = () => {
        activeLine = node.lineId;
        const l = LINES.find(x => x.id === node.lineId);
        if(l) selectedLineGroup = l.name;
        closeAllViews();
        renderTabs();
        renderBody();
      };
      row.appendChild(btn);
    } else {
      const label = document.createElement('span');
      label.className = 'rk-net-junction-label';
      label.textContent = node.name + ' junction';
      row.appendChild(label);
    }
    wrap.appendChild(row);
    if(node.children){
      const childWrap = document.createElement('div');
      childWrap.className = 'rk-net-node';
      node.children.forEach(c => childWrap.appendChild(buildNetNode(c, lineNameStats)));
      wrap.appendChild(childWrap);
    }
    return wrap;
  }

  async function renderNetworkOverview(){
    await loadStatsIfNeeded();
    const lineNameStats = computeLineNameStats();
    const container = document.createElement('div');
    container.className = 'rk-net-tree';
    addSectionHeader(container, 'Network Overview');

    const hub = document.createElement('div');
    hub.className = 'rk-net-hub';
    hub.textContent = 'ADELAIDE';
    container.appendChild(hub);

    const rootWrap = document.createElement('div');
    rootWrap.className = 'rk-net-node';
    NETWORK_TREE.forEach(n => rootWrap.appendChild(buildNetNode(n, lineNameStats)));
    container.appendChild(rootWrap);

    const note = document.createElement('p');
    note.style.cssText = 'margin-top:20px; font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--muted); line-height:1.6;';
    note.textContent = 'Schematic only \u2014 not to scale, and not the official Adelaide Metro map. Colored by your accuracy (Down + Up combined); the small dot keeps each line\u2019s usual color. Click a line to open it.';
    container.appendChild(note);

    bodyEl.appendChild(container);
  }

  function closeAllViews(){
    activeView = 'lines';
    if(speedMapInstance){ try{ speedMapInstance.remove(); }catch(e){} speedMapInstance = null; }
    showLineHeatmap = false;
    exitQuiz();
  }

  function closeMenu(){
    menuDropdown.style.display = 'none';
    menuBtn.setAttribute('aria-expanded', 'false');
  }

  function currentViewId(){
    if(activeView === 'focus') return focusQuizOrigin === 'review' ? 'review' : (focusQuizOrigin === 'home' ? 'home' : 'progress');
    return activeView;
  }

  function isPwaStandalone(){
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isIOSDevice(){
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function showPwaStatus(message, offline=false){
    if(!pwaStatusEl) return;
    pwaStatusEl.textContent = message;
    pwaStatusEl.className = 'rk-pwa-status show' + (offline ? ' offline' : '');
    clearTimeout(showPwaStatus._timer);
    showPwaStatus._timer = setTimeout(() => {
      pwaStatusEl.className = 'rk-pwa-status' + (offline ? ' offline' : '');
    }, 3200);
  }

  async function openPwaInstall(){
    if(isPwaStandalone()){
      showPwaStatus('Route Knowledge is already installed');
      return;
    }

    pwaOverlay.classList.add('show');
    pwaStepsEl.innerHTML = '';

    if(deferredInstallPrompt){
      pwaTitleEl.textContent = 'Install Route Knowledge';
      pwaMessageEl.textContent = 'Install the app for a full-screen experience and faster repeat loading.';
      pwaActionBtn.textContent = 'Install';
      pwaActionBtn.style.display = 'block';
      pwaActionBtn.onclick = async () => {
        const prompt = deferredInstallPrompt;
        deferredInstallPrompt = null;
        pwaOverlay.classList.remove('show');
        try{
          await prompt.prompt();
          await prompt.userChoice;
        }catch(e){}
      };
      return;
    }

    if(isIOSDevice()){
      pwaTitleEl.textContent = 'Install Route Knowledge';
      pwaMessageEl.textContent = 'On iPhone or iPad, install it from Safari:';
      ['Tap the Share button in Safari.', 'Choose “Add to Home Screen”.', 'Tap Add.'].forEach(t => {
        const li = document.createElement('li'); li.textContent = t; pwaStepsEl.appendChild(li);
      });
      pwaActionBtn.style.display = 'none';
      return;
    }

    pwaTitleEl.textContent = 'Install Route Knowledge';
    pwaMessageEl.textContent = 'Use your browser menu and choose “Install app” or “Add to Home screen”.';
    pwaActionBtn.style.display = 'none';
  }

  pwaCloseBtn.onclick = () => pwaOverlay.classList.remove('show');
  pwaOverlay.addEventListener('click', e => {
    if(e.target === pwaOverlay) pwaOverlay.classList.remove('show');
  });

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    pwaOverlay.classList.remove('show');
    showPwaStatus('Route Knowledge installed');
  });

  function updateOnlineState(){
    if(navigator.onLine){
      if(pwaStatusEl) pwaStatusEl.className = 'rk-pwa-status';
      if(currentFirebaseUser) setTimeout(() => syncProgressWithCloud(false), 500);
    }else{
      showPwaStatus('Offline — progress will save on this device', true);
    }
  }
  window.addEventListener('online', updateOnlineState);
  window.addEventListener('offline', updateOnlineState);

  function showPwaUpdate(reg){
    pwaRegistration = reg;
    if(reg && reg.waiting) pwaUpdateEl.classList.add('show');
  }

  pwaUpdateBtn.onclick = () => {
    if(pwaRegistration && pwaRegistration.waiting){
      pwaRegistration.waiting.postMessage({type:'SKIP_WAITING'});
    }
  };

  async function registerRouteKnowledgePwa(){
    if(!('serviceWorker' in navigator)) return;
    try{
      const reg = await navigator.serviceWorker.register('./sw.js', {scope:'./'});
      pwaRegistration = reg;

      if(reg.waiting && navigator.serviceWorker.controller) showPwaUpdate(reg);

      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if(!worker) return;
        worker.addEventListener('statechange', () => {
          if(worker.state === 'installed' && navigator.serviceWorker.controller){
            showPwaUpdate(reg);
          }
        });
      });

      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if(reloading) return;
        reloading = true;
        location.reload();
      });
    }catch(e){
      console.warn('PWA service worker registration failed', e);
    }
  }

  function renderMenu(){
    menuDropdown.innerHTML = '';
    const anyAltView = activeView !== 'lines';
    const activeId = currentViewId();

    const version = document.createElement('div');
    version.className = 'rk-account-menu-note';
    version.innerHTML = '<strong>Route data v' + escapeHtml(ROUTE_DATA_VERSION) + '</strong>Curated quizzes · full addenda in Track Speeds';
    menuDropdown.appendChild(version);

    if(anyAltView && activeView !== 'home'){
      const backItem = document.createElement('button');
      backItem.className = 'rk-menu-item back-item';
      backItem.textContent = '\u2190 Back to lines';
      backItem.onclick = () => { closeAllViews(); closeMenu(); renderBody(); };
      menuDropdown.appendChild(backItem);
    }

    const items = [
      { id: 'speedmap', label: 'Speed Map', action: () => { closeAllViews(); activeView = 'speedmap'; } },
      { id: 'track', label: 'Track Speeds', action: () => { closeAllViews(); activeView = 'track'; } },
      { id: 'journey', label: 'Journey', action: () => { closeAllViews(); activeView = 'journey'; journeyState = null; } },
      { id: 'compare', label: 'Compare Directions', action: () => { closeAllViews(); activeView = 'compare'; } },
      ...(!currentFirebaseUser ? [{ id: 'account', label: 'Sign in / Create account', action: () => { openAuthOverlay(); } }] : []),
      ...(!isPwaStandalone() ? [{ id: 'install', label: 'Install Route Knowledge', action: () => { openPwaInstall(); } }] : []),
      { id: 'export', label: 'Export Progress', action: () => { exportAllData(); } },
      { id: 'import', label: 'Import Progress', action: () => { importFileInput.click(); } },
    ];
    items.forEach(item => {
      const btn = document.createElement('button');
      const isActive = item.id === activeId;
      btn.className = 'rk-menu-item' + (isActive ? ' active-view' : '');
      btn.textContent = (isActive ? '\u2713 ' : '') + item.label;
      btn.onclick = () => {
        item.action();
        closeMenu();
        renderBody();
      };
      menuDropdown.appendChild(btn);
    });
  }

  menuBtn.onclick = (e) => {
    e.stopPropagation();
    const willOpen = menuDropdown.style.display === 'none';
    if(willOpen) renderMenu();
    menuDropdown.style.display = willOpen ? 'block' : 'none';
    menuBtn.setAttribute('aria-expanded', String(willOpen));
  };
  document.addEventListener('click', (e) => {
    if(menuDropdown.style.display !== 'none' && !menuDropdown.contains(e.target) && e.target !== menuBtn){
      closeMenu();
    }
  });

  function setCloudSyncState(state){
    cloudSyncState = state;
    if(!syncDotEl) return;
    syncDotEl.className = 'rk-sync-dot' + (state === 'synced' ? ' synced' : state === 'syncing' ? ' syncing' : state === 'error' ? ' error' : '');
    syncDotEl.title = state === 'synced' ? 'Progress synced' : state === 'syncing' ? 'Syncing progress' : state === 'error' ? 'Cloud sync problem — progress remains saved on this device' : 'Cloud sync';
  }

  function closeAccountMenu(){
    if(accountDropdown) accountDropdown.style.display = 'none';
    accountBtn.setAttribute('aria-expanded', 'false');
  }

  function renderAccountMenu(){
    if(!accountDropdown) return;
    accountDropdown.innerHTML = '';

    const info = document.createElement('div');
    info.className = 'rk-account-menu-note';
    const statusText = cloudSyncState === 'synced' ? 'Progress synced' :
                       cloudSyncState === 'syncing' ? 'Syncing progress…' :
                       cloudSyncState === 'error' ? 'Cloud sync unavailable — local copy is safe' : 'Signed in';
    info.innerHTML = '<strong>' + escapeHtml(currentUsername || 'Account') + '</strong>' + escapeHtml(statusText);
    accountDropdown.appendChild(info);

    const sync = document.createElement('button');
    sync.className = 'rk-menu-item';
    sync.textContent = 'Sync progress now';
    sync.onclick = async () => {
      closeAccountMenu();
      await syncProgressWithCloud(true);
    };
    accountDropdown.appendChild(sync);

    const logout = document.createElement('button');
    logout.className = 'rk-menu-item';
    logout.textContent = 'Log out';
    logout.onclick = async () => {
      closeAccountMenu();
      localModeChosen = false;
      localStorage.removeItem('rk:localMode');
      try{ await firebaseAuth.signOut(); }catch(e){}
    };
    accountDropdown.appendChild(logout);
  }

  accountBtn.onclick = (e) => {
    e.stopPropagation();
    const opening = accountDropdown.style.display === 'none';
    closeMenu();
    if(opening) renderAccountMenu();
    accountDropdown.style.display = opening ? 'block' : 'none';
    accountBtn.setAttribute('aria-expanded', String(opening));
  };

  document.addEventListener('click', (e) => {
    if(accountDropdown && accountDropdown.style.display !== 'none' && !accountDropdown.contains(e.target) && e.target !== accountBtn){
      closeAccountMenu();
    }
  });

  async function loadStatsIfNeeded(){
    if(!statsLoaded){
      try{
        const res = await storageAdapter.get('stats:v1', false);
        statsData = res && res.value ? JSON.parse(res.value) : {};
      }catch(e){
        statsData = {};
      }
      statsLoaded = true;
    }
    await reconcileStatsWithCurrentData();
  }
  async function loadCoverageIfNeeded(){
    if(coverageLoaded) return;
    try{
      const res = await storageAdapter.get('coverage:v1', false);
      const parsed = res && res.value ? JSON.parse(res.value) : {};
      coverageState = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }catch(e){ coverageState = {}; }
    coverageLoaded = true;
  }
  async function writeLocalCoverageState(state){
    coverageState = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    coverageLoaded = true;
    await storageAdapter.set('coverage:v1', JSON.stringify(coverageState), false);
  }
  function parseCloudCoverage(data){
    try{
      const parsed = data && data.coverageStateJson ? JSON.parse(data.coverageStateJson) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }catch(e){ return {}; }
  }
  async function syncCoverageState(){
    await loadCoverageIfNeeded();
    const ref = cloudProgressRef();
    if(!ref) return true;
    setCloudSyncState('syncing');
    try{
      let merged = coverageState;
      await firestoreDb.runTransaction(async transaction => {
        const snap = await transaction.get(ref);
        merged = mergeCoverageStates(coverageState, snap.exists ? parseCloudCoverage(snap.data()) : {});
        transaction.set(ref, {
          coverageStateJson: JSON.stringify(merged),
          coverageUpdatedAtMs: Date.now(),
          updatedAt: firebaseSdk.firestore.FieldValue.serverTimestamp(),
          schemaVersion: 3,
        }, {merge:true});
      });
      await writeLocalCoverageState(merged);
      setCloudSyncState('synced');
      return true;
    }catch(e){
      console.error('Coverage sync failed', e);
      setCloudSyncState('error');
      return false;
    }
  }
  async function recoverCoverageAutomatically(){
    if(coverageAutoRecoveryChecked) return;
    coverageAutoRecoveryChecked = true;
    const recovered = inferV2CompletedDirections(TRACK_SPEED_DATA, STUDY_SEGMENTS, statsData);
    if(recovered.length === 0) return;
    const stateAt = Date.now();
    let changed = false;
    recovered.forEach(lineId => {
      if(!coverageState[lineId] || !coverageState[lineId].complete){
        coverageState[lineId] = {complete:true, stateAt};
        changed = true;
      }
    });
    if(changed){
      await writeLocalCoverageState(coverageState);
      await syncCoverageState();
    }
  }
  let saveStatsTimer = null;
  function saveStats(){
    // Local-first save: quizzes keep working even if reception drops out.
    // The same snapshot is then debounced to the signed-in Firebase account.
    if(saveStatsTimer) clearTimeout(saveStatsTimer);
    return new Promise(resolve => {
      saveStatsTimer = setTimeout(async () => {
        const updatedAtMs = Date.now();
        try{
          await storageAdapter.set('stats:v1', JSON.stringify(statsData), false);
          await storageAdapter.set('statsUpdatedAt', String(updatedAtMs), false);
        }catch(e){}
        scheduleCloudStatsSave(statsData, updatedAtMs);
        resolve();
      }, 400);
    });
  }
  function statKey(lineId, from, to, i){
    return lineId + '::' + from + '\u2192' + to + '::' + i;
  }

  // Picks a plausible but different speed to pair with the real one for a two-option hint.
  function pickHintDistractor(correctValue){
    const correct = Number(correctValue);
    const deltas = [-25,-20,-15,-10,-5,5,10,15,20,25].sort(() => Math.random() - 0.5);
    for(const d of deltas){
      const candidate = correct + d;
      if(candidate >= 5 && candidate <= 110 && candidate % 5 === 0 && candidate !== correct){
        return candidate;
      }
    }
    return correct > 10 ? correct - 10 : correct + 10;
  }

  // Renders the two-option hint choice UI into `container`. Calls onPick(chosenValueString)
  // once the user taps one of the two options.
  function renderHintChoice(container, correctValue, onPick){
    const correct = String(correctValue);
    const distractor = String(pickHintDistractor(correctValue));
    const options = Math.random() < 0.5 ? [correct, distractor] : [distractor, correct];
    const choiceRow = document.createElement('div');
    choiceRow.style.cssText = 'display:flex; gap:8px; align-items:center;';
    options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'rk-btn';
      btn.style.minWidth = '64px';
      btn.textContent = opt;
      btn.onclick = () => onPick(opt);
      choiceRow.appendChild(btn);
    });
    const label = document.createElement('span');
    label.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-size:10px; color:var(--accent-1); margin-left:4px;';
    label.textContent = 'hint \u2014 counts as a miss';
    choiceRow.appendChild(label);
    container.appendChild(choiceRow);
  }
  const SR_DAYS_BY_BOX = { 1: 0, 2: 1, 3: 3, 4: 7, 5: 14, 6: 30 };
  async function recordAttempt(key, correct){
    await loadStatsIfNeeded();
    const attemptedAt = Date.now();
    if(!statsData[key]) statsData[key] = { attempts: 0, correct: 0, box: 1, nextDueAt: attemptedAt };
    statsData[key].attempts++;
    if(correct) statsData[key].correct++;
    statsData[key].lastAt = attemptedAt;
    const curBox = statsData[key].box || 1;
    const newBox = correct ? Math.min(curBox + 1, 6) : 1;
    statsData[key].box = newBox;
    statsData[key].nextDueAt = correct ? attemptedAt + SR_DAYS_BY_BOX[newBox] * 86400000 : attemptedAt;
    queueStatDelta(key, {
      attempts:1,
      correct:correct ? 1 : 0,
      lastAt:attemptedAt,
      box:statsData[key].box,
      nextDueAt:statsData[key].nextDueAt,
      stateAt:attemptedAt,
    });
    await saveStats();
  }

  async function loadLocationQuizStats(){
    if(locationQuizStatsLoaded) return;
    try{
      const res = await storageAdapter.get('locationQuizStats:v1', false);
      const parsed = res && res.value ? JSON.parse(res.value) : {};
      locationQuizStats = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }catch(e){
      locationQuizStats = {};
    }
    locationQuizStatsLoaded = true;
  }

  async function recordLocationQuizAttempt(lineId, pairKey, correct){
    await loadLocationQuizStats();
    const key = lineId + '::' + pairKey;
    const attemptedAt = Date.now();
    if(!locationQuizStats[key]) locationQuizStats[key] = {attempts:0, correct:0, lastAt:0};
    locationQuizStats[key].attempts++;
    if(correct) locationQuizStats[key].correct++;
    locationQuizStats[key].lastAt = attemptedAt;
    try{
      await storageAdapter.set('locationQuizStats:v1', JSON.stringify(locationQuizStats), false);
    }catch(e){}
  }
  // Called once every box in a stretch has been checked. A safety-critical sequence
  // isn't "mostly right" \u2014 if any single box was wrong, the whole stretch's learning
  // clock resets together and comes back soon, rather than letting the correct boxes
  // in that same stretch coast off on a long interval while only the missed one returns.
  // items: array of { value, pairFrom, pairTo, pairIndex } \u2014 each box's own original
  // station-pair boundaries, so the stat key always matches what Range Quiz would use.
  async function evaluateStretchOutcome(lineId, items, guesses){
    const allCorrect = items.every((it, i) => {
      const g = guesses[i];
      return g !== '' && g !== undefined && Number(g) === Number(it.value);
    });
    if(allCorrect) return;
    await loadStatsIfNeeded();
    const REQUEUE_MS = 20 * 60000; // 20 minutes
    const stateAt = Date.now();
    items.forEach((it, i) => {
      const key = statKey(lineId, it.pairFrom, it.pairTo, it.pairIndex);
      if(!statsData[key]) statsData[key] = { attempts: 0, correct: 0 };
      statsData[key].box = 1;
      statsData[key].nextDueAt = stateAt + REQUEUE_MS;
      queueStatDelta(key, {attempts:0, correct:0, box:1, nextDueAt:statsData[key].nextDueAt, stateAt});
    });
    saveStats();
  }
  function parseStatKey(key){
    const parts = key.split('::');
    const lineId = parts[0];
    const fromTo = parts[1] || '';
    const iStr = parts[2] || '0';
    const [from, to] = fromTo.split('\u2192');
    return { lineId, from, to, i: iStr };
  }

  async function exportAllData(){
    await loadStatsIfNeeded();
    await loadCoverageIfNeeded();
    const payload = {
      schemaVersion: 3,
      exportedAt: new Date().toISOString(),
      tool: 'Adelaide Metro Route Knowledge',
      stats: statsData,
      coverageState,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'route-knowledge-backup-' + new Date().toISOString().slice(0,10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    try{ await storageAdapter.set('lastBackupAt', String(Date.now()), false); }catch(e){}
  }

  importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    try{
      const text = await file.text();
      const parsed = JSON.parse(text);
      const importedStats = parsed && parsed.stats;
      if(!importedStats || typeof importedStats !== 'object' || Array.isArray(importedStats)){
        alert('No Route Knowledge progress was found in that file.');
        importFileInput.value = '';
        return;
      }
      const ok = confirm('This will replace the progress saved on this device with the selected backup. Continue?');
      if(!ok){ importFileInput.value = ''; return; }
      statsData = importedStats;
      statsLoaded = true;
      statsReconciled = false;
      await reconcileStatsWithCurrentData();
      const stamp = Date.now();
      await writeLocalStatsSnapshot(statsData, stamp);
      const importedCoverage = parsed && parsed.coverageState && typeof parsed.coverageState === 'object' ? parsed.coverageState : {};
      await writeLocalCoverageState(importedCoverage);
      scheduleCloudStatsSave(statsData, stamp);
      syncCoverageState();
      alert('Progress imported successfully.');
      renderBody();
    }catch(err){
      alert('Could not read that file. Make sure it\'s a backup exported from this tool.');
    }
    importFileInput.value = '';
  });

  // Raw kilometrage data transcribed directly from the official Seaford Down/Up addenda screenshots.
  // km: null means no kilometrage was given in the source document for that row.

  function currentTrackGroup(){
    return TRACK_SPEED_GROUPS.find(g => g.down === trackSpeedsDir || g.up === trackSpeedsDir) || TRACK_SPEED_GROUPS[0];
  }




  function speedMapReferenceOfficialKm(line=speedMapLine){
    if(SPEED_MAP_ADELAIDE_15_CACHE[line]!==undefined)return SPEED_MAP_ADELAIDE_15_CACHE[line];
    const data=SPEED_MAP_LINES[line],coords=data.coords,ds=data.dists;
    const p=SPEED_MAP_ADELAIDE_15_REFERENCE;
    const cosLat=Math.cos(p.lat*Math.PI/180);
    const px=p.lng*cosLat,py=p.lat;
    let bestD=Infinity,bestMapKm=0;

    for(let i=0;i<coords.length-1;i++){
      const ay=coords[i][0],ax=coords[i][1]*cosLat;
      const by=coords[i+1][0],bx=coords[i+1][1]*cosLat;
      const vx=bx-ax,vy=by-ay,wx=px-ax,wy=py-ay;
      const den=vx*vx+vy*vy;
      const t=Math.max(0,Math.min(1,den?((wx*vx+wy*vy)/den):0));
      const qx=ax+t*vx,qy=ay+t*vy;
      const d2=(px-qx)*(px-qx)+(py-qy)*(py-qy);
      if(d2<bestD){
        bestD=d2;
        bestMapKm=ds[i]+t*(ds[i+1]-ds[i]);
      }
    }

    const official=speedMapMapToOfficial(bestMapKm,line);
    SPEED_MAP_ADELAIDE_15_CACHE[line]=official;
    return official;
  }

  function speedMapColor(speed){
    const t=Math.max(0,Math.min(1,(Number(speed)-5)/105));
    const hue=Math.round(220*(1-t));
    return `hsl(${hue} 76% ${t<.45?52:48}%)`;
  }
  function speedMapKey(line=speedMapLine,dir=speedMapDirection){ return SPEED_MAP_META[line][dir]; }
  function speedMapMapToOfficial(mapKm,line=speedMapLine){
    const a=SPEED_MAP_ANCHORS[line];
    if(a&&a.length>1){
      if(mapKm<=a[0].map)return a[0].official;
      if(mapKm>=a[a.length-1].map)return a[a.length-1].official;
      for(let i=0;i<a.length-1;i++){
        if(mapKm>=a[i].map&&mapKm<=a[i+1].map){
          const t=(mapKm-a[i].map)/((a[i+1].map-a[i].map)||1);
          return a[i].official+t*(a[i+1].official-a[i].official);
        }
      }
    }
    const d=SPEED_MAP_LINES[line].dists,r=SPEED_MAP_META[line].range;
    return r[0]+(mapKm/d[d.length-1])*(r[1]-r[0]);
  }
  function speedMapOfficialToMap(km,line=speedMapLine){
    const a=SPEED_MAP_ANCHORS[line];
    if(a&&a.length>1){
      if(km<=a[0].official)return a[0].map;
      if(km>=a[a.length-1].official)return a[a.length-1].map;
      for(let i=0;i<a.length-1;i++){
        if(km>=a[i].official&&km<=a[i+1].official){
          const t=(km-a[i].official)/((a[i+1].official-a[i].official)||1);
          return a[i].map+t*(a[i+1].map-a[i].map);
        }
      }
    }
    const d=SPEED_MAP_LINES[line].dists,r=SPEED_MAP_META[line].range;
    return ((km-r[0])/(r[1]-r[0]))*d[d.length-1];
  }
  function speedMapCoordAtMapKm(km,line=speedMapLine){
    const data=SPEED_MAP_LINES[line],ds=data.dists,cs=data.coords;
    if(km<=ds[0])return cs[0]; if(km>=ds[ds.length-1])return cs[cs.length-1];
    let lo=0,hi=ds.length-1;
    while(hi-lo>1){const mid=(lo+hi)>>1;if(ds[mid]<=km)lo=mid;else hi=mid;}
    const span=ds[hi]-ds[lo]||1,t=(km-ds[lo])/span;
    return [cs[lo][0]+(cs[hi][0]-cs[lo][0])*t,cs[lo][1]+(cs[hi][1]-cs[lo][1])*t];
  }
  function speedMapCoordAtOfficial(km,line=speedMapLine){ return speedMapCoordAtMapKm(speedMapOfficialToMap(km,line),line); }
  function speedMapSlice(a,b,line=speedMapLine){
    const data=SPEED_MAP_LINES[line],lo=Math.min(a,b),hi=Math.max(a,b),out=[speedMapCoordAtMapKm(lo,line)];
    data.dists.forEach((d,i)=>{if(d>lo&&d<hi)out.push(data.coords[i]);});
    out.push(speedMapCoordAtMapKm(hi,line)); if(a>b)out.reverse(); return out;
  }
  function speedMapNearest(latlng,line=speedMapLine){
    const data=SPEED_MAP_LINES[line];let best=0,bestD=Infinity;
    data.coords.forEach((c,i)=>{const d=(c[0]-latlng.lat)**2+(c[1]-latlng.lng)**2;if(d<bestD){bestD=d;best=i;}});
    return {idx:best,mapKm:data.dists[best],officialKm:speedMapMapToOfficial(data.dists[best],line)};
  }
  function speedMapRows(line=speedMapLine,dir=speedMapDirection){ return TRACK_SPEED_DATA[speedMapKey(line,dir)]||[]; }
  function speedMapPositionedRows(line=speedMapLine,dir=speedMapDirection){
    const rows=speedMapRows(line,dir);
    const adelaideBridgeKm=speedMapReferenceOfficialKm(line);
    return rows.map((r,i)=>{
      if(r.speed===null)return null;

      // Adelaide Station 15 km/h boundary:
      // Down: 15 km/h applies from the station until Morphett Street bridge,
      //       so pin the following speed change to the bridge.
      // Up:   pin the 15 km/h entry speed itself to the same bridge.
      if(dir==='up'&&r.speed===15&&Number(r.km)===0){
        return {...r,plotKm:adelaideBridgeKm,approximate:true,mapReference:SPEED_MAP_ADELAIDE_15_REFERENCE.label};
      }
      if(dir==='down'){
        let prevSpeed=i-1;
        while(prevSpeed>=0&&rows[prevSpeed].speed===null)prevSpeed--;
        if(prevSpeed>=0&&rows[prevSpeed].speed===15&&Number(rows[prevSpeed].km)===0){
          return {...r,plotKm:adelaideBridgeKm,approximate:true,mapReference:SPEED_MAP_ADELAIDE_15_REFERENCE.label};
        }
      }

      if(r.km!==null)return {...r,plotKm:r.km,approximate:false};
      let p=i-1,n=i+1; while(p>=0&&rows[p].km===null)p--; while(n<rows.length&&rows[n].km===null)n++;
      if(p>=0&&n<rows.length&&rows[p].km!==null&&rows[n].km!==null){
        const between=[];for(let j=p+1;j<n;j++)if(rows[j].speed!==null&&rows[j].km===null)between.push(j);
        const rank=Math.max(0,between.indexOf(i)),t=(rank+1)/(between.length+1);
        return {...r,plotKm:rows[p].km+(rows[n].km-rows[p].km)*t,approximate:true};
      }
      return {...r,plotKm:null,approximate:true};
    }).filter(Boolean);
  }
  function speedMapIntervals(line=speedMapLine,dir=speedMapDirection){
    const rows=speedMapPositionedRows(line,dir).filter(r=>r.plotKm!==null),range=SPEED_MAP_META[line].range,out=[];
    for(let i=0;i<rows.length;i++){
      const cur=rows[i],next=rows[i+1],endKm=next?next.plotKm:(dir==='down'?range[1]:range[0]);
      const lo=Math.max(range[0],Math.min(cur.plotKm,endKm)),hi=Math.min(range[1],Math.max(cur.plotKm,endKm));
      if(hi<=lo)continue;
      out.push({speed:cur.speed,startKm:cur.plotKm,endKm,lo,hi,comment:cur.comment||null,row:cur,approximate:cur.approximate,mapReference:cur.mapReference||null});
    }
    return applyOperationalRestrictions(out,line,dir);
  }
  function speedMapIntervalAt(km){
    const intervals=speedMapIntervals();
    // At an exact speed-change kilometre, prefer the interval that begins at
    // that board in the selected travel direction.
    const exact=intervals.find(x=>Math.abs(km-x.startKm)<1e-6);
    if(exact)return exact;
    return intervals.find(x=>km>x.lo-1e-6&&km<x.hi+1e-6)||null;
  }
  function speedMapNamedRows(km){
    const named=speedMapRows().filter(r=>r.label&&r.km!==null);let before=null,after=null;
    if(speedMapDirection==='up'){
      // Up direction runs from higher kilometrage toward Adelaide (lower km).
      // "Previous" therefore has a higher km and "Next" a lower km.
      named.forEach(r=>{
        if(r.km>=km&&(!before||r.km<before.km))before=r;
        if(r.km<km&&(!after||r.km>after.km))after=r;
      });
    }else{
      named.forEach(r=>{
        if(r.km<=km&&(!before||r.km>before.km))before=r;
        if(r.km>km&&(!after||r.km<after.km))after=r;
      });
    }
    return {before,after};
  }
  async function renderSpeedMap(){
    let maplibregl;
    try{
      maplibregl = await loadMapLibre();
    }catch(e){
      const unavailable = document.createElement('div');
      unavailable.className = 'rk-empty';
      unavailable.innerHTML = '<div class="big">Map unavailable offline</div>Track Speeds and every study mode remain available. Connect once to load the map library.';
      bodyEl.appendChild(unavailable);
      return;
    }
    const shell=document.createElement('div');shell.className='rk-sm-shell';
    addSectionHeader(shell,'Speed Map');
    const toolbar=document.createElement('div');toolbar.className='rk-sm-toolbar';
    const selectWrap=document.createElement('div');selectWrap.className='rk-sm-line-select-wrap';
    const lineSelect=document.createElement('select');lineSelect.className='rk-sm-line-select';lineSelect.id='rk-sm-line-select';lineSelect.setAttribute('aria-label','Rail line');
    selectWrap.appendChild(lineSelect);toolbar.appendChild(selectWrap);
    const dir=document.createElement('div');dir.className='rk-sm-dir-toggle';
    const down=document.createElement('button');down.type='button';down.className='rk-sm-dir-btn'+(speedMapDirection==='down'?' active':'');down.textContent='Down';
    const up=document.createElement('button');up.type='button';up.className='rk-sm-dir-btn'+(speedMapDirection==='up'?' active':'');up.textContent='Up';dir.appendChild(down);dir.appendChild(up);toolbar.appendChild(dir);
    const fit=document.createElement('button');fit.type='button';fit.className='rk-sm-tool-btn';fit.textContent='Fit line';toolbar.appendChild(fit);
    const basemapBtn=document.createElement('button');basemapBtn.type='button';basemapBtn.className='rk-sm-tool-btn';toolbar.appendChild(basemapBtn);
    shell.appendChild(toolbar);

    const mapWrap=document.createElement('div');mapWrap.className='rk-sm-map-wrap';
    mapWrap.innerHTML='<div id="rk-speed-map-map"></div><div class="rk-sm-source">Set speeds with current Adelaide Yard restriction · Exact km where stated</div><div class="rk-sm-legend"><div class="rk-sm-legend-head"><span>Applicable speed</span><span>km/h</span></div><div class="rk-sm-gradient"></div><div class="rk-sm-legend-scale"><span>5</span><span>35</span><span>60</span><span>85</span><span>110</span></div><div class="rk-sm-legend-note">Gawler, Outer Harbor, Grange and Port Dock include the 35 km/h Adelaide Yard restriction from km 0.633 to 1.380, Down and Up. Lower set speeds still apply. Other temporary restrictions are not shown.</div></div><div class="rk-sm-info hidden" id="rk-sm-info"><button class="rk-sm-close" id="rk-sm-info-close" type="button">×</button><div id="rk-sm-info-content"></div></div>';
    shell.appendChild(mapWrap);bodyEl.appendChild(shell);

    if(typeof maplibregl==='undefined'){
      mapWrap.innerHTML='<div class="rk-empty"><div class="big">MapLibre unavailable</div>Check your internet connection and reload the page.</div>';
      return;
    }
    if(speedMapInstance){try{speedMapInstance.remove();}catch(e){}speedMapInstance=null;}

    const baseStyle={
      version:8,
      sources:{
        street:{
          type:'raster',
          tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize:256,
          maxzoom:19,
          attribution:'&copy; OpenStreetMap contributors'
        },
        satellite:{
          type:'raster',
          tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize:256,
          maxzoom:19,
          attribution:'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
        }
      },
      layers:[
        {id:'rk-base-street',type:'raster',source:'street',layout:{visibility:speedMapBasemap==='satellite'?'none':'visible'},paint:{'raster-fade-duration':0}},
        {id:'rk-base-satellite',type:'raster',source:'satellite',layout:{visibility:speedMapBasemap==='satellite'?'visible':'none'},paint:{'raster-fade-duration':0}}
      ]
    };

    const map=new maplibregl.Map({
      container:'rk-speed-map-map',
      style:baseStyle,
      center:[138.58,-34.93],
      zoom:11,
      maxZoom:19,
      attributionControl:true,
      dragRotate:false,
      pitchWithRotate:false
    });
    speedMapInstance=map;
    map.addControl(new maplibregl.NavigationControl({showCompass:false,showZoom:true}),'top-right');

    let mapMarkers=[];
    let currentIntervals=[];
    let hoverPopup=null;

    function syncBasemapButton(){
      const sat=speedMapBasemap==='satellite';
      basemapBtn.textContent=sat?'Map':'Satellite';
      basemapBtn.classList.toggle('rk-sm-basemap-active',sat);
      basemapBtn.setAttribute('aria-pressed',sat?'true':'false');
      basemapBtn.title=sat?'Switch to street map':'Switch to satellite imagery';
    }
    function applyBasemap(){
      if(map.getLayer('rk-base-street'))map.setLayoutProperty('rk-base-street','visibility',speedMapBasemap==='satellite'?'none':'visible');
      if(map.getLayer('rk-base-satellite'))map.setLayoutProperty('rk-base-satellite','visibility',speedMapBasemap==='satellite'?'visible':'none');
      syncBasemapButton();
    }
    syncBasemapButton();

    function toLngLat(c){return [c[1],c[0]];}
    function toLineFeature(coords,props={}){return {type:'Feature',properties:props,geometry:{type:'LineString',coordinates:coords.map(toLngLat)}};}
    function fitCurrentLine(){
      const data=SPEED_MAP_LINES[speedMapLine],bounds=new maplibregl.LngLatBounds();
      data.coords.forEach(c=>bounds.extend(toLngLat(c)));
      map.fitBounds(bounds,{padding:28,duration:450,maxZoom:15});
    }
    function clearMarkers(){mapMarkers.forEach(m=>{try{m.remove();}catch(e){}});mapMarkers=[];}

    function speedBoardPhoto(interval){
      if(!interval)return null;
      return SPEED_BOARD_PHOTOS.find(photo=>
        photo.lines.includes(speedMapLine) &&
        photo.direction===speedMapDirection &&
        photo.speed===Number(interval.speed) &&
        Math.abs(photo.km-Number(interval.startKm))<1e-6
      )||null;
    }

    function openSpeedBoardPhoto(photo){
      const returnFocus=document.activeElement;
      const viewer=document.createElement('div');
      viewer.className='rk-sm-photo-viewer';
      viewer.setAttribute('role','dialog');
      viewer.setAttribute('aria-modal','true');
      viewer.setAttribute('aria-label','Speed board driver view');
      viewer.innerHTML='<div class="rk-sm-photo-viewer-card"><button class="rk-sm-photo-viewer-close" type="button" aria-label="Close image">×</button><img src="'+escapeHtml(photo.fullSrc||photo.src)+'" alt="'+escapeHtml(photo.alt)+'"><div class="rk-sm-photo-viewer-caption">'+escapeHtml(photo.caption)+'</div></div>';
      const close=()=>{
        document.removeEventListener('keydown',onKey);
        viewer.remove();
        if(returnFocus&&returnFocus.focus)returnFocus.focus();
      };
      const onKey=event=>{if(event.key==='Escape')close();};
      viewer.querySelector('.rk-sm-photo-viewer-close').onclick=close;
      viewer.addEventListener('click',event=>{if(event.target===viewer)close();});
      document.addEventListener('keydown',onKey);
      document.body.appendChild(viewer);
      viewer.querySelector('.rk-sm-photo-viewer-close').focus();
    }

    function showInfo(latlng,forced=null,showBoardPhoto=false){
      const p=speedMapNearest(latlng),km=p.officialKm,interval=forced||speedMapIntervalAt(km),named=speedMapNamedRows(km),meta=SPEED_MAP_META[speedMapLine];
      const boardPhoto=showBoardPhoto?speedBoardPhoto(interval):null;
      let html='<div class="rk-sm-info-title">'+escapeHtml(meta.label)+' — '+(speedMapDirection==='down'?'Down':'Up')+'</div><div class="rk-sm-info-sub">Tapped at official km '+km.toFixed(3)+'</div>';
      let details='';
      if(interval){
        details+='<div class="rk-sm-speed-big" style="color:'+speedMapColor(interval.speed)+'">'+interval.speed+' <small>km/h</small></div>';
        const dirArrow=speedMapDirection==='up'?' ↓ ':' → ';
        details+='<div class="rk-sm-stat"><span class="k">Speed applies</span><span class="v">'+(interval.approximate?'approx. ':'')+'km '+Number(interval.startKm).toFixed(3)+dirArrow+Number(interval.endKm).toFixed(3)+'</span></div>';
        if(interval.mapReference)details+='<div class="rk-sm-comment">Map position aligned to '+escapeHtml(interval.mapReference)+' for the Adelaide Station 15 km/h boundary. The source kilometrage remains unchanged.</div>';
        else if(interval.approximate)details+='<div class="rk-sm-comment">Approximate map position only — the source gives this speed in sequence but does not state a kilometre value.</div>';
        if(interval.operationalRestriction||interval.restrictionBoundary){
          const restriction=interval.operationalRestriction||interval.restrictionBoundary;
          details+='<div class="rk-sm-comment"><strong>Operational restriction:</strong> maximum '+restriction.speed+' km/h from km '+restriction.fromKm.toFixed(3)+' to '+restriction.toKm.toFixed(3)+' (Down &amp; Up), '+escapeHtml(restriction.location)+'. '+escapeHtml(restriction.source)+'. Set addenda speeds and quizzes are unchanged.</div>';
        }
        if(interval.comment)details+='<div class="rk-sm-comment">'+escapeHtml(interval.comment)+'</div>';
      }else details+='<div class="rk-sm-speed-big" style="color:#9aa5ba">— <small>no exact plotted speed</small></div>';
      if(named.before)details+='<div class="rk-sm-stat"><span class="k">Previous point</span><span class="v">'+escapeHtml(named.before.label)+' · km '+named.before.km.toFixed(3)+'</span></div>';
      if(named.after)details+='<div class="rk-sm-stat"><span class="k">Next point</span><span class="v">'+escapeHtml(named.after.label)+' · km '+named.after.km.toFixed(3)+'</span></div>';
      if(boardPhoto){
        html+='<div class="rk-sm-info-tabs" role="tablist" aria-label="Speed information view"><button class="rk-sm-info-tab" type="button" role="tab" aria-selected="false" data-sm-view="details">Details</button><button class="rk-sm-info-tab active" type="button" role="tab" aria-selected="true" data-sm-view="photo">Driver view</button></div>';
        html+='<div class="rk-sm-info-pages" data-sm-active="photo"><section class="rk-sm-info-page hidden" data-sm-page="details" role="tabpanel">'+details+'</section><section class="rk-sm-info-page rk-sm-info-page-photo" data-sm-page="photo" role="tabpanel"><div class="rk-sm-photo-route"><strong>'+escapeHtml(boardPhoto.route||boardPhoto.caption)+'</strong><span>Tap to enlarge</span></div><button class="rk-sm-board-photo" type="button" aria-label="Enlarge driver photo: '+escapeHtml(boardPhoto.caption)+'"><img src="'+escapeHtml(boardPhoto.fullSrc||boardPhoto.src)+'" alt="'+escapeHtml(boardPhoto.alt)+'" loading="lazy"></button></section></div>';
      }else html+=details;
      const infoContent=document.getElementById('rk-sm-info-content');
      infoContent.innerHTML=html;
      const infoPanel=document.getElementById('rk-sm-info');
      infoPanel.classList.toggle('has-photo',Boolean(boardPhoto));
      if(boardPhoto){
        const tabs=[...infoContent.querySelectorAll('.rk-sm-info-tab')];
        const pages=[...infoContent.querySelectorAll('.rk-sm-info-page')];
        const pagesWrap=infoContent.querySelector('.rk-sm-info-pages');
        const setView=view=>{
          const previous=pagesWrap.dataset.smActive;
          if(previous===view)return;
          pagesWrap.dataset.smActive=view;
          tabs.forEach(tab=>{
            const active=tab.dataset.smView===view;
            tab.classList.toggle('active',active);
            tab.setAttribute('aria-selected',active?'true':'false');
          });
          pages.forEach(page=>page.classList.toggle('hidden',page.dataset.smPage!==view));
          const entering=pages.find(page=>page.dataset.smPage===view);
          if(entering){
            entering.classList.remove('rk-sm-slide-from-left','rk-sm-slide-from-right');
            void entering.offsetWidth;
            entering.classList.add(view==='photo'?'rk-sm-slide-from-right':'rk-sm-slide-from-left');
          }
        };
        tabs.forEach(tab=>tab.onclick=()=>setView(tab.dataset.smView));
        let swipeStart=null;
        pagesWrap.addEventListener('pointerdown',event=>{swipeStart=event.clientX;});
        pagesWrap.addEventListener('pointerup',event=>{
          if(swipeStart===null)return;
          const delta=event.clientX-swipeStart;
          if(delta<-45)setView('photo');
          else if(delta>45)setView('details');
          swipeStart=null;
        });
        pagesWrap.addEventListener('pointercancel',()=>{swipeStart=null;});
        infoContent.querySelector('.rk-sm-board-photo').onclick=()=>openSpeedBoardPhoto(boardPhoto);
      }
      infoPanel.classList.remove('hidden');
    }

    function renderLabels(){
      clearMarkers();
      const z=map.getZoom(),range=SPEED_MAP_META[speedMapLine].range;
      effectiveSpeedMarkers(speedMapIntervals()).forEach(r=>{
        if(r.plotKm===null||r.plotKm<range[0]||r.plotKm>range[1])return;
        const c=speedMapCoordAtOfficial(r.plotKm),el=document.createElement('div');
        el.className='rk-sm-speed-marker'+(r.approximate?' approx':'');
        el.style.background=speedMapColor(r.speed);el.textContent=r.speed;
        const markerLocation=r.mapReference?(r.mapReference+' map reference'):(r.approximate?'approx. position (source km not stated)':'km '+Number(r.plotKm).toFixed(3));
        el.title=r.speed+' km/h · '+markerLocation+(r.comment?' · '+r.comment:'');
        el.addEventListener('click',ev=>{ev.stopPropagation();showInfo({lat:c[0],lng:c[1]},r,true);});
        const marker=new maplibregl.Marker({element:el,anchor:'center'}).setLngLat(toLngLat(c)).addTo(map);mapMarkers.push(marker);
      });
      speedMapRows().forEach(r=>{
        if(!r.label||r.km===null||r.km<range[0]||r.km>range[1]||z<13)return;
        const c=speedMapCoordAtOfficial(r.km),el=document.createElement('div');el.className='rk-sm-track-label';el.textContent=r.label;
        const marker=new maplibregl.Marker({element:el,anchor:'left',offset:[6,0]}).setLngLat(toLngLat(c)).addTo(map);mapMarkers.push(marker);
      });
    }


    function setSpeedMapLine(id,fitLine=true){
      if(!SPEED_MAP_META[id])return;
      speedMapLine=id;
      document.getElementById('rk-sm-info').classList.add('hidden');
      renderLineButtons();
      draw(fitLine);
    }
    function renderLineButtons(){
      lineSelect.innerHTML='';
      SPEED_MAP_ORDER.forEach(id=>{
        const m=SPEED_MAP_META[id],opt=document.createElement('option');
        opt.value=id;opt.textContent=m.label;if(id===speedMapLine)opt.selected=true;lineSelect.appendChild(opt);
      });
      if(!SPEED_MAP_META[speedMapLine])speedMapLine='gawler';
      lineSelect.value=speedMapLine;
      if(lineSelect.selectedIndex<0&&lineSelect.options.length){lineSelect.selectedIndex=0;speedMapLine=lineSelect.value;}
      lineSelect.style.setProperty('--sm-c',SPEED_MAP_META[speedMapLine].color);
    }
    function syncDirection(){down.classList.toggle('active',speedMapDirection==='down');up.classList.toggle('active',speedMapDirection==='up');}

    function draw(fitLine=false){
      if(!map.isStyleLoaded()||!map.getSource('rk-speed-base')||!map.getSource('rk-speed-segments'))return;
      const data=SPEED_MAP_LINES[speedMapLine];
      map.getSource('rk-speed-base').setData(toLineFeature(data.coords));
      currentIntervals=speedMapIntervals();
      const features=currentIntervals.map((interval,idx)=>{
        const a=speedMapOfficialToMap(interval.lo),b=speedMapOfficialToMap(interval.hi);
        return toLineFeature(speedMapSlice(a,b),{idx,speed:interval.speed,color:speedMapColor(interval.speed)});
      });
      map.getSource('rk-speed-segments').setData({type:'FeatureCollection',features});
      renderLabels();if(fitLine)fitCurrentLine();
    }

    lineSelect.onchange=()=>setSpeedMapLine(lineSelect.value,true);
    down.onclick=()=>{speedMapDirection='down';syncDirection();document.getElementById('rk-sm-info').classList.add('hidden');draw(false);};
    up.onclick=()=>{speedMapDirection='up';syncDirection();document.getElementById('rk-sm-info').classList.add('hidden');draw(false);};
    fit.onclick=()=>fitCurrentLine();
    basemapBtn.onclick=()=>{speedMapBasemap=speedMapBasemap==='satellite'?'map':'satellite';applyBasemap();};
    document.getElementById('rk-sm-info-close').onclick=()=>document.getElementById('rk-sm-info').classList.add('hidden');

    map.on('load',()=>{
      map.addSource('rk-speed-base',{type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}}});
      map.addLayer({id:'rk-speed-base-shadow',type:'line',source:'rk-speed-base',paint:{'line-color':'#30394c','line-width':11,'line-opacity':0.82},layout:{'line-cap':'round','line-join':'round'}});
      map.addSource('rk-speed-segments',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
      map.addLayer({id:'rk-speed-segments',type:'line',source:'rk-speed-segments',paint:{'line-color':['get','color'],'line-width':7,'line-opacity':0.95},layout:{'line-cap':'butt','line-join':'round'}});
      map.addLayer({id:'rk-speed-hit',type:'line',source:'rk-speed-base',paint:{'line-color':'#000000','line-width':24,'line-opacity':0.01},layout:{'line-cap':'round','line-join':'round'}});

      hoverPopup=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:11,className:'rk-sm-hover-popup'});
      map.on('mousemove','rk-speed-hit',e=>{
        map.getCanvas().style.cursor='pointer';
        const segs=map.queryRenderedFeatures(e.point,{layers:['rk-speed-segments']});
        if(segs.length){const idx=Number(segs[0].properties.idx),interval=currentIntervals[idx];if(interval)hoverPopup.setLngLat(e.lngLat).setHTML(interval.speed+' km/h').addTo(map);}
        else hoverPopup.remove();
      });
      map.on('mouseleave','rk-speed-hit',()=>{map.getCanvas().style.cursor='';if(hoverPopup)hoverPopup.remove();});
      map.on('click','rk-speed-hit',e=>{
        const segs=map.queryRenderedFeatures(e.point,{layers:['rk-speed-segments']});
        const interval=segs.length?currentIntervals[Number(segs[0].properties.idx)]:null;
        showInfo(e.lngLat,interval||null);
      });
      map.on('click',e=>{
        const hits=map.getLayer('rk-speed-hit')?map.queryRenderedFeatures(e.point,{layers:['rk-speed-hit']}):[];
        if(!hits.length)document.getElementById('rk-sm-info').classList.add('hidden');
      });
      map.on('zoomend',renderLabels);

      renderLineButtons();syncDirection();applyBasemap();draw(true);
      setTimeout(()=>map.resize(),0);
    });
  }

  function renderTrackSpeeds(){
    const wrap = document.createElement('div');
    wrap.className = 'rk-ts-list';
    addSectionHeader(wrap, 'Track Speeds');

    const group = currentTrackGroup();
    wrap.style.setProperty('--line-hue', group.hue);

    const pickerRow = document.createElement('div');
    pickerRow.className = 'rk-line-picker';
    pickerRow.style.marginTop = '0';

    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Track Speeds rail line');
    TRACK_SPEED_GROUPS.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.name;
      opt.textContent = g.name;
      if(g.name === group.name) opt.selected = true;
      select.appendChild(opt);
    });
    select.onchange = () => {
      const newGroup = TRACK_SPEED_GROUPS.find(g => g.name === select.value);
      const wasUp = trackSpeedsDir === group.up;
      trackSpeedsDir = wasUp ? newGroup.up : newGroup.down;
      renderBody();
    };
    pickerRow.appendChild(select);

    const dirToggleEl = document.createElement('div');
    dirToggleEl.className = 'rk-dir-toggle';
    ['Down','Up'].forEach(dir => {
      const id = dir === 'Down' ? group.down : group.up;
      const btn = document.createElement('button');
      btn.className = trackSpeedsDir === id ? 'active' : '';
      btn.textContent = dir;
      btn.onclick = () => { trackSpeedsDir = id; renderBody(); };
      dirToggleEl.appendChild(btn);
    });
    pickerRow.appendChild(dirToggleEl);

    wrap.appendChild(pickerRow);

    const rows = TRACK_SPEED_DATA[trackSpeedsDir];
    rows.forEach((row, i) => {
      if(row.label){
        const stationEl = document.createElement('div');
        stationEl.className = 'rk-ts-station';
        stationEl.textContent = row.label;
        wrap.appendChild(stationEl);
      }
      if(row.speed !== null){
        let endRow = null;
        for(let j = i + 1; j < rows.length; j++){
          if(rows[j].speed !== null){ endRow = rows[j]; break; }
        }
        if(!endRow){
          const lastRow = rows[rows.length - 1];
          if(lastRow && lastRow !== row && lastRow.km !== null) endRow = lastRow;
        }
        let distText;
        if(row.km === null){
          distText = 'exact km not given in source';
        } else if(endRow && endRow.km !== null){
          distText = 'for ' + Math.abs(endRow.km - row.km).toFixed(3) + ' km';
        } else {
          distText = 'distance not given in source';
        }
        const rowEl = document.createElement('div');
        rowEl.className = 'rk-ts-row';
        const speedEl = document.createElement('span');
        speedEl.className = 'rk-ts-speed';
        speedEl.textContent = row.speed + ' km/h';
        rowEl.appendChild(speedEl);
        const distEl = document.createElement('span');
        distEl.className = 'rk-ts-dist';
        distEl.textContent = distText + (row.km !== null ? ' (from km ' + row.km.toFixed(3) + ')' : '');
        rowEl.appendChild(distEl);
        if(row.comment){
          const commentEl = document.createElement('span');
          commentEl.className = 'rk-ts-comment';
          commentEl.textContent = row.comment;
          rowEl.appendChild(commentEl);
        }
        wrap.appendChild(rowEl);
      }
    });

    bodyEl.appendChild(wrap);
  }

  // Works inside Claude artifacts (window.storage) AND as a standalone hosted page
  // (falls back to the browser's localStorage). Same file, either environment.
  function normalizeUsername(raw){
    return String(raw || '').trim().toLowerCase();
  }

  function validateUsername(raw){
    const u = normalizeUsername(raw);
    if(u.length < 3 || u.length > 24) return 'Username must be 3–24 characters.';
    if(!/^[a-z0-9_-]+$/.test(u)) return 'Use only letters, numbers, underscores or hyphens.';
    return '';
  }

  function usernameToInternalEmail(username){
    return normalizeUsername(username) + '@' + RK_INTERNAL_EMAIL_DOMAIN;
  }

  function usernameFromFirebaseUser(user){
    if(user && user.displayName) return normalizeUsername(user.displayName);
    const email = user && user.email ? user.email : '';
    return normalizeUsername(email.split('@')[0] || '');
  }

  function authErrorMessage(err, registering=false){
    const code = err && err.code ? err.code : '';
    if(code === 'auth/email-already-in-use') return 'That username is already taken.';
    if(code === 'auth/weak-password') return 'Password must be at least 6 characters.';
    if(code === 'auth/password-does-not-meet-requirements') return 'That password does not meet the Firebase password policy.';
    if(code === 'auth/invalid-email') return 'The internal username identifier was rejected as an invalid email address.';
    if(code === 'auth/invalid-credential' || code === 'auth/user-not-found' || code === 'auth/wrong-password') return 'Incorrect username or password.';
    if(code === 'auth/too-many-requests') return 'Too many attempts. Try again a little later.';
    if(code === 'auth/network-request-failed') return 'Could not reach the login service. Check your internet connection.';
    if(code === 'auth/operation-not-allowed') return 'Username/password login is not enabled in Firebase.';
    if(code === 'auth/unauthorized-domain') return 'This website domain is not authorised in Firebase Authentication.';
    if(code === 'auth/api-key-not-valid' || code === 'auth/invalid-api-key') return 'The Firebase web API key is not being accepted.';
    if(code === 'auth/configuration-not-found') return 'Firebase Authentication configuration was not found for this project.';
    if(code === 'auth/quota-exceeded') return 'Firebase has temporarily hit an authentication quota.';
    const detail = code || (err && err.message ? err.message : 'unknown error');
    return (registering ? 'Could not create account: ' : 'Could not log in: ') + detail;
  }

  function setAuthBusy(busy, label){
    authSubmitBtn.disabled = !!busy;
    authModeBtn.disabled = !!busy;
    authUsernameInput.disabled = !!busy;
    authPasswordInput.disabled = !!busy;
    authLoadingEl.style.display = busy ? 'flex' : 'none';
    if(label) authLoadingTextEl.textContent = label;
  }

  function updateAuthMode(){
    const creating = authMode === 'register';
    authSubmitBtn.textContent = creating ? 'Create account' : 'Log in';
    authModeBtn.textContent = creating ? 'Back to log in' : 'Create an account';
    authSubtitleEl.textContent = creating
      ? 'Create a username and a unique password just for Route Knowledge. No email address is required.'
      : 'Sign in to keep your progress synced across your devices.';
    authPasswordInput.autocomplete = creating ? 'new-password' : 'current-password';
    authMessageEl.textContent = '';
  }

  function askProgressChoice(title, message, primaryText, secondaryText){
    return new Promise(resolve => {
      choiceTitleEl.textContent = title;
      choiceMessageEl.textContent = message;
      choicePrimaryBtn.textContent = primaryText;
      choiceSecondaryBtn.textContent = secondaryText;
      choiceOverlay.classList.add('show');

      const finish = value => {
        choiceOverlay.classList.remove('show');
        choicePrimaryBtn.onclick = null;
        choiceSecondaryBtn.onclick = null;
        resolve(value);
      };
      choicePrimaryBtn.onclick = () => finish('primary');
      choiceSecondaryBtn.onclick = () => finish('secondary');
    });
  }

  function statsAttemptCount(obj){
    return Object.values(obj || {}).reduce((sum, row) => sum + Number(row && row.attempts || 0), 0);
  }

  async function getLocalStatsSnapshot(){
    let stats = {};
    let updatedAtMs = 0;
    try{
      const res = await storageAdapter.get('stats:v1', false);
      if(res && res.value) stats = JSON.parse(res.value) || {};
    }catch(e){ stats = {}; }
    try{
      const res = await storageAdapter.get('statsUpdatedAt', false);
      if(res && res.value) updatedAtMs = Number(res.value) || 0;
    }catch(e){}
    return {stats, updatedAtMs};
  }

  async function writeLocalStatsSnapshot(stats, updatedAtMs){
    const safeStats = stats && typeof stats === 'object' ? stats : {};
    await storageAdapter.set('stats:v1', JSON.stringify(safeStats), false);
    await storageAdapter.set('statsUpdatedAt', String(updatedAtMs || Date.now()), false);
    statsData = safeStats;
    statsLoaded = true;
    statsReconciled = false;
    coverageAutoRecoveryChecked = false;
  }

  function cloudProgressRef(){
    if(!currentFirebaseUser || !firestoreDb) return null;
    return firestoreDb.collection('users').doc(currentFirebaseUser.uid).collection('routeKnowledge').doc('progress');
  }

  function parseCloudStats(data){
    try{ return data && data.statsJson ? JSON.parse(data.statsJson) : {}; }catch(e){ return {}; }
  }

  async function uploadStatsSnapshot(stats, updatedAtMs){
    const ref = cloudProgressRef();
    if(!ref) return false;
    await loadCoverageIfNeeded();
    const stamp = updatedAtMs || Date.now();
    setCloudSyncState('syncing');
    try{
      await ref.set({
        statsJson: JSON.stringify(stats || {}),
        coverageStateJson: JSON.stringify(coverageState),
        coverageUpdatedAtMs: stamp,
        updatedAtMs: stamp,
        updatedAt: firebaseSdk.firestore.FieldValue.serverTimestamp(),
        schemaVersion: 3
      }, {merge:true});
      pendingStatDeltas = {};
      persistPendingStatDeltas();
      try{ await storageAdapter.set('cloudLastSyncedAt', String(stamp), false); }catch(e){}
      setCloudSyncState('synced');
      return true;
    }catch(e){
      console.error('Cloud progress save failed', e);
      setCloudSyncState('error');
      return false;
    }
  }

  function restorePendingBatch(batch){
    pendingStatDeltas = mergePendingBatches(pendingStatDeltas, batch);
    persistPendingStatDeltas();
  }

  async function flushPendingStatDeltas(){
    const ref = cloudProgressRef();
    const keys = Object.keys(pendingStatDeltas);
    if(!ref || keys.length === 0) return true;

    const batch = pendingStatDeltas;
    pendingStatDeltas = {};
    persistPendingStatDeltas();
    setCloudSyncState('syncing');

    try{
      await firestoreDb.runTransaction(async transaction => {
        const snap = await transaction.get(ref);
        const cloud = applyStatDeltas(snap.exists ? parseCloudStats(snap.data()) : {}, batch);
        const stamp = Date.now();
        transaction.set(ref, {
          statsJson: JSON.stringify(cloud),
          updatedAtMs: stamp,
          updatedAt: firebaseSdk.firestore.FieldValue.serverTimestamp(),
          schemaVersion: 3
        }, {merge:true});
      });
      setCloudSyncState('synced');
      return true;
    }catch(e){
      restorePendingBatch(batch);
      console.error('Cloud progress merge failed', e);
      setCloudSyncState('error');
      return false;
    }
  }

  async function getCloudStatsSnapshot(){
    const ref = cloudProgressRef();
    if(!ref) return {exists:false, stats:{}, coverageState:{}, updatedAtMs:0};
    const snap = await ref.get();
    if(!snap.exists) return {exists:false, stats:{}, coverageState:{}, updatedAtMs:0};
    const data = snap.data() || {};
    return {exists:true, stats:parseCloudStats(data), coverageState:parseCloudCoverage(data), updatedAtMs:Number(data.updatedAtMs || 0)};
  }

  async function saveProfile(){
    if(!currentFirebaseUser || !firestoreDb) return;
    try{
      await firestoreDb.collection('users').doc(currentFirebaseUser.uid).set({
        username: currentUsername,
        updatedAt: firebaseSdk.firestore.FieldValue.serverTimestamp()
      }, {merge:true});
    }catch(e){
      console.error('Profile save failed', e);
    }
  }

  async function syncProgressWithCloud(interactive=false){
    if(!currentFirebaseUser || !firestoreDb) return;
    setCloudSyncState('syncing');

    try{
      const uid = currentFirebaseUser.uid;
      const associatedUid = localStorage.getItem('rk:cloudUid');
      await loadCoverageIfNeeded();
      let local = await getLocalStatsSnapshot();
      let cloud = await getCloudStatsSnapshot();
      const localAttempts = statsAttemptCount(local.stats);
      const cloudAttempts = statsAttemptCount(cloud.stats);

      if(associatedUid === uid){
        await flushPendingStatDeltas();
        cloud = await getCloudStatsSnapshot();
        if(cloud.exists) await writeLocalStatsSnapshot(cloud.stats, cloud.updatedAtMs || Date.now());
        else await uploadStatsSnapshot(local.stats, local.updatedAtMs || Date.now());
      }else if(!cloud.exists || cloudAttempts === 0){
        if(localAttempts > 0){
          const choice = await askProgressChoice(
            'Progress found on this device',
            'This device already has Route Knowledge progress saved on it. Upload it to ' + currentUsername + ' so it follows you to other devices?',
            'Upload this device’s progress',
            'Start fresh'
          );
          if(choice === 'primary') await uploadStatsSnapshot(local.stats, local.updatedAtMs || Date.now());
          else{
            local = {stats:{}, updatedAtMs:Date.now()};
            await writeLocalStatsSnapshot({}, local.updatedAtMs);
            await uploadStatsSnapshot({}, local.updatedAtMs);
          }
        }else{
          await uploadStatsSnapshot({}, Date.now());
        }
      }else if(localAttempts === 0){
        await writeLocalStatsSnapshot(cloud.stats, cloud.updatedAtMs || Date.now());
      }else if(JSON.stringify(local.stats || {}) !== JSON.stringify(cloud.stats || {})){
        const choice = await askProgressChoice(
          'Progress found on this device',
          'This device has progress that differs from your account. Choose the starting copy for this device.',
          'Use cloud progress',
          'Upload this device’s progress'
        );
        if(choice === 'primary') await writeLocalStatsSnapshot(cloud.stats, cloud.updatedAtMs || Date.now());
        else await uploadStatsSnapshot(local.stats, local.updatedAtMs || Date.now());
      }

      coverageState = mergeCoverageStates(coverageState, cloud.coverageState || {});
      await writeLocalCoverageState(coverageState);
      await syncCoverageState();

      localStorage.setItem('rk:cloudUid', uid);
      await saveProfile();
      statsReconciled = false;
      await loadStatsIfNeeded();
      setCloudSyncState('synced');
      renderBody();
    }catch(e){
      console.error('Cloud sync failed', e);
      setCloudSyncState('error');
    }
  }

  function scheduleCloudStatsSave(){
    if(!currentFirebaseUser) return;
    if(cloudWriteTimer) clearTimeout(cloudWriteTimer);
    cloudWriteTimer = setTimeout(() => { flushPendingStatDeltas(); }, 650);
  }

  function showSignedInUI(user){
    currentFirebaseUser = user;
    currentUsername = usernameFromFirebaseUser(user);
    accountNameEl.textContent = currentUsername || 'Account';
    accountBtn.style.display = 'flex';
    authOverlay.classList.add('hidden');
  }

  function openAuthOverlay(){
    // An explicit account request temporarily leaves local-only mode so the
    // asynchronous Firebase signed-out callback cannot hide this dialog.
    localModeChosen = false;
    localStorage.removeItem('rk:localMode');
    authOverlay.classList.remove('hidden');
    setAuthBusy(false);
    if(!firebaseAuth) initFirebaseAuth();
    setTimeout(() => authUsernameInput.focus(), 50);
  }

  function showSignedOutUI(){
    currentFirebaseUser = null;
    currentUsername = '';
    accountBtn.style.display = 'none';
    closeAccountMenu();
    setCloudSyncState('idle');
    authOverlay.classList.toggle('hidden', localModeChosen);
    setAuthBusy(false);
    authPasswordInput.value = '';
    if(!localModeChosen) setTimeout(() => authUsernameInput.focus(), 50);
  }

  function initFirebaseAuth(){
    if(firebaseInitPromise) return firebaseInitPromise;
    firebaseInitPromise = (async () => {
      try{
      await loadFirebaseSdk();
      firebaseApp = firebaseSdk.apps && firebaseSdk.apps.length ? firebaseSdk.app() : firebaseSdk.initializeApp(FIREBASE_CONFIG);
      firebaseAuth = firebaseSdk.auth();
      firestoreDb = firebaseSdk.firestore();

      try{
        await firebaseAuth.setPersistence(firebaseSdk.auth.Auth.Persistence.LOCAL);
      }catch(e){
        console.warn('Could not set Firebase auth persistence', e);
      }

      firebaseAuth.onAuthStateChanged(async user => {
        if(user){
          showSignedInUI(user);
          await syncProgressWithCloud(false);
        }else{
          showSignedOutUI();
        }
      });
      }catch(e){
        console.error('Firebase startup failed', e);
        authMessageEl.textContent = 'Cloud sign-in is unavailable. You can continue on this device and sync later.';
        setAuthBusy(false);
        firebaseInitPromise = null;
      }
    })();
    return firebaseInitPromise;
  }

  authModeBtn.onclick = () => {
    authMode = authMode === 'login' ? 'register' : 'login';
    updateAuthMode();
  };

  authLocalBtn.onclick = () => {
    localModeChosen = true;
    localStorage.setItem('rk:localMode', '1');
    authOverlay.classList.add('hidden');
    renderBody();
  };

  authForm.addEventListener('submit', async e => {
    e.preventDefault();
    authMessageEl.textContent = '';
    const username = normalizeUsername(authUsernameInput.value);
    const validation = validateUsername(username);
    if(validation){
      authMessageEl.textContent = validation;
      return;
    }
    const password = authPasswordInput.value;
    if(password.length < 6){
      authMessageEl.textContent = 'Password must be at least 6 characters.';
      return;
    }

    const registering = authMode === 'register';
    setAuthBusy(true, registering ? 'Creating account…' : 'Logging in…');
    try{
      if(!firebaseAuth) await initFirebaseAuth();
      if(!firebaseAuth) throw new Error('Cloud sign-in is unavailable.');
      const email = usernameToInternalEmail(username);
      console.info('Route Knowledge auth attempt', {username, internalIdentifier:email, mode:registering?'register':'login'});
      if(registering){
        const cred = await firebaseAuth.createUserWithEmailAndPassword(email, password);
        try{ await cred.user.updateProfile({displayName:username}); }catch(e){}
        currentUsername = username;
        await saveProfile();
      }else{
        await firebaseAuth.signInWithEmailAndPassword(email, password);
      }
      authPasswordInput.value = '';
    }catch(err){
      console.error('Firebase Authentication error', err);
      authMessageEl.textContent = authErrorMessage(err, registering);
      setAuthBusy(false);
    }
  });

  updateAuthMode();

  function storageKey(lineId){ return 'segments:' + lineId; }

  async function loadSegments(lineId){
    if(!segCache[lineId]) segCache[lineId] = STUDY_SEGMENTS[lineId] || [];
    return segCache[lineId];
  }

  function currentLine(){ return LINES.find(l => l.id === activeLine); }

  function buildLineGroups(){
    const groups = [];
    LINES.forEach(line => {
      let group = groups.find(g => g.name === line.name);
      if(!group){
        group = { name: line.name, hue: line.hue, lines: [] };
        groups.push(group);
      }
      group.lines.push(line);
    });
    return groups;
  }

  function renderTabs(){
    const groups = buildLineGroups();

    lineSelect.innerHTML = '';
    groups.forEach(group => {
      const opt = document.createElement('option');
      opt.value = group.name;
      opt.textContent = group.name;
      if(group.name === selectedLineGroup) opt.selected = true;
      lineSelect.appendChild(opt);
    });
    lineSelect.onchange = () => {
      const group = groups.find(g => g.name === lineSelect.value);
      selectedLineGroup = group.name;
      const preferredDir = LINES.find(l => l.id === activeLine)?.direction;
      const match = group.lines.find(l => l.direction === preferredDir) || group.lines[0];
      exitQuiz(); activeLine = match.id;
      renderTabs(); renderBody();
    };

    const activeGroup = groups.find(g => g.name === selectedLineGroup) || groups[0];
    tabsEl.style.setProperty('--line-hue', activeGroup.hue);
    dirToggle.innerHTML = '';
    activeGroup.lines.forEach(line => {
      const btn = document.createElement('button');
      btn.className = line.id === activeLine ? 'active' : '';
      btn.textContent = line.direction || activeGroup.name;
      btn.onclick = () => {
        exitQuiz(); activeLine = line.id;
        renderTabs(); renderBody();
      };
      dirToggle.appendChild(btn);
    });
  }

  function exitQuiz(){
    quizModeType = null;
    quizRangeGuesses = {};
    quizRangeBoxChecked = {};
    quizRangeRecorded = {};
    quizRangeHintUsed = false;
    quizRangeHintActive = null;
    quizRangeHintFlag = {};
    quizRetryKeys = null;
    locationQuizState = null;
  }

  function renderNav(){
    navRow.innerHTML = '';
    const activeId = currentViewId();
    const navItems = [
      { id: 'home', label: 'Home', action: () => { closeAllViews(); activeView = 'home'; renderBody(); } },
      { id: 'progress', label: 'Progress', action: () => { closeAllViews(); activeView = 'progress'; renderBody(); } },
      { id: 'mystery', label: 'Mystery', action: () => { closeAllViews(); activeView = 'mystery'; mysteryRound = null; renderBody(); } },
      { id: 'review', label: 'Review', action: () => { closeAllViews(); activeView = 'review'; renderBody(); } },
    ];
    navItems.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'rk-nav-btn' + (item.id === activeId ? ' active' : '');
      btn.textContent = item.label;
      btn.onclick = item.action;
      navRow.appendChild(btn);
    });
  }

  async function renderBody(){
    bodyEl.classList.remove('rk-view-enter');
    void bodyEl.offsetWidth; // force reflow to re-trigger animation
    bodyEl.classList.add('rk-view-enter');
    renderNav();
    const anyAltView = activeView !== 'lines';
    tabsEl.style.display = anyAltView ? 'none' : '';

    if(activeView === 'home'){
      bodyEl.innerHTML = '';
      await renderLanding();
      return;
    }
    if(activeView === 'network'){
      bodyEl.innerHTML = '';
      await renderNetworkOverview();
      return;
    }
    if(activeView === 'speedmap'){
      bodyEl.innerHTML = '';
      await renderSpeedMap();
      return;
    }
    if(activeView === 'track'){
      bodyEl.innerHTML = '';
      renderTrackSpeeds();
      return;
    }
    if(activeView === 'mystery'){
      bodyEl.innerHTML = '';
      await renderMystery();
      return;
    }
    if(activeView === 'focus'){
      bodyEl.innerHTML = '';
      await renderFocusQuiz();
      return;
    }
    if(activeView === 'progress'){
      bodyEl.innerHTML = '';
      await renderProgress();
      return;
    }
    if(activeView === 'review'){
      bodyEl.innerHTML = '';
      await renderReview();
      return;
    }
    if(activeView === 'journey'){
      bodyEl.innerHTML = '';
      await renderJourney();
      return;
    }
    if(activeView === 'compare'){
      bodyEl.innerHTML = '';
      await renderCompare();
      return;
    }

    const line = currentLine();
    const segs = await loadSegments(line.id);
    bodyEl.innerHTML = '';
    bodyEl.style.setProperty('--line-hue', line.hue);

    // mode bar
    const modebar = document.createElement('div');
    modebar.className = 'rk-modebar';
    const label = document.createElement('div');
    label.className = 'rk-linelabel';
    const dirBadge = line.direction ? ' <span class="rk-tag" style="vertical-align:middle;">' + line.direction.toUpperCase() + '</span>' : '';
    label.innerHTML = line.name + dirBadge + '<span class="n">' + segs.length + ' segment' + (segs.length===1?'':'s') + ' recorded</span>';
    modebar.appendChild(label);

    const btnRow = document.createElement('div');
    btnRow.className = 'rk-action-row';
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.flexWrap = 'wrap';

    if(quizModeType){
      const activeQuizLabel = document.createElement('span');
      activeQuizLabel.className = 'rk-active-quiz-label';
      activeQuizLabel.textContent = quizModeType === 'locations' ? 'Quiz Locations' : 'Quiz Speeds';
      btnRow.appendChild(activeQuizLabel);
      const exitBtn = document.createElement('button');
      exitBtn.className = 'rk-btn quiz-active';
      exitBtn.textContent = 'Exit Quiz';
      exitBtn.onclick = () => { exitQuiz(); renderBody(); };
      btnRow.appendChild(exitBtn);
    } else {
      const quizTypeSwitch = document.createElement('div');
      quizTypeSwitch.className = 'rk-quiz-type-switch';
      quizTypeSwitch.setAttribute('role', 'group');
      quizTypeSwitch.setAttribute('aria-label', 'Choose quiz type');
      [
        {id:'speeds', label:'Quiz Speeds'},
        {id:'locations', label:'Quiz Locations'},
      ].forEach(option => {
        const typeBtn = document.createElement('button');
        typeBtn.type = 'button';
        typeBtn.className = quizRecallType === option.id ? 'active' : '';
        typeBtn.textContent = option.label;
        typeBtn.setAttribute('aria-pressed', quizRecallType === option.id ? 'true' : 'false');
        typeBtn.onclick = () => {
          quizRecallType = option.id;
          showLineHeatmap = false;
          renderBody();
        };
        quizTypeSwitch.appendChild(typeBtn);
      });
      btnRow.appendChild(quizTypeSwitch);

      const rangeQuizBtn = document.createElement('button');
      rangeQuizBtn.className = 'rk-btn';
      rangeQuizBtn.textContent = 'Start Quiz';
      rangeQuizBtn.disabled = segs.length === 0;
      rangeQuizBtn.style.opacity = rangeQuizBtn.disabled ? '0.4' : '1';
      rangeQuizBtn.onclick = () => {
        quizRangeGuesses = {}; quizRangeBoxChecked = {};
        quizRetryKeys = null;
        locationQuizState = null;
        quizModeType = quizRecallType === 'locations' ? 'locations' : 'range';
        renderBody();
      };
      btnRow.appendChild(rangeQuizBtn);

      const hideSpeedsBtn = document.createElement('button');
      hideSpeedsBtn.className = 'rk-btn';
      hideSpeedsBtn.textContent = hideSpeeds ? 'Unhide Speeds' : 'Hide Speeds';
      hideSpeedsBtn.disabled = segs.length === 0;
      hideSpeedsBtn.style.opacity = hideSpeedsBtn.disabled ? '0.4' : '1';
      hideSpeedsBtn.onclick = () => { hideSpeeds = !hideSpeeds; showLineHeatmap = false; renderBody(); };
      btnRow.appendChild(hideSpeedsBtn);

      const heatmapBtn = document.createElement('button');
      heatmapBtn.className = 'rk-btn' + (showLineHeatmap ? ' quiz-active' : '');
      heatmapBtn.textContent = showLineHeatmap ? 'Hide Accuracy Map' : 'Accuracy Map';
      heatmapBtn.disabled = segs.length === 0;
      heatmapBtn.style.opacity = heatmapBtn.disabled ? '0.4' : '1';
      heatmapBtn.onclick = () => { showLineHeatmap = !showLineHeatmap; renderBody(); };
      btnRow.appendChild(heatmapBtn);
    }
    modebar.appendChild(btnRow);
    bodyEl.appendChild(modebar);

    if(quizModeType === 'range'){
      renderQuizRange(segs, line);
      return;
    }

    if(quizModeType === 'locations'){
      renderLocationQuiz(segs, line);
      return;
    }

    if(showLineHeatmap){
      await renderLineHeatmap(segs, line);
      return;
    }

    // Canonical data is bundled with the app; an empty line indicates a release error.
    if(segs.length === 0){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.innerHTML = '<div class="big">Route data unavailable</div>Please update Route Knowledge or try reloading the app.';
      bodyEl.appendChild(empty);
    } else {
      const pairs = computeRangePairs(segs);
      if(pairs.length > 0){
        const track = document.createElement('div');
        track.className = 'rk-track';
        pairs.forEach(pair => {
          const card = document.createElement('div');
          card.className = 'rk-seg';
          const top = document.createElement('div');
          top.className = 'rk-seg-top';
          const left = document.createElement('div');
          left.style.cssText = 'flex:1; min-width:0;';
          const stations = document.createElement('div');
          stations.className = 'rk-stations';
          stations.innerHTML = escapeHtml(pair.from) + '<span class="arrow">\u2192</span>' + escapeHtml(pair.to);
          left.appendChild(stations);
          top.appendChild(left);
          card.appendChild(top);

          if(!hideSpeeds){
            const speedRow = document.createElement('div');
            speedRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; margin-top:10px;';
            pair.speeds.forEach(sp => {
              const chipWrap = document.createElement('div');
              chipWrap.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:3px;';
              const chip = document.createElement('div');
              chip.className = 'rk-board';
              chip.style.cssText += '; min-width:48px; font-size:14px; padding:5px 8px;';
              chip.innerHTML = sp.value + '<span class="u">km/h</span>';
              chipWrap.appendChild(chip);
              if(sp.note){
                const noteEl = document.createElement('span');
                noteEl.style.cssText = 'font-family:var(--font-mono); font-size:9px; color:var(--accent-1); text-align:center;';
                noteEl.textContent = sp.note;
                chipWrap.appendChild(noteEl);
              }
              speedRow.appendChild(chipWrap);
            });
            card.appendChild(speedRow);
          } else {
            const countTag = document.createElement('div');
            countTag.className = 'rk-tags';
            countTag.style.marginTop = '4px';
            countTag.appendChild(makeTag(pair.speeds.length + ' speed change' + (pair.speeds.length===1?'':'s')));
            left.appendChild(countTag);
          }

          track.appendChild(card);
        });
        bodyEl.appendChild(track);
      }
    }
  }

  function isNamedStation(name){
    if(!name) return false;
    const n = name.trim();
    if(n.toLowerCase().startsWith('km ')) return false;
    if(n.includes('(')) return false;
    return true;
  }

  function computeRangePairs(segs){
    if(!segs.length) return [];
    const points = [segs[0].from];
    segs.forEach(s => points.push(s.to));
    const namedIdx = [];
    points.forEach((p, i) => { if(isNamedStation(p)) namedIdx.push(i); });
    const pairs = [];
    for(let k = 0; k < namedIdx.length - 1; k++){
      const idxA = namedIdx[k], idxB = namedIdx[k+1];
      const speeds = [];
      for(let s = idxA; s < idxB; s++){
        const sp = segs[s].speed;
        const note = segs[s].note || null;
        if(speeds.length === 0 || speeds[speeds.length-1].value !== sp){
          speeds.push({ value: sp, note: note });
        } else if(note && !speeds[speeds.length-1].note){
          speeds[speeds.length-1].note = note;
        }
      }
      pairs.push({ key: idxA + '_' + idxB, from: points[idxA], to: points[idxB], speeds });
    }
    return pairs;
  }

  function shuffledCopy(items){
    const copy = items.slice();
    for(let i = copy.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function locationSequenceKey(pair){
    return pair.speeds.map(speed => String(speed.value)).join('>');
  }

  function buildLocationQuizQuestions(segs){
    const pairs = computeRangePairs(segs).filter(pair => !(pair.from === 'Salisbury' && pair.to === 'Nurlutta'));
    const frequencies = {};
    pairs.forEach(pair => {
      const signature = locationSequenceKey(pair);
      frequencies[signature] = (frequencies[signature] || 0) + 1;
    });

    // A reverse question is only admitted when its visible speed sequence has
    // exactly one valid location in this line and direction.
    const eligible = pairs.filter(pair => frequencies[locationSequenceKey(pair)] === 1);
    return shuffledCopy(eligible).map(pair => {
      const distractors = shuffledCopy(pairs.filter(candidate => candidate.key !== pair.key)).slice(0, 2);
      return {
        id: 'match::' + pair.key,
        pair,
        options: shuffledCopy([pair, ...distractors]).map(option => ({
          key: option.key,
          label: option.from + ' → ' + option.to,
        })),
        answerKey: pair.key,
        selectedKey: null,
        checked: false,
        recorded: false,
      };
    });
  }

  async function reconcileStatsWithCurrentData(){
    if(statsReconciled) return;
    statsReconciled = true;

    const validKeys = new Set();

    // Range Quiz and Mystery both ultimately record stats using the canonical
    // named-station pair plus the speed-change index within that pair.
    for(const line of LINES){
      const segs = await loadSegments(line.id);
      const pairs = computeRangePairs(segs);
      pairs.forEach(pair => {
        pair.speeds.forEach((sp, i) => {
          validKeys.add(statKey(line.id, pair.from, pair.to, i));
        });
      });
    }

    let changed = false;
    Object.keys(statsData).forEach(key => {
      if(!validKeys.has(key)){
        queueStatDelta(key, {deleted:true, stateAt:Date.now()});
        delete statsData[key];
        changed = true;
      }
    });

    if(changed){
      try{
        const updatedAtMs = Date.now();
        await storageAdapter.set('stats:v1', JSON.stringify(statsData), false);
        await storageAdapter.set('statsUpdatedAt', String(updatedAtMs), false);
        scheduleCloudStatsSave(statsData, updatedAtMs);
      }catch(e){
        console.error('Could not reconcile saved review data', e);
      }
    }
  }

  function computeFullSequence(segs){
    if(!segs.length) return { points: [], collapsed: [] };
    const points = [segs[0].from];
    segs.forEach(s => points.push(s.to));
    const collapsed = []; // { value, note, fromIdx, toIdx }
    segs.forEach((s, i) => {
      const sp = s.speed;
      const note = s.note || null;
      if(collapsed.length === 0 || collapsed[collapsed.length-1].value !== sp){
        collapsed.push({ value: sp, note: note, fromIdx: i, toIdx: i+1 });
      } else {
        collapsed[collapsed.length-1].toIdx = i+1;
        if(note && !collapsed[collapsed.length-1].note) collapsed[collapsed.length-1].note = note;
      }
    });
    return { points, collapsed };
  }

  function nearestNamedBefore(points, idx){
    for(let i = idx; i >= 0; i--){
      if(isNamedStation(points[i])) return points[i];
    }
    return points[0];
  }
  function nearestNamedAfter(points, idx){
    for(let i = idx; i < points.length; i++){
      if(isNamedStation(points[i])) return points[i];
    }
    return points[points.length - 1];
  }

  // Given one collapsed speed-change entry, finds where it truly sits within the real
  // named-station-to-named-station stretch it belongs to (e.g. "3 of 6") \u2014 not just its
  // position within some arbitrary random slice, which can start or end mid-stretch.
  function namedPairPosition(points, collapsed, entry){
    let namedBeforeIdx = entry.fromIdx;
    while(namedBeforeIdx > 0 && !isNamedStation(points[namedBeforeIdx])) namedBeforeIdx--;
    let namedAfterIdx = entry.toIdx;
    while(namedAfterIdx < points.length - 1 && !isNamedStation(points[namedAfterIdx])) namedAfterIdx++;
    const rangeEntries = collapsed.filter(c => c.fromIdx >= namedBeforeIdx && c.toIdx <= namedAfterIdx);
    const posIdx = rangeEntries.indexOf(entry);
    return {
      position: posIdx + 1,
      total: rangeEntries.length,
      namedFrom: points[namedBeforeIdx],
      namedTo: points[namedAfterIdx],
    };
  }

  async function pickMysteryRound(){
    const candidates = [];
    for(const line of LINES){
      const segs = await loadSegments(line.id);
      if(segs.length > 0) candidates.push({ line, segs });
    }
    if(candidates.length === 0) return null;

    for(let attempt = 0; attempt < 30; attempt++){
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      const { points, collapsed } = computeFullSequence(pick.segs);
      if(collapsed.length < 3) continue;
      const maxLen = Math.min(10, collapsed.length);
      const sliceLen = 3 + Math.floor(Math.random() * (maxLen - 2));
      const startIdx = Math.floor(Math.random() * (collapsed.length - sliceLen + 1));
      const slice = collapsed.slice(startIdx, startIdx + sliceLen);
      const fromLabel = nearestNamedBefore(points, slice[0].fromIdx);
      const toLabel = nearestNamedAfter(points, slice[slice.length-1].toIdx);
      return {
        lineId: pick.line.id,
        lineLabel: pick.line.name + (pick.line.direction ? ' \u2014 ' + pick.line.direction : ''),
        fromLabel, toLabel,
        values: slice.map(s => {
          const ctx = namedPairPosition(points, collapsed, s);
          return { value: s.value, note: s.note, boxFrom: points[s.fromIdx], boxTo: points[s.toIdx], position: ctx.position, total: ctx.total, namedFrom: ctx.namedFrom, namedTo: ctx.namedTo };
        }),
        guesses: new Array(slice.length).fill(''),
        checked: new Array(slice.length).fill(false),
        recorded: new Array(slice.length).fill(false),
        hintFlags: new Array(slice.length).fill(false),
        hintUsed: false,
        hintActiveIndex: null,
      };
    }
    return null;
  }

  async function renderMystery(){
    const wrap = document.createElement('div');
    wrap.className = 'rk-net-tree'; // reuse fade-in animation
    addSectionHeader(wrap, 'Mystery');

    if(!mysteryRound){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.innerHTML = '<div class="big">Mystery Mode</div>' +
        'Pulls a random stretch of 3\u201310 speed changes from a random line you\u2019ve loaded. No hints about which line or section until it\u2019s on screen.';
      wrap.appendChild(empty);
      const startBtn = document.createElement('button');
      startBtn.className = 'rk-btn primary';
      startBtn.style.cssText = 'display:block; margin:16px auto 0;';
      startBtn.textContent = 'Start Mystery Round';
      startBtn.onclick = async () => {
        mysteryRound = await pickMysteryRound();
        if(!mysteryRound){
          alert('Not enough data loaded yet \u2014 add some segments to a line first.');
        }
        renderBody();
      };
      wrap.appendChild(startBtn);
      bodyEl.appendChild(wrap);
      return;
    }

    const round = mysteryRound;
    if(!Array.isArray(round.recorded) || round.recorded.length !== round.checked.length){
      round.recorded = new Array(round.checked.length).fill(false);
    }
    const checkedCount = round.checked.filter(Boolean).length;
    const correctCount = round.checked.reduce((acc, c, i) => {
      if(!c) return acc;
      const g = round.guesses[i];
      return acc + (g !== '' && g !== undefined && Number(g) === Number(round.values[i].value) ? 1 : 0);
    }, 0);

    const bar = document.createElement('div');
    bar.className = 'rk-quizbar';
    bar.innerHTML = '<span>' + round.lineLabel + '</span><span>Checked ' + checkedCount + ' / ' + round.values.length + '</span>';
    wrap.appendChild(bar);

    const card = document.createElement('div');
    card.className = 'rk-seg';
    const top = document.createElement('div');
    top.className = 'rk-seg-top';
    const left = document.createElement('div');
    left.style.flex = '1';
    const stations = document.createElement('div');
    stations.className = 'rk-stations';
    stations.innerHTML = escapeHtml(round.fromLabel) + '<span class="arrow">\u2192</span>' + escapeHtml(round.toLabel);
    left.appendChild(stations);
    const hint = document.createElement('div');
    hint.className = 'rk-tags';
    hint.appendChild(makeTag(round.values.length + ' speed changes in this stretch'));
    left.appendChild(hint);
    top.appendChild(left);
    card.appendChild(top);

    const boxCol = document.createElement('div');
    boxCol.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-top:10px; max-width:260px;';

    round.values.forEach((v, i) => {
      const itemWrap = document.createElement('div');
      itemWrap.style.cssText = 'margin-bottom:2px;';
      itemWrap.dataset.order = i;

      const posLabel = document.createElement('div');
      posLabel.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--muted); margin-bottom:4px;';
      posLabel.textContent = (v.total > 1 ? 'Speed ' + v.position + ' of ' + v.total + ' \u2014 ' : '') + v.namedFrom + ' \u2192 ' + v.namedTo;
      itemWrap.appendChild(posLabel);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap;';

      const hintIsActiveHere = round.hintActiveIndex === i;

      if(hintIsActiveHere){
        renderHintChoice(row, v.value, (chosen) => {
          round.guesses[i] = chosen;
          round.checked[i] = true;
          round.hintFlags[i] = true;
          round.hintActiveIndex = null;
          const isFirstAttempt = !round.recorded[i];
          renderBody();
          if(isFirstAttempt){
            round.recorded[i] = true;
            recordAttempt(statKey(round.lineId, v.namedFrom, v.namedTo, v.position - 1), false);
          }
        });
      } else if(!round.checked[i]){
        const input = document.createElement('input');
        input.className = 'rk-input';
        input.type = 'text';
        input.inputMode = 'numeric';
        input.pattern = '[0-9]*';
        input.style.width = '140px';
        input.placeholder = 'speed';
        input.setAttribute('aria-label', round.fromLabel + ' to ' + round.toLabel + ', speed ' + (i + 1) + ' in kilometres per hour');
        input.value = round.guesses[i] || '';
        input.addEventListener('input', () => {
          const cleaned = input.value.replace(/[^0-9]/g, '');
          if(cleaned !== input.value) input.value = cleaned;
          round.guesses[i] = cleaned;
        });
        input.addEventListener('wheel', e => e.preventDefault(), { passive:false });
        input.addEventListener('blur', () => {
          if(input.value.trim() !== ''){
            round.checked[i] = true;
            const correct = Number(input.value) === Number(v.value);
            const isFirstAttempt = !round.recorded[i];
            renderBody();
            setTimeout(() => {
              const nextRow = bodyEl.querySelector('[data-order="' + (i + 1) + '"]');
              const nextInput = nextRow ? nextRow.querySelector('.rk-input') : null;
              if(nextInput) nextInput.focus();
            }, 30);
            if(isFirstAttempt){
              round.recorded[i] = true;
              recordAttempt(statKey(round.lineId, v.namedFrom, v.namedTo, v.position - 1), correct);
            }
          }
        });
        input.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); input.blur(); } });
        row.appendChild(input);
        if(!round.hintUsed){
          const hintBtn = document.createElement('button');
          hintBtn.className = 'rk-icon-btn';
          hintBtn.textContent = 'Hint';
          hintBtn.title = 'One hint per round \u2014 counts as a miss if used';
          hintBtn.onclick = () => {
            round.hintUsed = true;
            round.hintActiveIndex = i;
            renderBody();
          };
          row.appendChild(hintBtn);
        }
      } else {
        const guess = round.guesses[i];
        const wasHint = round.hintFlags[i];
        const correct = guess !== '' && guess !== undefined && Number(guess) === Number(v.value);
        const chip = document.createElement('div');
        chip.className = 'rk-board';
        chip.style.width = '140px';
        chip.style.cursor = 'pointer';
        chip.title = 'Click to try this one again';
        chip.style.background = correct ? 'var(--green)' : 'var(--red)';
        chip.style.color = '#0d1410';
        chip.innerHTML = wasHint
          ? '* ' + (guess || '\u2014') + ' <span class="u">hint used</span>'
          : (correct
            ? v.value + '<span class="u">km/h</span>'
            : (guess || '\u2014') + ' <span class="u">(was ' + v.value + ')</span>');
        chip.onclick = () => { round.checked[i] = false; renderBody(); };
        row.appendChild(chip);
      }
      if(v.note){
        const noteLabel = document.createElement('span');
        noteLabel.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--yellow); white-space:nowrap;';
        noteLabel.textContent = v.note;
        row.appendChild(noteLabel);
      }
      itemWrap.appendChild(row);
      itemWrap.style.marginBottom = '10px';
      boxCol.appendChild(itemWrap);
    });

    card.appendChild(boxCol);
    wrap.appendChild(card);

    const actions = document.createElement('div');
    actions.className = 'rk-action-row';
    actions.style.cssText = 'display:flex; gap:10px; margin-top:16px; flex-wrap:wrap;';
    const newBtn = document.createElement('button');
    newBtn.className = 'rk-btn primary';
    newBtn.textContent = 'New Mystery Round';
    newBtn.onclick = async () => {
      mysteryRound = await pickMysteryRound();
      renderBody();
    };
    actions.appendChild(newBtn);
    wrap.appendChild(actions);

    bodyEl.appendChild(wrap);

    if(checkedCount === 0 && round.values.length > 0 && round.hintActiveIndex === null){
      setTimeout(() => {
        const firstInput = bodyEl.querySelector('.rk-input');
        if(firstInput) firstInput.focus();
      }, 30);
    }
  }

  function addSectionHeader(wrap, label){
    const h = document.createElement('p');
    h.style.cssText = 'font-family:var(--font-body); font-weight:700; font-size:18px; letter-spacing:-0.01em; color:#fff; margin:0 0 16px;';
    h.textContent = label;
    wrap.appendChild(h);
  }

  function formatTimeAgo(ts){
    const diff = Date.now() - ts;
    const days = Math.floor(diff / 86400000);
    if(days <= 0) return 'today';
    if(days === 1) return 'yesterday';
    if(days < 7) return days + ' days ago';
    const weeks = Math.floor(days / 7);
    if(weeks < 5) return weeks + ' week' + (weeks===1?'':'s') + ' ago';
    const months = Math.floor(days / 30);
    return months + ' month' + (months===1?'':'s') + ' ago';
  }

  function lineOrderIndex(lineId){
    const idx = LINES.findIndex(l => l.id === lineId);
    return idx === -1 ? 999 : idx;
  }

  function lineDisplayName(lineId){
    const l = LINES.find(x => x.id === lineId);
    return l ? l.name + (l.direction ? ' \u2014 ' + l.direction : '') : lineId;
  }

  function makeTag(text){
    const tag = document.createElement('span');
    tag.className = 'rk-tag';
    tag.textContent = text;
    return tag;
  }

  function escapeHtml(value){
    const element = document.createElement('div');
    element.textContent = value == null ? '' : String(value);
    return element.innerHTML;
  }

  function findWeakestLine(){
    const perLine = {};
    Object.keys(statsData).forEach(k => {
      const { lineId } = parseStatKey(k);
      const s = statsData[k];
      if(!perLine[lineId]) perLine[lineId] = { attempts: 0, correct: 0 };
      perLine[lineId].attempts += s.attempts;
      perLine[lineId].correct += s.correct;
    });
    const rows = Object.entries(perLine)
      .map(([lineId, v]) => ({ lineId, attempts: v.attempts, correct: v.correct, pct: Math.round((v.correct / v.attempts) * 100) }))
      .filter(r => r.attempts >= 3)
      .sort((a, b) => a.pct - b.pct);
    return rows.length ? rows[0] : null;
  }

  // Per-line accuracy for every line that has at least one attempt, in the app's
  // canonical line order (not sorted by accuracy) \u2014 used for the Home screen's
  // full at-a-glance breakdown, as opposed to findWeakestLine's single worst line.
  function computePerLineStats(){
    const perLine = {};
    Object.keys(statsData).forEach(k => {
      const { lineId } = parseStatKey(k);
      const s = statsData[k];
      if(!perLine[lineId]) perLine[lineId] = { attempts: 0, correct: 0 };
      perLine[lineId].attempts += s.attempts;
      perLine[lineId].correct += s.correct;
    });
    return Object.entries(perLine)
      .map(([lineId, v]) => ({ lineId, attempts: v.attempts, correct: v.correct, pct: Math.round((v.correct / v.attempts) * 100) }))
      .sort((a, b) => lineOrderIndex(a.lineId) - lineOrderIndex(b.lineId));
  }

  // How much of the whole loaded network you've actually attempted at least once,
  // separate from how well you're doing on the parts you have tried.
  async function computeCoverage(){
    await loadCoverageIfNeeded();
    await recoverCoverageAutomatically();
    let totalBoxes = 0;
    let attemptedCount = 0;
    const perLine = [];
    for(const line of LINES){
      const segs = await loadSegments(line.id);
      const pairs = computeRangePairs(segs);
      const keys = [];
      pairs.forEach(pair => {
        pair.speeds.forEach((sp, i) => keys.push(statKey(line.id, pair.from, pair.to, i)));
      });
      const actualAttempted = keys.filter(key => Number(statsData[key] && statsData[key].attempts || 0) >= 1).length;
      const repairedComplete = Boolean(coverageState[line.id] && coverageState[line.id].complete);
      const countedAttempted = repairedComplete ? keys.length : actualAttempted;
      totalBoxes += keys.length;
      attemptedCount += countedAttempted;
      perLine.push({line, totalBoxes:keys.length, actualAttempted, countedAttempted, repairedComplete});
    }
    return { totalBoxes, attemptedCount, perLine };
  }

  async function renderLanding(){
    await loadStatsIfNeeded();

    const bg = document.createElement('div');
    bg.className = 'rk-home-bg';
    bg.innerHTML = '<svg viewBox="0 0 800 500" preserveAspectRatio="xMidYMin meet" xmlns="http://www.w3.org/2000/svg" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M 400 460 L 260 460 L 100 300 L 100 40" stroke="#e8636b" stroke-width="5"/>' +
      '<path d="M 400 460 L 540 460 L 700 300 L 700 40" stroke="#29c4e0" stroke-width="5"/>' +
      '<path d="M 400 460 L 400 340 L 260 200 L 100 200" stroke="#e8a830" stroke-width="5"/>' +
      '<path d="M 400 460 L 400 340 L 540 200 L 540 40" stroke="#44b87f" stroke-width="5"/>' +
      '<circle cx="400" cy="460" r="10" fill="#e9e6dc"/>' +
      '<ellipse cx="400" cy="340" rx="15" ry="7" fill="none" stroke="#e9e6dc" stroke-width="3" transform="rotate(45 400 340)"/>' +
      '<ellipse cx="260" cy="460" rx="15" ry="7" fill="none" stroke="#e9e6dc" stroke-width="3" transform="rotate(-30 260 460)"/>' +
      '<ellipse cx="540" cy="460" rx="15" ry="7" fill="none" stroke="#e9e6dc" stroke-width="3" transform="rotate(30 540 460)"/>' +
      '<circle cx="100" cy="380" r="4" fill="#e8636b"/><circle cx="100" cy="130" r="4" fill="#e8636b"/>' +
      '<circle cx="700" cy="380" r="4" fill="#29c4e0"/><circle cx="700" cy="130" r="4" fill="#29c4e0"/>' +
      '<circle cx="180" cy="200" r="4" fill="#e8a830"/>' +
      '<circle cx="470" cy="200" r="4" fill="#44b87f"/><circle cx="540" cy="120" r="4" fill="#44b87f"/>' +
      '</svg>';
    bodyEl.appendChild(bg);

    const wrap = document.createElement('div');
    wrap.className = 'rk-net-tree';
    wrap.style.position = 'relative';
    wrap.style.zIndex = '1';
    addSectionHeader(wrap, 'Home');

    const now = Date.now();
    const dueCount = Object.values(statsData).filter(s => s.nextDueAt !== undefined && s.nextDueAt <= now).length;
    const weakest = findWeakestLine();
    const hasAnyStats = Object.keys(statsData).length > 0;

    if(!hasAnyStats){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.style.marginTop = '16px';
      empty.innerHTML = '<div class="big">Ready when you are</div>' +
        'Run a Range Quiz, Journey, or Mystery round and this screen will start tracking your due reviews and weakest spots.';
      wrap.appendChild(empty);
    } else {
      if(weakest){
        const weakCard = document.createElement('div');
        weakCard.className = 'rk-seg';
        weakCard.style.marginTop = '12px';
        weakCard.style.cursor = 'pointer';
        weakCard.style.background = 'rgba(26,31,40,0.85)';
        weakCard.title = 'Tap to practice this line\u2019s weak spots';
        const top = document.createElement('div');
        top.className = 'rk-seg-top';
        const left = document.createElement('div');
        left.style.flex = '1';
        const stations = document.createElement('div');
        stations.className = 'rk-stations';
        stations.textContent = 'Weakest right now';
        left.appendChild(stations);
        const tags = document.createElement('div');
        tags.className = 'rk-tags';
        tags.appendChild(makeTag(lineDisplayName(weakest.lineId)));
        tags.appendChild(makeTag('Tap to practice'));
        left.appendChild(tags);
        top.appendChild(left);
        const board = document.createElement('div');
        board.className = 'rk-board';
        board.style.background = weakest.pct < 60 ? 'var(--red)' : 'var(--yellow)';
        board.style.color = '#0d1410';
        board.innerHTML = weakest.pct + '%<span class="u">' + weakest.correct + '/' + weakest.attempts + '</span>';
        top.appendChild(board);
        weakCard.appendChild(top);
        weakCard.onclick = () => {
          const lineItems = Object.keys(statsData)
            .map(k => ({ key: k, ...parseStatKey(k), ...statsData[k] }))
            .filter(r => r.lineId === weakest.lineId && r.attempts >= 1)
            .sort((a, b) => (a.correct / a.attempts) - (b.correct / b.attempts));
          focusRound = lineItems.slice(0, 25).map(row => ({
            lineId: row.lineId,
            lineLabel: lineDisplayName(row.lineId),
            from: row.from,
            to: row.to,
            i: row.i,
            key: row.key,
          }));
          activeView = 'focus';
          focusQuizOrigin = 'home';
          focusGuesses = new Array(focusRound.length).fill('');
          focusChecked = new Array(focusRound.length).fill(false);
      focusRecorded = new Array(focusRound.length).fill(false);
      focusHintUsed = false;
      focusHintActiveIndex = null;
      focusHintFlags = new Array(focusRound.length).fill(false);
          renderBody();
        };
        wrap.appendChild(weakCard);
      }

      const coverage = await computeCoverage();
      const coveragePct = coverage.totalBoxes > 0 ? Math.round((coverage.attemptedCount / coverage.totalBoxes) * 100) : 0;
      const coverageCard = document.createElement('div');
      coverageCard.style.cssText = 'background:rgba(34,40,52,0.88); border-radius:8px; padding:18px 20px; margin-top:12px; display:flex; align-items:center; gap:18px;';

      const ringSize = 80;
      const strokeWidth = 7;
      const radius = (ringSize - strokeWidth) / 2;
      const circumference = 2 * Math.PI * radius;
      const ringColor = coveragePct < 30 ? '#e2543d' : (coveragePct < 70 ? '#f0b429' : '#3fb37f');

      const ringWrap = document.createElement('div');
      ringWrap.style.cssText = 'position:relative; width:' + ringSize + 'px; height:' + ringSize + 'px; flex-shrink:0;';
      ringWrap.innerHTML = '<svg width="' + ringSize + '" height="' + ringSize + '" viewBox="0 0 ' + ringSize + ' ' + ringSize + '">' +
        '<circle cx="' + ringSize/2 + '" cy="' + ringSize/2 + '" r="' + radius + '" fill="none" stroke="#2a303c" stroke-width="' + strokeWidth + '"/>' +
        '<circle class="rk-ring-fill" cx="' + ringSize/2 + '" cy="' + ringSize/2 + '" r="' + radius + '" fill="none" stroke="' + ringColor + '" stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + circumference + '" transform="rotate(-90 ' + ringSize/2 + ' ' + ringSize/2 + ')" style="transition:stroke-dashoffset 1s ease-out;"/>' +
        '</svg>' +
        '<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">' +
        '<span style="font-family:\'DM Sans\',sans-serif; font-weight:600; font-size:20px;">' + coveragePct + '%</span></div>';
      coverageCard.appendChild(ringWrap);

      const textCol = document.createElement('div');
      textCol.innerHTML = '<p style="font-family:\'JetBrains Mono\',monospace; font-size:11px; letter-spacing:0.05em; text-transform:uppercase; color:var(--muted); margin:0 0 4px;">Network coverage</p>' +
        '<p style="font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--muted); margin:0;">' + coverage.attemptedCount + ' of ' + coverage.totalBoxes + ' speed changes covered</p>';
      coverageCard.appendChild(textCol);

      wrap.appendChild(coverageCard);

      setTimeout(() => {
        const fillCircle = bodyEl.querySelector('.rk-ring-fill');
        if(fillCircle){
          const targetOffset = circumference - (circumference * coveragePct / 100);
          fillCircle.style.strokeDashoffset = targetOffset;
        }
      }, 50);

      const perLineStats = computePerLineStats();
      if(perLineStats.length > 0){
        const perLineSection = document.createElement('div');
        perLineSection.style.cssText = 'margin-top:20px;';
        const perLineTitle = document.createElement('p');
        perLineTitle.className = 'rk-form-title';
        perLineTitle.style.cursor = 'pointer';
        perLineTitle.textContent = 'By Line ' + (showByLineExpanded ? '\u25b4' : '\u25be');
        perLineTitle.onclick = () => { showByLineExpanded = !showByLineExpanded; renderBody(); };
        perLineSection.appendChild(perLineTitle);

        if(!showByLineExpanded){
          const chipRow = document.createElement('div');
          chipRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px;';
          perLineStats.forEach(row => {
            const lineObj = LINES.find(l => l.id === row.lineId);
            const pctColor = row.pct < 60 ? '#e2543d' : (row.pct < 85 ? '#f0b429' : '#3fb37f');
            const chip = document.createElement('div');
            chip.style.cssText = 'display:flex; align-items:center; gap:5px; background:var(--panel-raised); border-radius:8px; padding:6px 10px; font-family:\'JetBrains Mono\',monospace; font-size:11px; cursor:pointer; border-left:3px solid ' + (lineObj ? lineObj.hue : 'var(--steel)') + ';';
            chip.innerHTML = '<span style="color:var(--paper);">' + escapeHtml(lineObj ? (lineObj.name.replace(' Line','') + ' ' + (lineObj.direction||'')) : row.lineId) + '</span>' +
              '<span style="color:' + pctColor + '; font-weight:600;">' + row.pct + '%</span>';
            chip.onclick = (e) => {
              e.stopPropagation();
              activeLine = row.lineId;
              if(lineObj) selectedLineGroup = lineObj.name;
              closeAllViews();
              renderTabs();
              renderBody();
            };
            chipRow.appendChild(chip);
          });
          perLineSection.appendChild(chipRow);
        } else {
          perLineStats.forEach(row => {
            const lineObj = LINES.find(l => l.id === row.lineId);
            const rowEl = document.createElement('div');
            rowEl.className = 'rk-ts-row';
            rowEl.style.cursor = 'pointer';
            rowEl.onclick = () => {
              activeLine = row.lineId;
              if(lineObj) selectedLineGroup = lineObj.name;
              closeAllViews();
              renderTabs();
              renderBody();
            };
            const nameEl = document.createElement('span');
            nameEl.style.cssText = 'flex:1; font-family:\'DM Sans\',sans-serif; font-size:13.5px; color:var(--paper);';
            nameEl.textContent = lineDisplayName(row.lineId);
            const pctEl = document.createElement('span');
            const pctColor = row.pct < 60 ? 'var(--red)' : (row.pct < 85 ? 'var(--yellow)' : 'var(--green)');
            pctEl.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-weight:600; color:' + pctColor + ';';
            pctEl.textContent = row.pct + '% (' + row.correct + '/' + row.attempts + ')';
            rowEl.appendChild(nameEl);
            rowEl.appendChild(pctEl);
            perLineSection.appendChild(rowEl);
          });
        }
        wrap.appendChild(perLineSection);
      }
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; flex-direction:column; gap:10px; margin-top:20px;';

    if(dueCount > 0){
      const reviewBtn = document.createElement('button');
      reviewBtn.className = 'rk-btn primary';
      reviewBtn.textContent = 'Start Review (' + dueCount + ' due)';
      reviewBtn.onclick = () => { closeAllViews(); activeView = 'review'; renderBody(); };
      actions.appendChild(reviewBtn);
    }

    const browseBtn = document.createElement('button');
    browseBtn.className = 'rk-btn';
    browseBtn.textContent = 'Browse Lines / Quiz';
    browseBtn.onclick = () => { closeAllViews(); activeView = 'network'; renderBody(); };
    actions.appendChild(browseBtn);

    wrap.appendChild(actions);

    let lastBackupAt = null;
    try{
      const res = await storageAdapter.get('lastBackupAt', false);
      if(res && res.value) lastBackupAt = Number(res.value);
    }catch(e){}

    const backupRow = document.createElement('div');
    backupRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:16px; padding-top:14px; border-top:1px solid var(--steel-soft);';
    const backupLabel = document.createElement('span');
    backupLabel.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--muted);';
    backupLabel.textContent = lastBackupAt ? 'Last backed up ' + formatTimeAgo(lastBackupAt) : 'Never backed up';
    backupRow.appendChild(backupLabel);
    const backupLink = document.createElement('button');
    backupLink.textContent = 'Export now';
    backupLink.style.cssText = 'background:none; border:none; color:var(--accent-1); font-family:\'JetBrains Mono\',monospace; font-size:11px; letter-spacing:0.03em; cursor:pointer; padding:2px 0;';
    backupLink.onclick = async () => { await exportAllData(); renderBody(); };
    backupRow.appendChild(backupLink);
    wrap.appendChild(backupRow);

    bodyEl.appendChild(wrap);
  }

  async function renderProgress(){
    await loadStatsIfNeeded();
    const wrap = document.createElement('div');
    wrap.className = 'rk-net-tree';
    addSectionHeader(wrap, 'Progress');

    const keys = Object.keys(statsData);
    const totalAttempts = keys.reduce((a, k) => a + statsData[k].attempts, 0);

    if(keys.length === 0 || totalAttempts === 0){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.innerHTML = '<div class="big">No attempts recorded yet</div>' +
        'Run some Range Quiz or Mystery rounds and this page will start tracking where you\u2019re strong and where you need more work.';
      wrap.appendChild(empty);
      bodyEl.appendChild(wrap);
      return;
    }

    const totalCorrect = keys.reduce((a, k) => a + statsData[k].correct, 0);
    const overallPct = Math.round((totalCorrect / totalAttempts) * 100);

    const overallCard = document.createElement('div');
    overallCard.style.cssText = 'background:var(--panel-raised); border-radius:8px; padding:18px 20px; display:flex; align-items:center; gap:18px;';

    const ringSize = 80;
    const strokeWidth = 7;
    const radius = (ringSize - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const ringColor = overallPct < 60 ? '#e2543d' : (overallPct < 85 ? '#f0b429' : '#3fb37f');

    const ringWrap = document.createElement('div');
    ringWrap.style.cssText = 'position:relative; width:' + ringSize + 'px; height:' + ringSize + 'px; flex-shrink:0;';
    ringWrap.innerHTML = '<svg width="' + ringSize + '" height="' + ringSize + '" viewBox="0 0 ' + ringSize + ' ' + ringSize + '">' +
      '<circle cx="' + ringSize/2 + '" cy="' + ringSize/2 + '" r="' + radius + '" fill="none" stroke="#2a303c" stroke-width="' + strokeWidth + '"/>' +
      '<circle class="rk-ring-progress" cx="' + ringSize/2 + '" cy="' + ringSize/2 + '" r="' + radius + '" fill="none" stroke="' + ringColor + '" stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + circumference + '" transform="rotate(-90 ' + ringSize/2 + ' ' + ringSize/2 + ')" style="transition:stroke-dashoffset 1s ease-out;"/>' +
      '</svg>' +
      '<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">' +
      '<span style="font-family:\'DM Sans\',sans-serif; font-weight:600; font-size:20px;">' + overallPct + '%</span></div>';
    overallCard.appendChild(ringWrap);

    const textCol = document.createElement('div');
    textCol.innerHTML = '<p style="font-family:\'JetBrains Mono\',monospace; font-size:11px; letter-spacing:0.05em; text-transform:uppercase; color:var(--muted); margin:0 0 4px;">Overall Accuracy</p>' +
      '<p style="font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--muted); margin:0;">' + totalCorrect + ' correct out of ' + totalAttempts + ' attempts</p>';
    overallCard.appendChild(textCol);

    wrap.appendChild(overallCard);

    setTimeout(() => {
      const fillCircle = bodyEl.querySelector('.rk-ring-progress');
      if(fillCircle){
        const targetOffset = circumference - (circumference * overallPct / 100);
        fillCircle.style.strokeDashoffset = targetOffset;
      }
    }, 50);

    // per-line breakdown
    const perLine = {};
    keys.forEach(k => {
      const { lineId } = parseStatKey(k);
      if(!perLine[lineId]) perLine[lineId] = { attempts: 0, correct: 0 };
      perLine[lineId].attempts += statsData[k].attempts;
      perLine[lineId].correct += statsData[k].correct;
    });
    const lineRows = Object.entries(perLine).map(([lineId, v]) => ({
      lineId, attempts: v.attempts, correct: v.correct, pct: Math.round((v.correct / v.attempts) * 100),
    })).sort((a, b) => a.pct - b.pct);

    const lineSection = document.createElement('div');
    lineSection.style.cssText = 'margin-top:20px;';
    const lineTitle = document.createElement('p');
    lineTitle.className = 'rk-form-title';
    lineTitle.textContent = 'By Line';
    lineSection.appendChild(lineTitle);
    lineRows.forEach(row => {
      const lineObj = LINES.find(l => l.id === row.lineId);
      const rowEl = document.createElement('div');
      rowEl.className = 'rk-ts-row';
      rowEl.style.cursor = 'pointer';
      rowEl.onclick = () => {
        activeLine = row.lineId;
        if(lineObj) selectedLineGroup = lineObj.name;
        closeAllViews();
        renderTabs();
        renderBody();
      };
      const nameEl = document.createElement('span');
      nameEl.style.cssText = 'flex:1; font-family:\'DM Sans\',sans-serif; font-size:13.5px; color:var(--paper);';
      nameEl.textContent = lineDisplayName(row.lineId);
      const pctEl = document.createElement('span');
      const pctColor = row.pct < 60 ? 'var(--red)' : (row.pct < 85 ? 'var(--yellow)' : 'var(--green)');
      pctEl.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-weight:600; color:' + pctColor + ';';
      pctEl.textContent = row.pct + '% (' + row.correct + '/' + row.attempts + ')';
      rowEl.appendChild(nameEl);
      rowEl.appendChild(pctEl);
      lineSection.appendChild(rowEl);
    });
    wrap.appendChild(lineSection);

    // weakest individual boxes
    const itemRows = keys.map(k => {
      const parsed = parseStatKey(k);
      const s = statsData[k];
      return { key: k, ...parsed, attempts: s.attempts, correct: s.correct, pct: (s.correct / s.attempts) * 100 };
    }).filter(r => r.attempts >= 1).sort((a, b) => a.pct - b.pct || b.attempts - a.attempts);

    const weakest = itemRows.slice(0, 15);
    const weakestGrouped = [...weakest].sort((a, b) => {
      const lineDiff = lineOrderIndex(a.lineId) - lineOrderIndex(b.lineId);
      if(lineDiff !== 0) return lineDiff;
      return a.pct - b.pct;
    });

    const weakSection = document.createElement('div');
    weakSection.style.cssText = 'margin-top:24px;';
    const weakTitle = document.createElement('p');
    weakTitle.className = 'rk-form-title';
    weakTitle.textContent = 'Focus Areas \u2014 Your Weakest Spots';
    weakSection.appendChild(weakTitle);
    for(const row of weakestGrouped){
      const ctx = await resolveFocusItemContext(row);
      const card = document.createElement('div');
      card.className = 'rk-seg';
      const top = document.createElement('div');
      top.className = 'rk-seg-top';
      const left = document.createElement('div');
      left.style.flex = '1';
      const stations = document.createElement('div');
      stations.className = 'rk-stations';
      stations.innerHTML = escapeHtml(ctx.namedFrom) + '<span class="arrow">\u2192</span>' + escapeHtml(ctx.namedTo);
      left.appendChild(stations);
      const tags = document.createElement('div');
      tags.className = 'rk-tags';
      tags.appendChild(makeTag(lineDisplayName(row.lineId)));
      if(ctx.total > 1) tags.appendChild(makeTag('Speed ' + ctx.position + ' of ' + ctx.total));
      left.appendChild(tags);
      top.appendChild(left);
      const pctBoard = document.createElement('div');
      pctBoard.className = 'rk-board';
      const boardColor = row.pct < 60 ? 'var(--red)' : (row.pct < 85 ? 'var(--yellow)' : 'var(--green)');
      pctBoard.style.background = boardColor;
      pctBoard.style.color = '#0d1410';
      pctBoard.innerHTML = Math.round(row.pct) + '%<span class="u">' + row.correct + '/' + row.attempts + '</span>';
      top.appendChild(pctBoard);
      card.appendChild(top);
      weakSection.appendChild(card);
    }
    wrap.appendChild(weakSection);

    const actions = document.createElement('div');
    actions.className = 'rk-action-row';
    actions.style.cssText = 'display:flex; gap:10px; margin-top:16px; flex-wrap:wrap;';
    const focusBtn = document.createElement('button');
    focusBtn.className = 'rk-btn primary';
    focusBtn.textContent = 'Start Focus Quiz on These';
    focusBtn.disabled = weakest.length === 0;
    focusBtn.onclick = () => {
      focusRound = weakestGrouped.map(row => ({
        lineId: row.lineId,
        lineLabel: lineDisplayName(row.lineId),
        from: row.from,
        to: row.to,
        i: row.i,
        key: row.key,
      }));
      // resolve the correct expected value for each item by looking it up live from current segments
      activeView = 'focus';
      focusQuizOrigin = 'progress';
      focusGuesses = new Array(focusRound.length).fill('');
      focusChecked = new Array(focusRound.length).fill(false);
      focusRecorded = new Array(focusRound.length).fill(false);
      focusHintUsed = false;
      focusHintActiveIndex = null;
      focusHintFlags = new Array(focusRound.length).fill(false);
      renderBody();
    };
    actions.appendChild(focusBtn);
    wrap.appendChild(actions);

    bodyEl.appendChild(wrap);
  }

  async function resolveFocusItemValue(item){
    const segs = await loadSegments(item.lineId);
    const pairs = computeRangePairs(segs);
    const pair = pairs.find(p => p.from === item.from && p.to === item.to);
    if(pair && pair.speeds[item.i]) return pair.speeds[item.i];
    // Fall back to the full collapsed sequence, which covers every boundary point
    // (not just named stations) \u2014 needed for items that came from a Mystery round,
    // since those can start or end at an internal marker rather than a real station.
    const { points, collapsed } = computeFullSequence(segs);
    const match = collapsed.find(c => points[c.fromIdx] === item.from && points[c.toIdx] === item.to);
    if(match) return { value: match.value, note: match.note };
    return null;
  }

  // Tells you WHICH speed change within a multi-change stretch this item refers to
  // (e.g. "2 of 3") \u2014 without this, a review item for a stretch with several speed
  // changes gives no clue which one is actually being asked for.
  async function resolveFocusItemContext(item){
    const segs = await loadSegments(item.lineId);
    const pairs = computeRangePairs(segs);
    const pair = pairs.find(p => p.from === item.from && p.to === item.to);
    if(pair && pair.speeds[item.i]){
      return { expected: pair.speeds[item.i], position: Number(item.i) + 1, total: pair.speeds.length, namedFrom: item.from, namedTo: item.to };
    }
    const { points, collapsed } = computeFullSequence(segs);
    const match = collapsed.find(c => points[c.fromIdx] === item.from && points[c.toIdx] === item.to);
    if(match){
      const ctx = namedPairPosition(points, collapsed, match);
      return { expected: { value: match.value, note: match.note }, position: ctx.position, total: ctx.total, namedFrom: ctx.namedFrom, namedTo: ctx.namedTo };
    }
    return { expected: null, position: 1, total: 1, namedFrom: item.from, namedTo: item.to };
  }

  async function renderFocusQuiz(){
    const wrap = document.createElement('div');
    wrap.className = 'rk-net-tree';

    if(!focusRound || focusRound.length === 0){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.innerHTML = '<div class="big">No focus items</div>Head back to Progress and hit \u201cStart Focus Quiz\u201d once you have some weak spots tracked.';
      wrap.appendChild(empty);
      bodyEl.appendChild(wrap);
      return;
    }

    if(!Array.isArray(focusRecorded) || focusRecorded.length !== focusRound.length){
      focusRecorded = new Array(focusRound.length).fill(false);
      focusHintUsed = false;
      focusHintActiveIndex = null;
      focusHintFlags = new Array(focusRound.length).fill(false);
    }

    // Prefetch which speed-change number (e.g. "2 of 3") each item refers to,
    // so a stretch with multiple changes doesn't leave you guessing which one is due.
    for(let idx=focusRound.length-1; idx>=0; idx--){
      const item = focusRound[idx];
      const ctx = await resolveFocusItemContext(item);
      if(!ctx.expected){
        // The route data changed after this review item was originally recorded.
        // Drop only this obsolete item rather than showing a broken "data changed" card.
        if(item.key && statsData[item.key]){
          delete statsData[item.key];
          try{ await saveStats(); }catch(e){}
        }
        focusRound.splice(idx,1);
        focusGuesses.splice(idx,1);
        focusChecked.splice(idx,1);
        focusRecorded.splice(idx,1);
        focusHintFlags.splice(idx,1);
        continue;
      }
      item.position = ctx.position;
      item.total = ctx.total;
      item.namedFrom = ctx.namedFrom;
      item.namedTo = ctx.namedTo;
      item.expected = ctx.expected;
    }

    if(focusRound.length === 0){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.innerHTML = '<div class="big">Review data refreshed</div>Old review items that no longer match the current route data were removed. Start a new quiz to rebuild those items from the corrected speeds.';
      wrap.appendChild(empty);
      bodyEl.appendChild(wrap);
      return;
    }

    const checkedCount = focusChecked.filter(Boolean).length;
    const bar = document.createElement('div');
    bar.className = 'rk-quizbar';
    bar.innerHTML = '<span>Focus Quiz</span><span>Checked ' + checkedCount + ' / ' + focusRound.length + '</span>';
    wrap.appendChild(bar);

    const track = document.createElement('div');
    track.className = 'rk-track';

    let lastLineId = null;
    focusRound.forEach((item, idx) => {
      if(item.lineId !== lastLineId){
        lastLineId = item.lineId;
        const groupHeader = document.createElement('div');
        groupHeader.className = 'rk-ts-station';
        const lineObj = LINES.find(l => l.id === item.lineId);
        if(lineObj) groupHeader.style.setProperty('--line-hue', lineObj.hue);
        groupHeader.textContent = item.lineLabel;
        track.appendChild(groupHeader);
      }

      const card = document.createElement('div');
      card.className = 'rk-seg';
      card.dataset.order = idx;
      const top = document.createElement('div');
      top.className = 'rk-seg-top';
      const left = document.createElement('div');
      left.style.flex = '1';
      const stations = document.createElement('div');
      stations.className = 'rk-stations';
      stations.innerHTML = escapeHtml(item.namedFrom || item.from) + '<span class="arrow">\u2192</span>' + escapeHtml(item.namedTo || item.to);
      left.appendChild(stations);
      if(item.total > 1){
        const tags = document.createElement('div');
        tags.className = 'rk-tags';
        tags.appendChild(makeTag('Speed ' + item.position + ' of ' + item.total));
        left.appendChild(tags);
      }
      top.appendChild(left);
      card.appendChild(top);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:10px;';

      const hintIsActiveHere = focusHintActiveIndex === idx && item.expected;

      if(hintIsActiveHere){
        renderHintChoice(row, item.expected.value, (chosen) => {
          focusGuesses[idx] = chosen;
          focusChecked[idx] = true;
          focusHintFlags[idx] = true;
          focusHintActiveIndex = null;
          renderBody();
          if(!focusRecorded[idx]){
            focusRecorded[idx] = true;
            recordAttempt(item.key, false);
          }
        });
      } else if(!focusChecked[idx]){
        const input = document.createElement('input');
        input.className = 'rk-input';
        input.type = 'text';
        input.inputMode = 'numeric';
        input.pattern = '[0-9]*';
        input.style.width = '140px';
        input.placeholder = 'speed';
        input.setAttribute('aria-label', (item.namedFrom || item.from) + ' to ' + (item.namedTo || item.to) + ', speed in kilometres per hour');
        input.value = focusGuesses[idx] || '';
        input.addEventListener('input', () => {
          const cleaned = input.value.replace(/[^0-9]/g, '');
          if(cleaned !== input.value) input.value = cleaned;
          focusGuesses[idx] = cleaned;
        });
        input.addEventListener('wheel', e => e.preventDefault(), { passive:false });
        input.addEventListener('blur', async () => {
          if(input.value.trim() !== ''){
            const expected = await resolveFocusItemValue(item);
            focusChecked[idx] = true;
            const correct = expected && Number(input.value) === Number(expected.value);
            item.expected = expected;
            const isFirstAttempt = !focusRecorded[idx];
            renderBody();
            setTimeout(() => {
              const nextCard = bodyEl.querySelector('[data-order="' + (idx + 1) + '"]');
              const nextInput = nextCard ? nextCard.querySelector('.rk-input') : null;
              if(nextInput) nextInput.focus();
            }, 30);
            if(isFirstAttempt){
              focusRecorded[idx] = true;
              recordAttempt(item.key, !!correct);
            }
          }
        });
        input.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); input.blur(); } });
        row.appendChild(input);
        if(!focusHintUsed){
          const hintBtn = document.createElement('button');
          hintBtn.className = 'rk-icon-btn';
          hintBtn.textContent = 'Hint';
          hintBtn.title = 'One hint per session \u2014 counts as a miss if used';
          hintBtn.onclick = async () => {
            focusHintUsed = true;
            const expected = await resolveFocusItemValue(item);
            item.expected = expected;
            if(expected){
              focusHintActiveIndex = idx;
              renderBody();
            }
          };
          row.appendChild(hintBtn);
        }
      } else {
        const guess = focusGuesses[idx];
        const expected = item.expected;
        const wasHint = focusHintFlags[idx];
        const correct = expected && guess !== '' && Number(guess) === Number(expected.value);
        const chip = document.createElement('div');
        chip.className = 'rk-board';
        chip.style.width = '140px';
        chip.style.cursor = 'pointer';
        chip.title = 'Click to try this one again';
        chip.style.background = correct ? 'var(--green)' : 'var(--red)';
        chip.style.color = '#0d1410';
        chip.innerHTML = wasHint
          ? '* ' + (guess || '\u2014') + ' <span class="u">hint used</span>'
          : (expected
            ? (correct ? expected.value + '<span class="u">km/h</span>' : (guess || '\u2014') + ' <span class="u">(was ' + expected.value + ')</span>')
            : 'data changed');
        chip.onclick = () => { focusChecked[idx] = false; renderBody(); };
        row.appendChild(chip);
        if(expected && expected.note){
          const noteLabel = document.createElement('span');
          noteLabel.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--yellow); white-space:nowrap;';
          noteLabel.textContent = expected.note;
          row.appendChild(noteLabel);
        }
      }
      card.appendChild(row);
      track.appendChild(card);
    });

    wrap.appendChild(track);

    const actions = document.createElement('div');
    actions.className = 'rk-action-row';
    actions.style.cssText = 'display:flex; gap:10px; margin-top:16px; flex-wrap:wrap;';
    const backBtn = document.createElement('button');
    backBtn.className = 'rk-btn primary';
    backBtn.textContent = focusQuizOrigin === 'review' ? 'Back to Review' : (focusQuizOrigin === 'home' ? 'Back to Home' : 'Back to Progress');
    backBtn.onclick = () => {
      activeView = focusQuizOrigin === 'review' ? 'review' : (focusQuizOrigin === 'home' ? 'home' : 'progress');
      renderBody();
    };
    actions.appendChild(backBtn);
    wrap.appendChild(actions);

    bodyEl.appendChild(wrap);

    if(checkedCount === 0 && focusRound.length > 0 && focusHintActiveIndex === null){
      setTimeout(() => {
        const firstInput = bodyEl.querySelector('.rk-input');
        if(firstInput) firstInput.focus();
      }, 30);
    }
  }

  async function renderReview(){
    await loadStatsIfNeeded();
    const wrap = document.createElement('div');
    wrap.className = 'rk-net-tree';
    addSectionHeader(wrap, 'Review');

    const now = Date.now();
    const scheduled = Object.keys(statsData)
      .filter(k => statsData[k].nextDueAt !== undefined)
      .map(k => ({ key: k, ...parseStatKey(k), ...statsData[k] }));

    if(scheduled.length === 0){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.innerHTML = '<div class="big">Nothing scheduled yet</div>' +
        'Spaced repetition kicks in once you\u2019ve run some Range Quiz or Mystery attempts. Get something right and it\u2019s marked off for a while; get it wrong and it comes straight back.';
      wrap.appendChild(empty);
      bodyEl.appendChild(wrap);
      return;
    }

    const due = scheduled.filter(r => r.nextDueAt <= now).sort((a, b) => {
      const lineDiff = lineOrderIndex(a.lineId) - lineOrderIndex(b.lineId);
      if(lineDiff !== 0) return lineDiff;
      return a.nextDueAt - b.nextDueAt;
    });

    const bar = document.createElement('div');
    bar.className = 'rk-quizbar';
    bar.innerHTML = '<span>Due for review</span><span><b>' + due.length + '</b> item' + (due.length===1?'':'s') + '</span>';
    wrap.appendChild(bar);

    if(due.length > 0){
      const dueSection = document.createElement('div');
      dueSection.style.cssText = 'margin-top:16px;';
      for(const row of due.slice(0, 20)){
        const ctx = await resolveFocusItemContext(row);
        const card = document.createElement('div');
        card.className = 'rk-seg';
        const top = document.createElement('div');
        top.className = 'rk-seg-top';
        const checkbox = document.createElement('span');
        checkbox.textContent = '\u2610';
        checkbox.style.cssText = 'font-size:18px; color:var(--muted); margin-right:10px; line-height:1;';
        top.appendChild(checkbox);
        const left = document.createElement('div');
        left.style.flex = '1';
        const stations = document.createElement('div');
        stations.className = 'rk-stations';
        stations.innerHTML = escapeHtml(ctx.namedFrom) + '<span class="arrow">\u2192</span>' + escapeHtml(ctx.namedTo);
        left.appendChild(stations);
        const tags = document.createElement('div');
        tags.className = 'rk-tags';
        tags.appendChild(makeTag(lineDisplayName(row.lineId)));
        if(ctx.total > 1) tags.appendChild(makeTag('Speed ' + ctx.position + ' of ' + ctx.total));
        left.appendChild(tags);
        top.appendChild(left);
        card.appendChild(top);
        dueSection.appendChild(card);
      }
      wrap.appendChild(dueSection);

      const actions = document.createElement('div');
      actions.className = 'rk-action-row';
    actions.style.cssText = 'display:flex; gap:10px; margin-top:16px; flex-wrap:wrap;';
      const startBtn = document.createElement('button');
      startBtn.className = 'rk-btn primary';
      startBtn.textContent = 'Start Review Session';
      startBtn.onclick = () => {
        focusRound = due.slice(0, 25).map(row => ({
          lineId: row.lineId,
          lineLabel: lineDisplayName(row.lineId),
          from: row.from,
          to: row.to,
          i: row.i,
          key: row.key,
        }));
        activeView = 'focus';
        focusQuizOrigin = 'review';
        focusGuesses = new Array(focusRound.length).fill('');
        focusChecked = new Array(focusRound.length).fill(false);
      focusRecorded = new Array(focusRound.length).fill(false);
      focusHintUsed = false;
      focusHintActiveIndex = null;
      focusHintFlags = new Array(focusRound.length).fill(false);
        renderBody();
      };
      actions.appendChild(startBtn);
      wrap.appendChild(actions);
    } else {
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.innerHTML = '<div class="big">Nothing due right now</div>Nice work \u2014 everything you\u2019ve practiced is checked off for the moment.';
      wrap.appendChild(empty);
    }

    bodyEl.appendChild(wrap);
  }

  async function renderCompare(){
    const wrap = document.createElement('div');
    wrap.className = 'rk-net-tree';
    addSectionHeader(wrap, 'Compare Directions');

    const intro = document.createElement('p');
    intro.style.cssText = 'font-family:\'Inter\',sans-serif; font-size:13px; color:var(--muted); line-height:1.6; margin:0 0 16px;';
    intro.textContent = 'Matches each Down stretch against its Up counterpart and only shows the ones where the speeds don\u2019t mirror each other \u2014 handy for spotting genuine direction-specific differences (curves, gradients, signal sighting) rather than assuming symmetry.';
    wrap.appendChild(intro);

    if(!comparePickerGroup || !TRACK_SPEED_GROUPS.find(g => g.name === comparePickerGroup)){
      comparePickerGroup = TRACK_SPEED_GROUPS[0].name;
    }
    const group = TRACK_SPEED_GROUPS.find(g => g.name === comparePickerGroup);

    const pickerRow = document.createElement('div');
    pickerRow.className = 'rk-line-picker';
    pickerRow.style.setProperty('--line-hue', group.hue);
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Compare Directions rail line');
    TRACK_SPEED_GROUPS.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.name;
      opt.textContent = g.name;
      if(g.name === group.name) opt.selected = true;
      select.appendChild(opt);
    });
    select.onchange = () => { comparePickerGroup = select.value; renderBody(); };
    pickerRow.appendChild(select);
    wrap.appendChild(pickerRow);

    const downSegs = await loadSegments(group.down);
    const upSegs = await loadSegments(group.up);
    const downPairs = computeRangePairs(downSegs);
    const upPairs = computeRangePairs(upSegs);

    if(downPairs.length === 0 || upPairs.length === 0){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.style.marginTop = '16px';
      empty.innerHTML = '<div class="big">Not enough data yet</div>Need both directions loaded for this line before they can be compared.';
      wrap.appendChild(empty);
      bodyEl.appendChild(wrap);
      return;
    }

    const diffs = [];
    downPairs.forEach(dPair => {
      const uPair = upPairs.find(p => p.from === dPair.to && p.to === dPair.from);
      if(!uPair) return;
      const downVals = dPair.speeds.map(s => s.value);
      const upVals = uPair.speeds.map(s => s.value);
      const upValsReversed = [...upVals].reverse();
      const same = downVals.length === upValsReversed.length && downVals.every((v, i) => Number(v) === Number(upValsReversed[i]));
      if(!same){
        diffs.push({ from: dPair.from, to: dPair.to, downVals, upVals, upValsReversed });
      }
    });

    const bar = document.createElement('div');
    bar.className = 'rk-quizbar';
    bar.innerHTML = '<span>' + group.name + '</span><span>' + diffs.length + ' stretch' + (diffs.length===1?'':'es') + (diffs.length===1?' differs':' differ') + '</span>';
    wrap.appendChild(bar);

    if(diffs.length === 0){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.style.marginTop = '16px';
      empty.innerHTML = '<div class="big">Fully symmetric</div>Every stretch on this line has matching speeds in both directions.';
      wrap.appendChild(empty);
    } else {
      diffs.forEach(d => {
        const card = document.createElement('div');
        card.className = 'rk-seg';
        const top = document.createElement('div');
        top.className = 'rk-seg-top';
        const left = document.createElement('div');
        left.style.flex = '1';
        const stations = document.createElement('div');
        stations.className = 'rk-stations';
        stations.innerHTML = escapeHtml(d.from) + '<span class="arrow">\u2194</span>' + escapeHtml(d.to);
        left.appendChild(stations);
        top.appendChild(left);
        card.appendChild(top);

        const rowsWrap = document.createElement('div');
        rowsWrap.style.cssText = 'margin-top:12px; display:flex; flex-direction:column; gap:10px;';

        [
          { label: '\u2193 Down', vals: d.downVals, compareVals: d.upValsReversed },
          { label: '\u2191 Up', vals: d.upVals, compareVals: [...d.downVals].reverse() },
        ].forEach(dir => {
          const dirRow = document.createElement('div');
          const dirLabel = document.createElement('div');
          dirLabel.style.cssText = 'font-family:var(--font-mono); font-size:10px; color:var(--muted); letter-spacing:0.04em; margin-bottom:5px;';
          dirLabel.textContent = dir.label;
          dirRow.appendChild(dirLabel);
          const chipRow = document.createElement('div');
          chipRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:5px;';
          dir.vals.forEach((v, idx) => {
            const chip = document.createElement('span');
            const otherVal = dir.compareVals[idx];
            const differs = otherVal !== undefined && Number(v) !== Number(otherVal);
            chip.style.cssText = 'font-family:var(--font-body); font-weight:700; font-size:13px; padding:4px 10px; border-radius:6px; ' +
              (differs ? 'background:rgba(240,180,41,0.15); color:#f0b429;' : 'background:var(--panel); color:var(--paper);');
            chip.textContent = v;
            chipRow.appendChild(chip);
          });
          dirRow.appendChild(chipRow);
          rowsWrap.appendChild(dirRow);
        });

        card.appendChild(rowsWrap);
        wrap.appendChild(card);
      });
    }

    bodyEl.appendChild(wrap);
  }

  async function renderJourney(){
    const wrap = document.createElement('div');
    wrap.className = 'rk-net-tree';
    addSectionHeader(wrap, 'Journey');

    if(!journeyState){
      const intro = document.createElement('div');
      intro.className = 'rk-empty';
      intro.innerHTML = '<div class="big">Journey Mode</div>' +
        'Walks you through one line, one stretch at a time, in real route order, with no way to peek mid-quiz. Haven\u2019t studied this line yet? Go to <b>Menu \u2192 Browse Lines / Quiz</b>, open it, and tap \u201cunhide speeds\u201d to see the whole thing start to finish \u2014 then come back here and test yourself for real.';
      wrap.appendChild(intro);

      const groups = [];
      for(const g of TRACK_SPEED_GROUPS){
        const downSegs = await loadSegments(g.down);
        const downPairs = computeRangePairs(downSegs);
        const upSegs = await loadSegments(g.up);
        const upPairs = computeRangePairs(upSegs);
        if(downPairs.length === 0 && upPairs.length === 0) continue;
        groups.push({
          name: g.name, hue: g.hue,
          down: downPairs.length ? { id: g.down, pairs: downPairs } : null,
          up: upPairs.length ? { id: g.up, pairs: upPairs } : null,
        });
      }

      if(groups.length === 0){
        const empty2 = document.createElement('div');
        empty2.className = 'rk-empty';
        empty2.style.marginTop = '16px';
        empty2.innerHTML = '<div class="big">No data loaded yet</div>Add segments to a line first, then come back here.';
        wrap.appendChild(empty2);
        bodyEl.appendChild(wrap);
        return;
      }

      if(!journeyPickerGroup || !groups.find(g => g.name === journeyPickerGroup)){
        journeyPickerGroup = groups[0].name;
      }
      const activeG = groups.find(g => g.name === journeyPickerGroup);

      const pickerRow = document.createElement('div');
      pickerRow.className = 'rk-line-picker';
      pickerRow.style.marginTop = '16px';
      pickerRow.style.setProperty('--line-hue', activeG.hue);

      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Journey rail line');
      groups.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.name;
        opt.textContent = g.name;
        if(g.name === activeG.name) opt.selected = true;
        select.appendChild(opt);
      });
      select.onchange = () => { journeyPickerGroup = select.value; renderBody(); };
      pickerRow.appendChild(select);

      function bundleJourneyPairs(pairs, minSize){
        const bundles = [];
        let current = null;
        pairs.forEach(pair => {
          if(!current) current = { from: pair.from, to: pair.to, items: [] };
          pair.speeds.forEach((sp, i) => {
            current.items.push({ value: sp.value, note: sp.note, pairFrom: pair.from, pairTo: pair.to, pairIndex: i });
          });
          current.to = pair.to;
          if(current.items.length >= minSize){
            bundles.push(current);
            current = null;
          }
        });
        if(current && current.items.length > 0){
          if(bundles.length > 0 && current.items.length < 2){
            const prev = bundles[bundles.length - 1];
            prev.to = current.to;
            prev.items = prev.items.concat(current.items);
          } else {
            bundles.push(current);
          }
        }
        return bundles;
      }

      function startJourney(entry){
        const bundles = bundleJourneyPairs(entry.pairs, 4);
        journeyState = {
          lineId: entry.id,
          lineLabel: lineDisplayName(entry.id),
          pairs: bundles,
          index: 0,
          guesses: new Array(bundles[0].items.length).fill(''),
          checked: new Array(bundles[0].items.length).fill(false),
          recorded: new Array(bundles[0].items.length).fill(false),
          hintFlags: new Array(bundles[0].items.length).fill(false),
          hintUsed: false,
          hintActiveIndex: null,
        };
        renderBody();
      }

      const dirToggleEl = document.createElement('div');
      dirToggleEl.className = 'rk-dir-toggle';
      ['Down','Up'].forEach(dir => {
        const entry = dir === 'Down' ? activeG.down : activeG.up;
        const btn = document.createElement('button');
        btn.textContent = dir;
        if(!entry){
          btn.disabled = true;
          btn.style.opacity = '0.35';
        } else {
          btn.onclick = () => startJourney(entry);
        }
        dirToggleEl.appendChild(btn);
      });
      pickerRow.appendChild(dirToggleEl);

      wrap.appendChild(pickerRow);
      bodyEl.appendChild(wrap);
      return;
    }

    const js = journeyState;
    if(!Array.isArray(js.recorded) || js.recorded.length !== js.checked.length){
      js.recorded = new Array(js.checked.length).fill(false);
    }
    if(!Array.isArray(js.hintFlags) || js.hintFlags.length !== js.checked.length){
      js.hintFlags = new Array(js.checked.length).fill(false);
    }
    if(js.hintUsed === undefined) js.hintUsed = false;
    if(js.hintActiveIndex === undefined) js.hintActiveIndex = null;
    const bundle = js.pairs[js.index];
    const stretchDone = js.checked.every(Boolean);

    const bar = document.createElement('div');
    bar.className = 'rk-quizbar';
    bar.innerHTML = '<span>' + js.lineLabel + '</span><span>Stretch ' + (js.index + 1) + ' / ' + js.pairs.length + '</span>';
    wrap.appendChild(bar);

    const flavor = document.createElement('p');
    flavor.style.cssText = 'font-family:\'Inter\',sans-serif; font-size:13px; color:var(--muted); line-height:1.6; margin:14px 4px;';
    flavor.textContent = 'Picture yourself leaving ' + bundle.from + ', heading toward ' + bundle.to + '. What are the speeds as you go, in order?';
    wrap.appendChild(flavor);

    const card = document.createElement('div');
    card.className = 'rk-seg';
    const top = document.createElement('div');
    top.className = 'rk-seg-top';
    const left = document.createElement('div');
    left.style.flex = '1';
    const stations = document.createElement('div');
    stations.className = 'rk-stations';
    stations.innerHTML = escapeHtml(bundle.from) + '<span class="arrow">\u2192</span>' + escapeHtml(bundle.to);
    left.appendChild(stations);
    const hint = document.createElement('div');
    hint.className = 'rk-tags';
    hint.appendChild(makeTag(bundle.items.length + ' speed change' + (bundle.items.length===1?'':'s')));
    left.appendChild(hint);
    top.appendChild(left);
    card.appendChild(top);

    const boxCol = document.createElement('div');
    boxCol.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-top:10px; max-width:260px;';

    bundle.items.forEach((sp, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap;';
      row.dataset.order = i;

      const hintIsActiveHere = js.hintActiveIndex === i;

      if(hintIsActiveHere){
        renderHintChoice(row, sp.value, (chosen) => {
          js.guesses[i] = chosen;
          js.checked[i] = true;
          js.hintFlags[i] = true;
          js.hintActiveIndex = null;
          const isFirstAttempt = !js.recorded[i];
          renderBody();
          if(isFirstAttempt){
            js.recorded[i] = true;
            recordAttempt(statKey(js.lineId, sp.pairFrom, sp.pairTo, sp.pairIndex), false).then(() => {
              if(js.checked.every(Boolean)){
                evaluateStretchOutcome(js.lineId, bundle.items, js.guesses);
              }
            });
          }
        });
      } else if(!js.checked[i]){
        const input = document.createElement('input');
        input.className = 'rk-input';
        input.type = 'text';
        input.inputMode = 'numeric';
        input.pattern = '[0-9]*';
        input.style.width = '140px';
        input.placeholder = 'speed ' + (i+1);
        input.setAttribute('aria-label', bundle.from + ' to ' + bundle.to + ', speed ' + (i + 1) + ' in kilometres per hour');
        input.value = js.guesses[i] || '';
        input.addEventListener('input', () => {
          const cleaned = input.value.replace(/[^0-9]/g, '');
          if(cleaned !== input.value) input.value = cleaned;
          js.guesses[i] = cleaned;
        });
        input.addEventListener('wheel', e => e.preventDefault(), { passive:false });
        input.addEventListener('blur', () => {
          if(input.value.trim() !== ''){
            js.checked[i] = true;
            const correct = Number(input.value) === Number(sp.value);
            const isFirstAttempt = !js.recorded[i];
            renderBody();
            setTimeout(() => {
              const nextRow = bodyEl.querySelector('[data-order="' + (i + 1) + '"]');
              const nextInput = nextRow ? nextRow.querySelector('.rk-input') : null;
              if(nextInput) nextInput.focus();
            }, 30);
            if(isFirstAttempt){
              js.recorded[i] = true;
              recordAttempt(statKey(js.lineId, sp.pairFrom, sp.pairTo, sp.pairIndex), correct).then(() => {
                if(js.checked.every(Boolean)){
                  evaluateStretchOutcome(js.lineId, bundle.items, js.guesses);
                }
              });
            }
          }
        });
        input.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); input.blur(); } });
        row.appendChild(input);
        if(!js.hintUsed){
          const hintBtn = document.createElement('button');
          hintBtn.className = 'rk-icon-btn';
          hintBtn.textContent = 'Hint';
          hintBtn.title = 'One hint per journey \u2014 counts as a miss if used';
          hintBtn.onclick = () => {
            js.hintUsed = true;
            js.hintActiveIndex = i;
            renderBody();
          };
          row.appendChild(hintBtn);
        }
      } else {
        const guess = js.guesses[i];
        const wasHint = js.hintFlags[i];
        const correct = guess !== '' && guess !== undefined && Number(guess) === Number(sp.value);
        const chip = document.createElement('div');
        chip.className = 'rk-board';
        chip.style.width = '140px';
        chip.style.cursor = 'pointer';
        chip.title = 'Click to try this one again';
        chip.style.background = correct ? 'var(--green)' : 'var(--red)';
        chip.style.color = '#0d1410';
        chip.innerHTML = wasHint
          ? '* ' + (guess || '\u2014') + ' <span class="u">hint used</span>'
          : (correct
            ? sp.value + '<span class="u">km/h</span>'
            : (guess || '\u2014') + ' <span class="u">(was ' + sp.value + ')</span>');
        chip.onclick = () => { js.checked[i] = false; renderBody(); };
        row.appendChild(chip);
      }
      if(sp.note){
        const noteLabel = document.createElement('span');
        noteLabel.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--yellow); white-space:nowrap;';
        noteLabel.textContent = sp.note;
        row.appendChild(noteLabel);
      }
      boxCol.appendChild(row);
    });

    card.appendChild(boxCol);
    wrap.appendChild(card);

    const actions = document.createElement('div');
    actions.className = 'rk-action-row';
    actions.style.cssText = 'display:flex; gap:10px; margin-top:16px; flex-wrap:wrap;';

    if(js.index > 0){
      const backBtn = document.createElement('button');
      backBtn.className = 'rk-btn';
      backBtn.textContent = 'Previous Stretch';
      backBtn.onclick = () => {
        js.index--;
        js.guesses = new Array(js.pairs[js.index].items.length).fill('');
        js.checked = new Array(js.pairs[js.index].items.length).fill(false);
        js.recorded = new Array(js.pairs[js.index].items.length).fill(false);
        js.hintFlags = new Array(js.pairs[js.index].items.length).fill(false);
        js.hintActiveIndex = null;
        renderBody();
      };
      actions.appendChild(backBtn);
    }

    if(js.index < js.pairs.length - 1){
      const nextBtn = document.createElement('button');
      nextBtn.className = 'rk-btn primary';
      nextBtn.textContent = stretchDone ? 'Next Stretch' : 'Skip to Next Stretch';
      nextBtn.onclick = () => {
        js.index++;
        js.guesses = new Array(js.pairs[js.index].items.length).fill('');
        js.checked = new Array(js.pairs[js.index].items.length).fill(false);
        js.recorded = new Array(js.pairs[js.index].items.length).fill(false);
        js.hintFlags = new Array(js.pairs[js.index].items.length).fill(false);
        js.hintActiveIndex = null;
        renderBody();
      };
      actions.appendChild(nextBtn);
    } else if(stretchDone){
      const doneMsg = document.createElement('div');
      doneMsg.style.cssText = 'font-family:\'DM Sans\',sans-serif; color:var(--green); font-size:14px; padding:9px 4px;';
      doneMsg.textContent = 'End of the line \u2014 journey complete.';
      actions.appendChild(doneMsg);
    }

    const restartBtn = document.createElement('button');
    restartBtn.className = 'rk-btn';
    restartBtn.textContent = 'Choose Different Line';
    restartBtn.onclick = () => { journeyState = null; renderBody(); };
    actions.appendChild(restartBtn);

    wrap.appendChild(actions);
    bodyEl.appendChild(wrap);

    if(js.checked.filter(Boolean).length === 0 && js.checked.length > 0 && js.hintActiveIndex === null){
      setTimeout(() => {
        const firstInput = bodyEl.querySelector('.rk-input');
        if(firstInput) firstInput.focus();
      }, 30);
    }
  }

  function quizRetryKey(pairKey, index){ return pairKey + '::' + index; }

  function quizVisiblePairs(pairs){
    return pairs.map(pair => ({
      pair,
      items: pair.speeds.map((sp, index) => ({sp, index, key:quizRetryKey(pair.key, index)}))
        .filter(item => !quizRetryKeys || quizRetryKeys.has(item.key)),
    })).filter(group => group.items.length > 0);
  }

  function quizItemCorrect(pair, item){
    const guess = quizRangeGuesses[pair.key][item.index];
    return !quizRangeHintFlag[pair.key][item.index] && guess !== '' && guess !== undefined && Number(guess) === Number(item.sp.value);
  }

  function locationQuestionCorrect(question){
    return question.checked && question.selectedKey === question.answerKey;
  }

  function renderLocationSequence(container, speeds){
    const sequence = document.createElement('div');
    sequence.className = 'rk-location-sequence';
    sequence.setAttribute('aria-label', 'Speed sequence ' + speeds.map(speed => speed.value + ' kilometres per hour' + (speed.note ? ', ' + speed.note : '')).join(', then '));
    speeds.forEach((speed, index) => {
      const speedItem = document.createElement('div');
      speedItem.className = 'rk-location-speed-item';
      const board = document.createElement('div');
      board.className = 'rk-board';
      board.innerHTML = escapeHtml(speed.value) + '<span class="u">km/h</span>';
      speedItem.appendChild(board);
      const note = document.createElement('span');
      note.className = 'rk-location-speed-note';
      note.textContent = speed.note || '\u00a0';
      if(!speed.note) note.setAttribute('aria-hidden', 'true');
      speedItem.appendChild(note);
      sequence.appendChild(speedItem);
      if(index < speeds.length - 1){
        const arrow = document.createElement('span');
        arrow.className = 'rk-location-sequence-arrow';
        arrow.textContent = '→';
        sequence.appendChild(arrow);
      }
    });
    container.appendChild(sequence);
  }

  function renderLocationQuizSummary(line){
    const questions = locationQuizState.questions;
    const correctQuestions = questions.filter(locationQuestionCorrect);
    const mistakes = questions.filter(question => !locationQuestionCorrect(question));
    const pct = questions.length ? Math.round((correctQuestions.length / questions.length) * 100) : 0;

    const summary = document.createElement('section');
    summary.className = 'rk-quiz-done rk-quiz-summary rk-location-summary';
    if(mistakes.length === 0) summary.classList.add('is-perfect');
    summary.setAttribute('aria-labelledby', 'rk-location-summary-title');

    const hero = document.createElement('div');
    hero.className = 'rk-summary-hero';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'rk-form-title';
    eyebrow.textContent = locationQuizState.isRetry ? 'Location retry complete' : line.name + ' — ' + line.direction + ' · Quiz Locations';
    hero.appendChild(eyebrow);
    const title = document.createElement('h2');
    title.id = 'rk-location-summary-title';
    title.textContent = mistakes.length === 0 ? 'Quiz complete — excellent work' : 'Quiz complete';
    hero.appendChild(title);
    const score = document.createElement('div');
    score.className = 'score';
    score.setAttribute('aria-label', pct + ' percent correct');
    score.innerHTML = '<strong>' + pct + '%</strong><span>location score</span>';
    hero.appendChild(score);
    summary.appendChild(hero);

    const metrics = document.createElement('div');
    metrics.className = 'rk-summary-metrics rk-location-metrics';
    [
      {value:correctQuestions.length + ' / ' + questions.length, label:'Correct'},
      {value:String(mistakes.length), label:'To retry'},
    ].forEach(metric => {
      const card = document.createElement('div');
      card.className = 'rk-summary-metric';
      card.innerHTML = '<strong>' + metric.value + '</strong><span>' + metric.label + '</span>';
      metrics.appendChild(card);
    });
    summary.appendChild(metrics);

    if(mistakes.length > 0){
      const reviewHead = document.createElement('div');
      reviewHead.className = 'rk-summary-review-head';
      reviewHead.innerHTML = '<h3>Review ' + mistakes.length + ' mistake' + (mistakes.length === 1 ? '' : 's') + '</h3>' +
        '<p>Match each speed sequence to the correct station-to-station section.</p>';
      summary.appendChild(reviewHead);

      const mistakeList = document.createElement('div');
      mistakeList.className = 'rk-summary-list';
      mistakes.forEach((question, mistakeIndex) => {
        const chosen = question.options.find(option => option.key === question.selectedKey);
        const row = document.createElement('div');
        row.className = 'rk-summary-row';
        row.setAttribute('aria-label', 'Location mistake ' + (mistakeIndex + 1) + ' of ' + mistakes.length);
        const context = document.createElement('div');
        context.className = 'rk-summary-context';
        const sequenceLabel = question.pair.speeds.map(speed => speed.value).join(' → ') + ' km/h';
        context.innerHTML = '<strong>' + escapeHtml(sequenceLabel) + '</strong><span>Speed sequence</span>';
        const answer = document.createElement('div');
        answer.className = 'rk-answer-comparison';
        const yourAnswer = document.createElement('div');
        yourAnswer.className = 'rk-answer-box wrong';
        yourAnswer.innerHTML = '<span>Your answer</span><strong>' + escapeHtml(chosen ? chosen.label : 'No answer') + '</strong>';
        const correctAnswer = document.createElement('div');
        correctAnswer.className = 'rk-answer-box correct';
        correctAnswer.innerHTML = '<span>Correct location</span><strong>' +
          escapeHtml(question.pair.from + ' → ' + question.pair.to) + '</strong>';
        answer.appendChild(yourAnswer);
        answer.appendChild(correctAnswer);
        row.appendChild(context);
        row.appendChild(answer);
        mistakeList.appendChild(row);
      });
      summary.appendChild(mistakeList);
    }

    const actions = document.createElement('div');
    actions.className = 'rk-action-row rk-summary-actions';
    if(mistakes.length > 0){
      const retryBtn = document.createElement('button');
      retryBtn.className = 'rk-btn primary';
      retryBtn.textContent = 'Retry ' + mistakes.length + ' location' + (mistakes.length === 1 ? '' : 's');
      retryBtn.onclick = () => {
        locationQuizState = {
          lineId:line.id,
          index:0,
          isRetry:true,
          questions:mistakes.map(question => ({
            ...question,
            options:shuffledCopy(question.options),
            selectedKey:null,
            checked:false,
            recorded:false,
          })),
        };
        renderBody();
      };
      actions.appendChild(retryBtn);
    }
    const restartBtn = document.createElement('button');
    restartBtn.className = 'rk-btn';
    restartBtn.textContent = 'Restart full quiz';
    restartBtn.onclick = () => {
      locationQuizState = {lineId:line.id, index:0, isRetry:false, questions:buildLocationQuizQuestions(segCache[line.id] || [])};
      renderBody();
    };
    actions.appendChild(restartBtn);
    const exitBtn = document.createElement('button');
    exitBtn.className = 'rk-btn';
    exitBtn.textContent = 'Back to line';
    exitBtn.onclick = () => { exitQuiz(); renderBody(); };
    actions.appendChild(exitBtn);
    summary.appendChild(actions);
    bodyEl.appendChild(summary);
  }

  function renderLocationQuiz(segs, line){
    if(!locationQuizState || locationQuizState.lineId !== line.id){
      locationQuizState = {lineId:line.id, index:0, isRetry:false, questions:buildLocationQuizQuestions(segs)};
    }

    if(locationQuizState.questions.length === 0){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.innerHTML = '<div class="big">No location questions yet</div>' +
        'This direction does not yet have enough named-station sections to build a location quiz.';
      bodyEl.appendChild(empty);
      return;
    }

    if(locationQuizState.index >= locationQuizState.questions.length){
      renderLocationQuizSummary(line);
      return;
    }

    const question = locationQuizState.questions[locationQuizState.index];
    const quiz = document.createElement('section');
    quiz.className = 'rk-location-quiz';
    quiz.setAttribute('aria-labelledby', 'rk-location-question-title');

    const progress = document.createElement('div');
    progress.className = 'rk-quizbar rk-location-progress';
    progress.innerHTML = '<span>' + (locationQuizState.isRetry ? 'Retry locations' : 'Quiz Locations') + '</span>' +
      '<span>Question <b>' + (locationQuizState.index + 1) + '</b> / ' + locationQuizState.questions.length + '</span>';
    quiz.appendChild(progress);

    const card = document.createElement('div');
    card.className = 'rk-location-card';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'rk-form-title';
    eyebrow.textContent = line.name + ' · ' + line.direction;
    card.appendChild(eyebrow);
    const title = document.createElement('h2');
    title.id = 'rk-location-question-title';
    title.textContent = 'Which section has this speed sequence?';
    card.appendChild(title);
    const helper = document.createElement('p');
    helper.className = 'rk-location-helper';
    helper.textContent = 'Choose the exact sequence between two consecutive named stations.';
    card.appendChild(helper);
    renderLocationSequence(card, question.pair.speeds);

    const choices = document.createElement('div');
    choices.className = 'rk-location-choices';
    question.options.forEach((option, optionIndex) => {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.className = 'rk-location-choice';
      choice.disabled = question.checked;
      choice.innerHTML = '<span class="rk-location-choice-letter">' + String.fromCharCode(65 + optionIndex) + '</span>' +
        '<span>' + escapeHtml(option.label) + '</span>';
      if(question.checked){
        if(option.key === question.answerKey) choice.classList.add('correct');
        if(option.key === question.selectedKey && option.key !== question.answerKey) choice.classList.add('wrong');
      }
      choice.onclick = () => {
        if(question.checked) return;
        question.selectedKey = option.key;
        question.checked = true;
        if(!question.recorded){
          question.recorded = true;
          recordLocationQuizAttempt(line.id, question.id, option.key === question.answerKey);
        }
        renderBody();
      };
      choices.appendChild(choice);
    });
    card.appendChild(choices);

    if(question.checked){
      const feedback = document.createElement('div');
      const isCorrect = locationQuestionCorrect(question);
      feedback.className = 'rk-location-feedback ' + (isCorrect ? 'correct' : 'wrong');
      feedback.setAttribute('role', 'status');
      feedback.textContent = isCorrect
        ? 'Correct — that sequence belongs here.'
        : 'Not quite — the correct section is ' + question.pair.from + ' to ' + question.pair.to + '.';
      card.appendChild(feedback);

      const nextBtn = document.createElement('button');
      nextBtn.className = 'rk-btn primary rk-location-next';
      nextBtn.textContent = locationQuizState.index === locationQuizState.questions.length - 1 ? 'View results' : 'Next question';
      nextBtn.onclick = () => {
        locationQuizState.index++;
        renderBody();
      };
      card.appendChild(nextBtn);
    }

    quiz.appendChild(card);
    bodyEl.appendChild(quiz);
  }

  function renderQuizSummary(visiblePairs, line){
    const allItems = visiblePairs.flatMap(group => group.items.map(item => ({pair:group.pair, ...item})));
    const correctItems = allItems.filter(item => quizItemCorrect(item.pair, item));
    const mistakes = allItems.filter(item => !quizItemCorrect(item.pair, item));
    const hintCount = allItems.filter(item => quizRangeHintFlag[item.pair.key][item.index]).length;
    const pct = allItems.length ? Math.round((correctItems.length / allItems.length) * 100) : 0;

    const summary = document.createElement('section');
    summary.className = 'rk-quiz-done rk-quiz-summary';
    if(mistakes.length === 0) summary.classList.add('is-perfect');
    summary.setAttribute('aria-labelledby', 'rk-quiz-summary-title');
    const hero = document.createElement('div');
    hero.className = 'rk-summary-hero';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'rk-form-title';
    eyebrow.textContent = quizRetryKeys ? 'Mistake retry complete' : line.name + ' — ' + line.direction;
    hero.appendChild(eyebrow);
    const title = document.createElement('h2');
    title.id = 'rk-quiz-summary-title';
    title.textContent = mistakes.length === 0 ? 'Quiz complete — excellent work' : 'Quiz complete';
    hero.appendChild(title);
    const score = document.createElement('div');
    score.className = 'score';
    score.setAttribute('aria-label', pct + ' percent correct');
    score.innerHTML = '<strong>' + pct + '%</strong><span>final score</span>';
    hero.appendChild(score);
    summary.appendChild(hero);

    const metrics = document.createElement('div');
    metrics.className = 'rk-summary-metrics';
    [
      {value:correctItems.length + ' / ' + allItems.length, label:'Correct'},
      {value:String(mistakes.length), label:'To retry'},
      {value:String(hintCount), label:'Hints used'},
    ].forEach(metric => {
      const card = document.createElement('div');
      card.className = 'rk-summary-metric';
      card.setAttribute('aria-label', metric.label + ': ' + metric.value);
      card.innerHTML = '<strong>' + metric.value + '</strong><span>' + metric.label + '</span>';
      metrics.appendChild(card);
    });
    summary.appendChild(metrics);

    if(mistakes.length > 0){
      const reviewHead = document.createElement('div');
      reviewHead.className = 'rk-summary-review-head';
      reviewHead.innerHTML = '<h3>Review ' + mistakes.length + ' mistake' + (mistakes.length === 1 ? '' : 's') + '</h3>' +
        '<p>Compare your entry with the correct speed before retrying.</p>';
      summary.appendChild(reviewHead);
      const mistakeList = document.createElement('div');
      mistakeList.className = 'rk-summary-list';
      mistakes.forEach((item, mistakeIndex) => {
        const guess = quizRangeGuesses[item.pair.key][item.index];
        const usedHint = quizRangeHintFlag[item.pair.key][item.index];
        const row = document.createElement('div');
        row.className = 'rk-summary-row';
        row.setAttribute('aria-label', 'Mistake ' + (mistakeIndex + 1) + ' of ' + mistakes.length);
        const context = document.createElement('div');
        context.className = 'rk-summary-context';
        context.innerHTML = '<strong>' + escapeHtml(item.pair.from) + ' → ' + escapeHtml(item.pair.to) + '</strong>' +
          '<span>Speed ' + (item.index + 1) + ' of ' + item.pair.speeds.length + (item.sp.note ? ' · ' + escapeHtml(item.sp.note) : '') + '</span>';
        const answer = document.createElement('div');
        answer.className = 'rk-answer-comparison';
        const yourAnswer = document.createElement('div');
        yourAnswer.className = 'rk-answer-box wrong';
        yourAnswer.innerHTML = '<span>' + (usedHint ? 'Hint used' : 'Your answer') + '</span>' +
          '<strong>' + (guess ? escapeHtml(guess) + ' km/h' : 'No answer') + '</strong>';
        const correctAnswer = document.createElement('div');
        correctAnswer.className = 'rk-answer-box correct';
        correctAnswer.innerHTML = '<span>Correct speed</span><strong>' + escapeHtml(item.sp.value) + ' km/h</strong>';
        answer.appendChild(yourAnswer);
        answer.appendChild(correctAnswer);
        row.appendChild(context);
        row.appendChild(answer);
        mistakeList.appendChild(row);
      });
      summary.appendChild(mistakeList);
    }

    const actions = document.createElement('div');
    actions.className = 'rk-action-row rk-summary-actions';
    if(mistakes.length > 0){
      const retryBtn = document.createElement('button');
      retryBtn.className = 'rk-btn primary';
      retryBtn.textContent = 'Retry ' + mistakes.length + ' mistake' + (mistakes.length === 1 ? '' : 's');
      retryBtn.onclick = () => {
        quizRetryKeys = new Set(mistakes.map(item => item.key));
        mistakes.forEach(item => {
          quizRangeGuesses[item.pair.key][item.index] = '';
          quizRangeBoxChecked[item.pair.key][item.index] = false;
          quizRangeRecorded[item.pair.key][item.index] = false;
          quizRangeHintFlag[item.pair.key][item.index] = false;
        });
        quizRangeHintUsed = false;
        quizRangeHintActive = null;
        renderBody();
      };
      actions.appendChild(retryBtn);
    }
    const restartBtn = document.createElement('button');
    restartBtn.className = 'rk-btn';
    restartBtn.textContent = 'Restart full quiz';
    restartBtn.onclick = () => {
      quizRangeGuesses = {};
      quizRangeBoxChecked = {};
      quizRangeRecorded = {};
      quizRangeHintUsed = false;
      quizRangeHintActive = null;
      quizRangeHintFlag = {};
      quizRetryKeys = null;
      renderBody();
    };
    actions.appendChild(restartBtn);
    const exitBtn = document.createElement('button');
    exitBtn.className = 'rk-btn';
    exitBtn.textContent = 'Back to line';
    exitBtn.onclick = () => { exitQuiz(); renderBody(); };
    actions.appendChild(exitBtn);
    summary.appendChild(actions);
    bodyEl.appendChild(summary);
  }

  function renderQuizRange(segs, line){
    const pairs = computeRangePairs(segs);
    if(pairs.length === 0){
      const empty = document.createElement('div');
      empty.className = 'rk-empty';
      empty.innerHTML = '<div class="big">Not enough named stations yet</div>' +
        'Range Quiz needs at least two recognizable named stations in this line\u2019s segments to build station-to-station questions.';
      bodyEl.appendChild(empty);
      return;
    }

    // ensure each pair has guess + checked arrays matching its number of speed changes
    pairs.forEach(pair => {
      if(!Array.isArray(quizRangeGuesses[pair.key]) || quizRangeGuesses[pair.key].length !== pair.speeds.length){
        quizRangeGuesses[pair.key] = new Array(pair.speeds.length).fill('');
      }
      if(!Array.isArray(quizRangeBoxChecked[pair.key]) || quizRangeBoxChecked[pair.key].length !== pair.speeds.length){
        quizRangeBoxChecked[pair.key] = new Array(pair.speeds.length).fill(false);
      }
      if(!Array.isArray(quizRangeRecorded[pair.key]) || quizRangeRecorded[pair.key].length !== pair.speeds.length){
        quizRangeRecorded[pair.key] = new Array(pair.speeds.length).fill(false);
      }
      if(!Array.isArray(quizRangeHintFlag[pair.key]) || quizRangeHintFlag[pair.key].length !== pair.speeds.length){
        quizRangeHintFlag[pair.key] = new Array(pair.speeds.length).fill(false);
      }
    });

    const visiblePairs = quizVisiblePairs(pairs);
    let totalBoxes = 0, checkedBoxes = 0, correctBoxes = 0;
    visiblePairs.forEach(({pair, items}) => {
      items.forEach(item => {
        const i = item.index;
        totalBoxes++;
        if(quizRangeBoxChecked[pair.key][i]){
          checkedBoxes++;
          if(quizItemCorrect(pair, item)) correctBoxes++;
        }
      });
    });

    if(totalBoxes > 0 && checkedBoxes === totalBoxes){
      renderQuizSummary(visiblePairs, line);
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'rk-quizbar';
    const updateQuizBar = () => {
      let checked = 0;
      let correct = 0;
      visiblePairs.forEach(({pair, items}) => {
        items.forEach(item => {
          if(quizRangeBoxChecked[pair.key][item.index]){
            checked++;
            if(quizItemCorrect(pair, item)) correct++;
          }
        });
      });
      if(checked === 0){
        bar.innerHTML = '<span>Type a speed and tab/enter to check it instantly</span><span>' + totalBoxes + ' blanks</span>';
      } else {
        bar.innerHTML = '<span>Checked ' + checked + ' / ' + totalBoxes + '</span><span>Correct: <b>' + correct + '</b></span>';
      }
      return {checked, correct};
    };
    updateQuizBar();
    bodyEl.appendChild(bar);

    const track = document.createElement('div');
    track.className = 'rk-track';

    let rkBoxOrder = 0;
    visiblePairs.forEach(({pair, items}) => {
      const card = document.createElement('div');
      card.className = 'rk-seg';

      const top = document.createElement('div');
      top.className = 'rk-seg-top';
      const left = document.createElement('div');
      left.style.flex = '1';
      left.style.minWidth = '200px';
      const stations = document.createElement('div');
      stations.className = 'rk-stations';
      stations.innerHTML = escapeHtml(pair.from) + '<span class="arrow">→</span>' + escapeHtml(pair.to);
      left.appendChild(stations);
      const hint = document.createElement('div');
      hint.className = 'rk-tags';
      hint.appendChild(makeTag(items.length + (quizRetryKeys ? ' mistake' : ' speed change') + (items.length===1?'':'s')));
      left.appendChild(hint);
      top.appendChild(left);
      card.appendChild(top);

      const boxCol = document.createElement('div');
      boxCol.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-top:10px; max-width:260px;';

      items.forEach(({sp, index:i}) => {
        const isChecked = quizRangeBoxChecked[pair.key][i];
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap;';
        row.dataset.order = rkBoxOrder++;

        const makeResultChip = () => {
          const guess = quizRangeGuesses[pair.key][i];
          const wasHint = quizRangeHintFlag[pair.key][i];
          const boxCorrect = guess !== '' && guess !== undefined && Number(guess) === Number(sp.value);
          const chip = document.createElement('div');
          chip.className = 'rk-board';
          chip.style.width = '140px';
          chip.style.cursor = 'pointer';
          chip.title = 'Click to try this one again';
          chip.style.background = boxCorrect ? 'var(--green)' : 'var(--red)';
          chip.style.color = '#0d1410';
          chip.innerHTML = wasHint
            ? '* ' + (guess || '\u2014') + ' <span class="u">hint used</span>'
            : (boxCorrect
              ? sp.value + '<span class="u">km/h</span>'
              : (guess || '\u2014') + ' <span class="u">(was ' + sp.value + ')</span>');
          chip.onclick = () => { quizRangeBoxChecked[pair.key][i] = false; renderBody(); };
          return chip;
        };

        const makeNoteLabel = () => {
          const noteLabel = document.createElement('span');
          noteLabel.style.cssText = 'font-family:\'JetBrains Mono\',monospace; font-size:11px; color:var(--yellow); white-space:nowrap;';
          noteLabel.textContent = sp.note;
          return noteLabel;
        };

        const hintIsActiveHere = quizRangeHintActive && quizRangeHintActive.pairKey === pair.key && quizRangeHintActive.index === i;

        if(hintIsActiveHere){
          renderHintChoice(row, sp.value, (chosen) => {
            quizRangeGuesses[pair.key][i] = chosen;
            quizRangeBoxChecked[pair.key][i] = true;
            quizRangeHintFlag[pair.key][i] = true;
            quizRangeHintActive = null;
            const isFirstAttempt = !quizRangeRecorded[pair.key][i];
            renderBody();
            if(isFirstAttempt){
              quizRangeRecorded[pair.key][i] = true;
              recordAttempt(statKey(line.id, pair.from, pair.to, i), false).then(() => {
                if(quizRangeBoxChecked[pair.key].every(Boolean)){
                  const stretchItems = pair.speeds.map((s, j) => ({ value: s.value, pairFrom: pair.from, pairTo: pair.to, pairIndex: j }));
                  evaluateStretchOutcome(line.id, stretchItems, quizRangeGuesses[pair.key]);
                }
              });
            }
          });
        } else if(!isChecked){
          const input = document.createElement('input');
          input.className = 'rk-input';
          input.type = 'text';
          input.inputMode = 'numeric';
          input.pattern = '[0-9]*';
          input.enterKeyHint = Number(row.dataset.order) === totalBoxes - 1 ? 'done' : 'next';
          input.autocomplete = 'off';
          input.style.width = '140px';
          input.placeholder = 'speed ' + (i+1);
          input.setAttribute('aria-label', pair.from + ' to ' + pair.to + ', speed ' + (i + 1) + ' in kilometres per hour');
          input.value = quizRangeGuesses[pair.key][i] || '';
          input.addEventListener('input', () => {
            const cleaned = input.value.replace(/[^0-9]/g, '');
            if(cleaned !== input.value) input.value = cleaned;
            quizRangeGuesses[pair.key][i] = cleaned;
        });
          input.addEventListener('wheel', e => e.preventDefault(), { passive:false });
          let answerCommitted = false;
          const commitAnswer = () => {
            const value = input.value.trim();
            if(answerCommitted || value === '') return;
            answerCommitted = true;
            quizRangeGuesses[pair.key][i] = value;
            quizRangeBoxChecked[pair.key][i] = true;
            const correct = Number(value) === Number(sp.value);
            const isFirstAttempt = !quizRangeRecorded[pair.key][i];
            const myOrder = Number(row.dataset.order);
            const nextRow = bodyEl.querySelector('[data-order="' + (myOrder + 1) + '"]');
            const nextInput = nextRow ? nextRow.querySelector('.rk-input') : null;

            // Keep the mobile keyboard alive by transferring focus before the
            // submitted input is removed from the DOM. Mobile Safari can drop
            // programmatic focus if there is even a brief no-input gap.
            const progress = updateQuizBar();
            if(progress.checked !== totalBoxes && nextInput) nextInput.focus();
            row.replaceChildren(makeResultChip());
            if(sp.note) row.appendChild(makeNoteLabel());

            if(progress.checked === totalBoxes){
              renderBody();
            }

            if(isFirstAttempt){
              quizRangeRecorded[pair.key][i] = true;
              recordAttempt(statKey(line.id, pair.from, pair.to, i), correct).then(() => {
                if(quizRangeBoxChecked[pair.key].every(Boolean)){
                  const stretchItems = pair.speeds.map((s, j) => ({ value: s.value, pairFrom: pair.from, pairTo: pair.to, pairIndex: j }));
                  evaluateStretchOutcome(line.id, stretchItems, quizRangeGuesses[pair.key]);
                }
              });
            }
          };
          input.addEventListener('blur', commitAnswer);
          input.addEventListener('keydown', e => {
            if(e.key === 'Enter'){
              e.preventDefault();
              commitAnswer();
            }
          });
          row.appendChild(input);
          if(!quizRangeHintUsed){
            const hintBtn = document.createElement('button');
            hintBtn.className = 'rk-icon-btn';
            hintBtn.textContent = 'Hint';
            hintBtn.title = 'One hint per quiz \u2014 counts as a miss if used';
            hintBtn.onclick = () => {
              quizRangeHintUsed = true;
              quizRangeHintActive = { pairKey: pair.key, index: i };
              renderBody();
            };
            row.appendChild(hintBtn);
          }
        } else {
          row.appendChild(makeResultChip());
        }

        if(sp.note){
          row.appendChild(makeNoteLabel());
        }

        boxCol.appendChild(row);
      });

      card.appendChild(boxCol);
      track.appendChild(card);
    });

    bodyEl.appendChild(track);

    const actions = document.createElement('div');
    actions.className = 'rk-action-row';
    actions.style.cssText = 'display:flex; gap:10px; margin-top:16px; flex-wrap:wrap;';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'rk-btn primary';
    resetBtn.textContent = 'Reset Quiz';
    resetBtn.onclick = () => { quizRangeGuesses = {}; quizRangeBoxChecked = {}; quizRangeRecorded = {}; quizRangeHintUsed = false; quizRangeHintActive = null; quizRangeHintFlag = {}; quizRetryKeys = null; renderBody(); };
    actions.appendChild(resetBtn);
    const exitBtnBottom = document.createElement('button');
    exitBtnBottom.className = 'rk-btn';
    exitBtnBottom.textContent = 'Exit Quiz';
    exitBtnBottom.onclick = () => { exitQuiz(); renderBody(); };
    actions.appendChild(exitBtnBottom);
    bodyEl.appendChild(actions);

    if(checkedBoxes === 0 && totalBoxes > 0 && quizRangeHintActive === null){
      setTimeout(() => {
        const firstInput = bodyEl.querySelector('.rk-input');
        if(firstInput) firstInput.focus();
      }, 30);
    }
  }

  renderTabs();
  if(localModeChosen) authOverlay.classList.add('hidden');
  renderBody();
  if(!localModeChosen) initFirebaseAuth();
  registerRouteKnowledgePwa();
  updateOnlineState();
})();
