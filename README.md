# NIET Attendance Planner

A Chrome extension for NIET ERP that reads attendance data from `nietcloud.niet.co.in`, estimates how many classes you can safely miss, and simulates the impact of future absences.

## What it does

- Scrapes the attendance table directly from the NIET ERP portal
- Injects status badges and a summary bar on the ERP page
- Pulls upcoming timetable data from portal JSON endpoints
- Stores attendance, timetable, and simulation history in `chrome.storage.local`
- Shows a popup dashboard with overall risk, bunkable classes, leave days, and what-if simulations
- Includes a generated `dist/` build so the repo can be loaded as an unpacked extension right away

## Project structure

- `src/content/`: content script that watches the ERP page, scrapes attendance, and syncs timetable data
- `src/background/`: service worker that handles messaging, storage updates, and badge state
- `src/lib/`: attendance engine, ERP parsing helpers, storage wrapper, and shared types
- `src/popup/`: popup UI, styles, and simulation controls
- `scripts/`: build helpers for bundling the content script and copying static assets
- `dist/`: production build output for loading in Chrome

## Load the extension

1. Open `chrome://extensions`
2. Turn on Developer mode
3. Click Load unpacked
4. Select the `dist` folder from this repository

## Develop locally

```bash
npm install
npm run build
```

For watch mode:

```bash
npm run dev
```

## Notes

- The extension is scoped to `*://nietcloud.niet.co.in/*`
- All student data stays in the browser via `chrome.storage.local`
- The current attendance threshold is configured as `75%`
