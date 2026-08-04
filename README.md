# NIET Attendance Planner

A Chrome extension for NIET students. It reads your attendance from the NIET
ERP and tells you, in one line, whether you can afford to miss a class.

Everything stays on your device. No server, no account, no analytics.

---

## Which rule it applies

The verdict is based on your **overall** attendance — the same figure the ERP
shows and the one the institute enforces in practice. If the extension and the
portal ever disagree, that is a bug.

The signed [Attendance Policy 2025-26](attendance_policy_2025_26.pdf) §1 also
asks for 75% in *each* subject individually:

> Every student must maintain a minimum of 75% attendance in each theory and
> practical subject individually.

That clause is not currently enforced, so the extension does not treat it as a
verdict — telling you "not safe" while the institute considers you fine would
be worse than useless. A subject below 75% is instead shown as a quiet note, so
you know about it without it overriding your actual standing.

If enforcement changes, flipping `enforcePerSubject` in
`src/lib/storage.ts` switches every calculation back to weakest-subject
behaviour. That path is covered by tests.

---

## What it does

- **Reads your attendance automatically** when you open the ERP — no typing
- **Detects your branch, section and semester** from the portal itself, so it
  works for every branch and stream with no configuration
- **Syncs your real timetable** for the next 45 days, with actual dates, so
  leave planning accounts for the days you actually have class
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

### From source

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
npm run icons      # regenerate PNG icons from the SVG source
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
owns them` (guards the session/subject id reconciliation) and `per-subject mode
still works when the clause is enforced` (guards the policy escape hatch).

---

## Privacy

See [PRIVACY.md](PRIVACY.md). In short: the extension reads only
`nietcloud.niet.co.in`, stores only in `chrome.storage.local`, never sees your
password, and sends nothing anywhere.

---

## Licence

MIT — see [LICENSE](LICENSE).
