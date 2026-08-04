# Privacy Policy — NIET Attendance Planner

**Last updated:** 4 August 2026
**Contact:** jethin047@gmail.com

## Summary

This extension does not collect, transmit, or sell your data. Everything it
reads stays in your own browser. There is no server, no account, and no
analytics.

## What the extension reads

While you are signed in to the NIET ERP (`nietcloud.niet.co.in`) and viewing
your own pages, the extension reads:

- Your attendance figures per subject (classes attended and classes held)
- Your class timetable for the next 45 days
- Your name, branch, section, semester, and roll number, as shown by the ERP

It reads these from the page you are already looking at and from the ERP's own
data endpoints, using the session you are already signed in with.

## What the extension never does

- It does not ask for, see, or store your ERP password
- It does not send your data anywhere — there is no backend server
- It does not use analytics, telemetry, tracking, or advertising
- It does not read any website other than `nietcloud.niet.co.in`
- It does not share or sell data to anyone

## Where your data is stored

All data is stored locally using Chrome's `storage.local` API, on your own
device. It is not synced to a Google account.

## How to delete your data

Removing the extension from `chrome://extensions` deletes everything it stored.
No copy is retained anywhere, because no copy was ever sent anywhere.

## Permissions and why each is needed

| Permission | Why |
|---|---|
| `storage` | Save your attendance locally so the popup opens instantly. |
| `scripting` | Read the attendance table when the page was already open before the extension loaded. |
| `nietcloud.niet.co.in` host access | The only site the extension operates on. |

The extension does **not** request access to your browsing history, your tabs
in general, or any other website.

## Accuracy

Figures shown are estimates calculated from what the ERP reports, and are
provided for planning only. Approved OD, medical condonation, and similar
adjustments are not counted. The ERP remains the authoritative record — always
confirm there before making a decision that matters.

## Changes

Material changes to this policy will be published in this file alongside a new
extension version.
