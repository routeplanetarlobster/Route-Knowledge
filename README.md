# Route Knowledge

Mobile-first Adelaide suburban rail route-knowledge study app. It is a static PWA hosted on GitHub Pages: no package installation, bundler, or build step is required.

## Structure

- `index.html` — accessible application shell and dialogs
- `styles.css` — shared visual system and responsive styles
- `js/route-data.js` — full addenda route and speed rows for Track Speeds and the map
- `js/study-data.js` — curated, learner-facing sequences used by quizzes and review modes
- `js/map-data.js` — map geometry and kilometrage anchors
- `js/progress-sync.js` — deterministic progress-delta merging
- `js/storage.js` — local-first browser storage boundary
- `js/app.js` — application state, views, Firebase and MapLibre integration
- `sw.js` / `manifest.webmanifest` — installable/offline PWA
- `firestore.rules` — UID-scoped Firestore access policy
- `tests/validate.mjs` — route, sync, accessibility and PWA validation

## Local development

Serve the repository over HTTP; ES modules and service workers do not run correctly from `file://`.

```sh
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Validation

Node.js is the only test requirement:

```sh
node --check js/app.js
node --check sw.js
node tests/validate.mjs
```

The same checks run in GitHub Actions.

## Data corrections

The app deliberately separates reference detail from the learning sequence:

- Edit full addenda/reference rows in `TRACK_SPEED_DATA` inside `js/route-data.js`.
- Edit learner-facing station groupings and speed sequences in `STUDY_SEGMENTS` inside `js/study-data.js`.
- Keep sidings, tunnel ends, loops and similar technical points inside a station-to-station study stretch unless they must be recalled as a boundary.
- Put map-only geography in `js/map-data.js`.

After a correction:

1. Increment `ROUTE_DATA_VERSION`.
2. Add a short entry to `CHANGELOG.md`.
3. Run `node tests/validate.mjs`; it checks that every study speed remains supported by the addenda data.
4. Increment `CACHE_VERSION` in `sw.js` for a release that must update installed clients immediately.

## Cloud progress

Accounts are optional. Local study and progress work without Firebase. Signed-in progress uses transactionally merged per-attempt deltas so concurrent devices do not replace one another's completed work. Firebase configuration is intentionally public web configuration; access control is enforced by `firestore.rules`.

Deploy the rules separately when they change:

```sh
firebase deploy --only firestore:rules
```
