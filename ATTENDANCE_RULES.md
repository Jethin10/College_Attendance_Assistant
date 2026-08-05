# Attendance calculation and policy basis

Last verified: 5 August 2026.

## Planning target used by the extension

NIET's current public policy index lists **Attendance Policy for students from
Academic Year 2025-26** and does not list a newer attendance policy. Section 1
of that signed document sets at least **75% attendance in each theory and
practical subject individually**. It says students below 75% *may* be detained;
that wording is not an automatic eligibility decision made by this extension.

The extension therefore uses 75% as an advisory planning target, checks the
weakest started subject, and shows aggregate attendance as supporting ERP
context. It never claims that being below 75% automatically prevents a student
from sitting an examination. NIET may apply condonation, approved exceptions,
or other decisions that are not visible in the attendance table.

Official sources:

- NIET policy index: https://www.niet.co.in/quick-links/policies
- Current attendance policy PDF: https://www.niet.co.in/uploads/images/695cc928d0c4c1767688488.pdf
- NIET B.Tech ordinance: https://www.niet.co.in/pdf/Ordinance/B.Tech.pdf
- AKTU B.Tech ordinance 2018-19: https://aktu.ac.in/pdf/syllabus/Syllabus1819/all/B.%20Tech.%20Ordinance_2018-19.pdf
- NIET Student Handbook: https://www.niet.co.in/assets/frontend/pdf/NIET-Students-Handbook.pdf

The policy is linked from NIET's official site instead of being duplicated in
this repository. The copy checked on 5 August 2026 matched the PDF linked by
NIET's policy page.

## Why older documents differ

The 2024 NIET Student Handbook and older NIET/AKTU ordinances describe an
overall-average attendance test and different condonation language. The signed
2025-26 NIET attendance policy is newer, applies across the listed NIET
programmes, says it remains binding until officially revised, and explicitly
uses the per-subject 75% standard. The extension follows that newer,
institute-specific target for calculations while continuing to expose the
overall figure and avoiding exam-eligibility claims.

## Maths

For each subject, the current percentage is:

```text
present count / total count × 100
```

The values come directly from the ERP's **Present Count** and **Total Count**
columns. This reproduces the ERP percentages shown in the attendance table.

When a class is missed:

```text
projected present count = current present count
projected total count   = current total count + missed classes
projected percentage    = projected present / projected total × 100
```

Overall attendance is calculated from the pooled counts:

```text
sum of present counts / sum of total counts × 100
```

Full-day and half-day simulations first select the timetable sessions in the
chosen date window, then apply each missed session to the subject that owns it.
Morning means a session starting before 12:00; afternoon means 12:00 or later.
Individual-class planning uses the exact number entered for the selected
subject even when no matching future timetable occurrence is currently synced.

Recovery classes solve the smallest whole number `n` for which:

```text
(present + n) / (total + n) >= 0.75
```

## Limits and non-modeled adjustments

- The planner assumes a missed scheduled class is recorded as absent: total
  increases and present does not.
- Approved OD, medical condonation, curricular/co-curricular exemptions,
  attendance corrections, holidays added after sync, and faculty changes are
  not predictable from the attendance table alone.
- The current policy describes exceptional consideration for severe medical
  cases, with a 60% floor. The extension cannot know whether an exception or
  condonation will be approved.
- A below-75% result is a planning warning, not a statement that the student is
  barred from an examination.
- The ERP remains authoritative. Refresh the page before relying on a plan.
