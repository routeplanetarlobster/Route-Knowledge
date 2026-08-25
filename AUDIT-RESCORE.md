# Route Knowledge — completed audit and rescore

## Outcome

The audit's structural, data, sync, offline, account, and accessibility findings have been addressed. Route Knowledge remains a build-free static PWA, with full addenda reference data kept separate from the deliberately simpler, original learning sequences.

## Rescore

| Area | Before | After | Result |
| --- | ---: | ---: | --- |
| Visual and product design | 8.0 | 8.5 | The existing visual identity is preserved; status, account, empty-state, menu, and focus behavior are clearer. |
| Deployment simplicity | 9.0 | 9.0 | Still deploys as static files with no build step. Firebase rules and configuration are included. |
| Code simplicity | 4.0 | 7.5 | The 6,007-line HTML file is now a 115-line shell with separate styles, app logic, data, storage, and sync modules. One large UI controller remains, but duplicate and obsolete subsystems are gone. |
| Data maintainability | 4.0 | 9.0 | Versioned reference and study layers make their different purposes explicit. Validation catches unsupported study speeds, unwanted technical quiz boundaries, ordering, and inheritance errors. |
| Offline/PWA behavior | 7.0 | 9.0 | The application shell is cached locally; optional MapLibre and Firebase dependencies load only when requested. The basemap still requires a prior online load. |
| Accessibility | 5.0 | 8.5 | Zoom is unrestricted; dialogs, live status, expanded controls, labels, keyboard focus, contrast, and reduced-motion behavior are covered. A formal assistive-technology audit is still advisable before public release. |

**Overall: 8.6/10, up from 6.2/10.**

## Main corrections

- Separated full addenda reference detail from the original curated, learner-facing study sequences.
- Corrected and validated supplied Gawler Up records, Grange Up inheritance, the Gawler platform label, and Belair Up kilometre ordering.
- Replaced several competing screen booleans with one `activeView` state.
- Removed obsolete editors, migration parsing, and legacy route-storage paths.
- Added local-only use so an account is no longer mandatory.
- Reworked cloud writes as transactional per-stat deltas to avoid cross-device last-write data loss.
- Added real progress export/import, device/account migration handling, and UID-scoped Firestore rules.
- Deferred Firebase and MapLibre loading and added an offline map fallback.
- Added accessible dialog semantics, labels, live regions, expanded state, focus styles, readable muted text, and reduced-motion handling.
- Added service-worker shell caching, documentation, a release/data checklist, automated validation, and a CI workflow.

## Verification completed

- JavaScript syntax checks passed for every module and the service worker.
- `node tests/validate.mjs` passed for all 14 line directions, curated study boundaries, sync merging and deletion, accessibility markers, and the PWA shell.
- Browser smoke testing passed for local-only startup, optional sign-in reopening, Home, Progress, Mystery, Review, Speed Map, Track Speeds, Journey, and Compare Directions.
- A quiz answer and persisted progress were checked in the browser during the audit.

## Release note

The code is ready for static deployment. Before enabling production account sync, deploy `firestore.rules` to the intended Firebase project and perform one authenticated staging round-trip; no production credentials or accounts were changed during this audit.
