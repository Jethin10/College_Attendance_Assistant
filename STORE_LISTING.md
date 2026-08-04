# Chrome Web Store listing

Copy-paste source for the developer console. Keep in sync with `manifest.json`.

---

## Name

NIET Attendance Planner

## Short description (132 char max)

```
Know if you can safely miss a class. Tracks NIET's 75% requirement for every subject individually, not just your average.
```

## Category

Productivity

## Detailed description

```
NIET Attendance Planner reads your attendance from the NIET ERP and answers one
question: can you afford to miss a class right now?

WHY THIS DIFFERS FROM THE ERP'S NUMBER

The ERP shows your overall attendance. NIET's policy is stricter — it requires
75% in each theory and practical subject individually (Attendance Policy
2025-26, section 1). You can be at 82% overall and still be detained because a
single subject sits at 71%.

This extension leads with your weakest subject and tells you which one is
holding you back.

WHAT IT DOES

• Reads your attendance automatically when you open the ERP — nothing to type
• Detects your branch, section and semester from the portal, so it works for
  every branch and stream without setup
• Syncs your real timetable with actual dates for the next 45 days
• Plans leave: pick days off, a date range, or a number of classes, and see the
  effect on every subject before you commit
• Shows a summary above your attendance table on the ERP (dismissible)
• Badges the toolbar with your lowest subject percentage

PRIVACY

Everything stays on your device. There is no server, no account, and no
analytics. The extension never sees your password — it reads the pages you are
already signed in to. It works only on nietcloud.niet.co.in.

IMPORTANT

Figures are estimates for planning. Approved OD, medical condonation, and
curricular exemptions are applied by your department and are not counted here.
Always confirm against the ERP before making a decision that matters.

This is a student-built tool.
```

## Privacy practices

**Single purpose**

```
Helps a NIET student understand their own class attendance and plan leave
without dropping below the institute's 75%-per-subject requirement.
```

**Permission justifications**

| Permission | Justification to submit |
|---|---|
| `storage` | `Saves the student's attendance and timetable locally so the popup opens instantly and works without re-reading the portal each time. Uses chrome.storage.local only; nothing is synced or transmitted.` |
| `scripting` | `Reads the attendance table when the ERP tab was opened before the extension loaded and no content script is present. Injection is limited to the declared host and runs in an isolated world. No remotely-hosted code is ever executed.` |
| Host `*://nietcloud.niet.co.in/*` | `The NIET ERP is the only site this extension operates on. It reads the signed-in student's own attendance table and timetable endpoints to compute their attendance margin.` |

**Data usage disclosures** — tick only:

- [x] Personally identifiable information (name, roll number) — *not collected, processed locally only*

Certify all three:
- [x] Not being sold to third parties
- [x] Not used for purposes unrelated to the single purpose
- [x] Not used to determine creditworthiness or for lending

**Privacy policy URL**

```
https://github.com/Jethin10/College_Attendance_Assistant/blob/main/PRIVACY.md
```

---

## Assets required

| Asset | Size | Status |
|---|---|---|
| Store icon | 128×128 | `extension/icons/icon128.png` |
| Screenshots | 1280×800 or 640×400 | **TODO — 1 to 5 required** |
| Small promo tile | 440×280 | Optional |

### Screenshot guidance

**Use fabricated attendance data. Never publish a real student's name, roll
number, or figures — screenshots are public and permanent.**

Worth capturing:
1. Popup with a healthy verdict, weakest subject named
2. Popup with a critical verdict showing recovery guidance
3. Leave planner with a result breakdown
4. The on-page summary bar above the ERP attendance table

---

## Before submitting

- [ ] `npm run build && npm test` both clean
- [ ] `npm run package` produces the zip
- [ ] Load `dist/` unpacked and verify against a real ERP session
- [ ] Confirm the permission warning does not mention browsing history
- [ ] Privacy policy URL resolves publicly
- [ ] Screenshots contain no real student data
