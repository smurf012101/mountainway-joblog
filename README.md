# Job Log

A small offline-ready app for logging hours, purchases and hired help per property, with month-end owner statements.

- This repo holds only the app's code (served by GitHub Pages). It contains no business data, names, rates or passwords.
- The data lives in the owner's own Google Sheet and Drive. The back end is the Apps Script code inside that Sheet (Extensions > Apps Script).
- Offline: the app opens with no signal, saves entries and receipt photos on the device, and sends them when there is signal.

When you change any app file, also raise the CACHE version in sw.js (for example mw-joblog-v2) so phones pick up the new version the next time the app is opened with signal.
