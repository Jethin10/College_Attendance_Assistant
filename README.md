# NIET Attendance Planner

A Chrome extension for NIET students. It reads your attendance from the NIET
ERP and tells you, in one line, whether you can afford to miss a class.

Everything stays on your device. No server, no account, no analytics.

---

## Which rule it applies

The planner uses NIET's current published
[Attendance Policy 2025-26](https://www.niet.co.in/uploads/images/695cc928d0c4c1767688488.pdf) §1 as a planning
reference. It sets 75% in *each* theory and practical subject individually:

> Every student must maintain a minimum of 75% attendance in each theory and
> practical subject individually.

The ERP's aggregate percentage is still displayed as a cross-check, but a high
overall figure does not hide a subject below the published target. Simulations
show both the overall before/after change and the affected subject-level margin.
The extension does not label a student eligible or ineligible for an exam:
condonation, approved exceptions, and the institute's final decision are not
visible from attendance counts alone.

The policy page was cross-checked on 5 August 2026. NIET's public policy index
still lists the 2025-26 document and does not list a newer attendance policy.
The ERP remains authoritative for the actual attendance counts.

See [ATTENDANCE_RULES.md](ATTENDANCE_RULES.md) for the source comparison,
formulae, and limits of what the extension can predict.

---

## What it does

- **Reads your attendance automatically** when you open the ERP — no typing
- **Detects your branch, section and semester** from the portal itself, so it
  works for every branch and stream with no configuration
- **Syncs your real timetable** using recent history plus the next 45 days, so
  unpublished future dates can use the latest recurring class pattern
- **Plans leave** — pick days off, a date range, or a number of classes, and see
  the effect before you commit
- **Shows a summary on the ERP page** above your attendance table (dismissible)
- **Badges the toolbar icon** with your overall percentage

## What it does not do

- It does not know about approved OD, medical condonation, or curricular
  exemptions. Those are applied by your department, not visible to the
  extension, and are not counted here.
- It is not an official NIET product, and its numbers are estimates for
  planning. The ERP is the authoritative record.

---

## Install

### From the Chrome Web Store

Search for "NIET Attendance Planner", or use the store link once published.

### From GitHub Releases (sideload)

1. Go to the [**Releases**](https://github.com/Jethin10/College_Attendance_Assistant/releases) page
2. Download `niet-attendance-planner-v*.zip` from the latest release
3. Unzip the downloaded file — you'll get a folder with `manifest.json` inside
4. Open `chrome://extensions` in Chrome
5. Enable **Developer mode** (toggle in the top-right corner)
6. Click **Load unpacked** and select the unzipped folder
7. Open the NIET ERP, sign in, and visit your attendance page — the extension
   fills in on its own

> **Updating:** To update, download the new zip, unzip it to the same location
> (overwrite old files), and click the refresh ↻ button on the extension card
> at `chrome://extensions`.

### From source (for developers)

```bash
cd extension
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load
unpacked**, and select `extension/dist`.

Open the NIET ERP, sign in, and visit your attendance page. The extension fills
in on its own.

---

## Development

```bash
npm run dev        # watch mode
npm run build      # typecheck, bundle, generate icons, copy assets
npm test           # engine and parser tests
npm run typecheck  # tsc --noEmit
  npm run icons      # regenerate PNG icons from the programmatic icon source
npm run package    # verify dist/ and produce a Web Store zip
```

### Layout

```
extension/
  src/
    background/    service worker — message routing, toolbar badge
    content/       runs on the ERP: scraping, portal fetches, page overlay
    lib/           attendance engine, ERP parser, storage, shared types
    popup/         popup UI
  scripts/         build helpers (content bundle, icons, static copy, packaging)
  tests/           engine and parser tests
```

`src/lib/attendance-engine.ts` holds all the maths and is the file to read
first. It is deliberately free of Chrome APIs so it can be tested directly.

### Testing

Tests are bundled with esbuild (so the `@/` alias resolves) and run under
node's built-in test runner. No test framework dependency.

The most important tests are `missed classes are attributed to the subject that
owns them` (guards the session/subject id reconciliation), the subject-policy
verdict tests, and the schedule-independent individual-class simulation test.

---

## Privacy

See [PRIVACY.md](PRIVACY.md). In short: the extension reads only
`nietcloud.niet.co.in`, stores only in `chrome.storage.local`, never sees your
password, and sends nothing anywhere.

---

## Licence

MIT — see [LICENSE](LICENSE).
