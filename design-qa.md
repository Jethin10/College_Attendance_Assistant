# Design QA — compact NIET attendance planner

## Comparison target

- Source visual truth: `C:\Users\jethi\OneDrive\Documents\JetSnap\Screenshots\2026-08\chrome_iYYHroG53c.png`
- Idle implementation: `C:\Users\jethi\.codex\visualizations\2026\08\05\019fd030-c4ab-7442-963b-1873fe80fd6d\attendance-current-idle.png`
- Calculated implementation: `C:\Users\jethi\.codex\visualizations\2026\08\05\019fd030-c4ab-7442-963b-1873fe80fd6d\attendance-current-projected.png`
- Source pixels: 1920 × 1031.
- Implementation pixels: 1660 × 891; Browser CSS viewport approximately 1670 × 896. The in-app Browser scaled the requested 1920 × 1031 viewport to its available canvas, so the comparison uses proportional layout measurements rather than treating the raw pixels as 1:1.
- States: initial page load and one-day full-leave result.

## Evidence and findings

- No actionable P0/P1/P2 findings remain.
- The original 155px planner band pushed the final attendance rows below the 1031px screen. The revised planner measures 67.99px while idle and 73.61px after calculation. Applied to the supplied page geometry, the recovered vertical space brings the remaining subject row and totals into the initial viewport without changing the NIET header, navigation, term selector, tabs, or table structure.
- The initial state visibly shows `Current attendance`, `88.08%`, and `133 of 151 classes attended`. The fixture recorded zero preview requests before interaction.
- Clicking `Check impact` produced the expected 88.08% → 84.71% result. Editing the duration afterward immediately restored the idle state instead of leaving a stale projection visible.
- The annotated source and final idle implementation were opened together in one full-view comparison input. The requested area now shows the real current attendance prominently while retaining the NIET white surface, blue controls, Arial typography, thin dividers, and desktop grid.
- The calculated state was also captured and inspected. The same right-side value becomes a before → after comparison only after `Check impact`, without adding a card, illustration, icon, or extension branding.

## Required fidelity surfaces

- Fonts and typography: Arial/Helvetica remains aligned with the portal; compact labels retain readable weight and line height.
- Spacing and layout rhythm: title and helper copy share one baseline, controls are 30px tall, and result metadata is arranged on compact rows. The planner remains readable at 68–74px tall.
- Colors and tokens: existing NIET blue, white, neutral gray, and restrained warning red are unchanged.
- Image quality and assets: no new assets were introduced; existing site logos and imagery remain untouched.
- Copy and content: the default state shows the authoritative current percentage and class counts; calculated results appear only after the explicit action.

## Browser interaction evidence

- Initial preview requests: 0.
- `Check impact`: calculates and renders the before/after result.
- Changing duration after a result: clears the stale result and returns to idle.
- Browser console: zero messages.
- TypeScript, 44 automated tests, production build, and `git diff --check`: passed.

## Comparison history

1. P1: impact was calculated automatically on page load and when switching modes.
   - Fix: removed automatic preview calls and added a dedicated idle-state reset for every planning input.
   - Post-fix evidence: zero initial preview requests; only the button triggers calculation.
2. P2: the planner consumed enough vertical space to require a small page scroll.
   - Fix: reduced extension-only padding/control height, placed heading copy on one line, and compacted result metadata without changing site-owned structures.
   - Post-fix evidence: planner height reduced to 67.99px idle and 73.61px calculated.
3. P2: the uncalculated result area did not show the student's current percentage prominently.
   - Fix: made the right result region display `Current attendance`, the current percentage, and attended/held counts while idle; removed the duplicated middle count.
   - Post-fix evidence: final idle capture shows 88.08% in the annotated region, and the clicked state changes it to 88.08% → 84.71%.

final result: passed
