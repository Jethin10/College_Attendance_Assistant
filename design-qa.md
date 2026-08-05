# Design QA — NIET attendance planner

## Comparison target

- Source visual truth: `C:\Users\jethi\OneDrive\Documents\JetSnap\Screenshots\2026-08\chrome_OnHKAebmxU.png`
- Implementation screenshot: `C:\Users\jethi\.codex\visualizations\2026\08\05\019fd030-c4ab-7442-963b-1873fe80fd6d\attendance-individual-matched.png`
- Full-day screenshot: `C:\Users\jethi\.codex\visualizations\2026\08\05\019fd030-c4ab-7442-963b-1873fe80fd6d\attendance-full-day.png`
- Focused source crop: `C:\Users\jethi\.codex\visualizations\2026\08\05\019fd030-c4ab-7442-963b-1873fe80fd6d\source-planner-focus.png`
- Focused implementation crop: `C:\Users\jethi\.codex\visualizations\2026\08\05\019fd030-c4ab-7442-963b-1873fe80fd6d\implementation-planner-focus.png`
- Source pixels: 1920 × 1031, RGBA.
- Implementation pixels: 1660 × 891, RGB.
- Browser CSS viewport at accepted capture: approximately 1669 × 896 with device pixel ratio 1.61. The in-app Browser scaled its explicit viewport override to its available canvas, so comparison used proportional full-view rendering plus planner-region crops rather than treating the raw pixel counts as 1:1.
- State: desktop, individual-class mode, Activity and Remedial Class, seven missed classes.

## Evidence

### Full-view comparison

The source and implementation were opened together in one comparison input. The implementation preserves the NIET-shaped white planner band, compact Arial typography, blue controls, left-side hierarchy, table alignment, divider, and quiet text link. Intentional changes are confined to the requested controls and result feedback: the fixed class preset is now a numeric count, and the result changes from an unchanged empty state to a visible 100% → 22.22% projection with overall context and recovery guidance.

### Focused comparison

The planner regions were cropped from the actual source and implementation screenshots and opened together in one comparison input. The left heading, caption, subject field, action size, current-attendance line, divider, and return link retain the source hierarchy. The right side now has a subdued starting value, a clear arrow, a stronger projected value, a single delta line, one supporting line, and one policy consequence line. It remains compact and does not introduce a card, shadow-heavy surface, pill stack, or extension branding.

## Required fidelity surfaces

- Fonts and typography: Arial/Helvetica fallback remains aligned with the portal. Sizes and weights retain the compact NIET hierarchy; the projected value uses one stronger 19px emphasis.
- Spacing and layout rhythm: the source band height and three-part structure remain intact. The right column is slightly wider to fit the requested before/after information without wrapping.
- Colors and tokens: portal blue, neutral grays, thin blue-gray dividers, and restrained semantic red/green are used. The action hover changes only slightly and adds a 1px soft shadow.
- Image quality and assets: no new imagery or fabricated visual assets were introduced. The typographic arrow is a comparison separator, not a decorative asset.
- Copy and content: day leave, half-day timing, custom duration, subject-specific impact, overall before/after, subject threshold risk, and recovery copy are all present and data-driven.

## Interaction and browser evidence

- Full day: initial one-day projection rendered 88.08% → 84.71% and six affected classes across five subjects.
- Custom duration: entered 12 days; the UI accepted it and rendered 72 affected classes with no preset cap.
- Half day: morning mode hid the duration input, displayed the timing selector, and rendered three affected classes across two subjects.
- Individual classes: Activity and Remedial Class with seven missed classes rendered 100% → 22.22%, overall 88.08% → 84.18%, and 19 recovery classes.
- Second subject check: Artificial Intelligence with seven missed classes rendered 87.5% → 46.67% and 17 recovery classes.
- Hover: button computed hover state was `rgb(8, 120, 180)` with a restrained `0 1px 2px rgba(0, 82, 125, .18)` shadow.
- Browser console: zero errors or warnings.
- Framework/runtime error overlays: zero.

## Comparison history

1. Initial source state:
   - P1: individual-class simulation showed “No classes scheduled” and no numerical change.
   - P1: the result did not show the original value versus the projected value.
   - P2: the leave duration was limited to a small preset list.
   - P2: the button hover darkened abruptly and felt visually disconnected from the portal.
2. Fixes applied:
   - Individual future-count simulations now synthesize the requested subject count when the timetable has no matching occurrence.
   - Added before → after values, point delta, overall context, subject threshold consequence, and recovery guidance.
   - Replaced fixed day/class presets with validated positive-integer inputs without a visible maximum.
   - Reworked hover/active styling to use a subtle color shift and shallow shadow.
   - Switched the default verdict to the current NIET policy’s per-subject 75% rule while retaining the ERP aggregate as context.
3. Post-fix evidence:
   - Full-view and focused comparisons show no remaining actionable P0, P1, or P2 visual or interaction issues.

## Findings

- No actionable P0/P1/P2 findings remain.
- P3: the in-app Browser capture is slightly softer than the user’s Chrome screenshot because the Browser canvas applies its own scaling; DOM measurements, computed styles, focused crops, and interaction checks confirm the implementation itself is not blurred or rasterized.

final result: passed
