# Remediation plan template

````markdown
# {Project} remediation plan

Audit date: {date} · Audited commit: `{sha}` · Toolchain: {versions}

One paragraph: how the audit was done (N sections, parallel auditors),
how many raw findings were merged into how many items, and how evidence is
tagged.

## Contents
(numbered links to each section)

## 1. Summary
- Status today: build, tests, coverage. Say where the green suite is
  misleading.
- The 3–6 themes that matter most, in plain language, each with one
  concrete example.
- Item counts: P0 n · P1 n · P2 n (total).

## 2. What is already solid
Bullets of things verified correct. Keep them covered while refactoring.

## 3. P0: release blockers
(Note any items that share a breaking change and must ship together.)

### P0-1 · Title
- **Where:** file:line, ...
- **Problem:** ... (what was reproduced, with numbers if measured)
- **Fix:** concrete steps
- **Sources:** APP-1, NET-7, QA-2

## 4+. P1 sections, grouped by theme
| ID | Problem | Where | Fix | Sources |
|---|---|---|---|---|
| P1-1 | ... | ... | ... | ... |

## n. P2: polish, performance, dead code
(same table format)

## n+1. Tests / CI and packaging / Documentation
(same table format; these are often P1)

## n+2. Suggested sequencing
Step 1: quick wins (no breaking changes) → Step 2: hardening → Step 3: the
bundled breaking change → Step 4: structural cleanup → Step 5: polish →
Step 6: release engineering → Step 7: P2 backlog. Each step lands with its
tests.

## n+3. Definition of done
A mechanically checkable list: all P0 closed with regression tests that
fail on the audited commit, coverage floors, e2e in CI, docs matching the
code, the manual checklist passed on real hardware, and so on.
````

## Consolidation checklist
- [ ] Every raw finding is either merged into a plan item (its ID listed
      under Sources) or deliberately dropped as unconfirmed, a duplicate,
      or not a bug.
- [ ] Plan IDs are unique; summary counts match the body.
- [ ] Cross-references (for example "see P1-10") point to the right item.
- [ ] Every P0 has a location, a reproduction or rationale, and a fix.
- [ ] Unverified items are marked as such.
