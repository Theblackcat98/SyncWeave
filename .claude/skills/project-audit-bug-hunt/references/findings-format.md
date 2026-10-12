# Findings file format

One markdown file per section, at `{FINDINGS_DIR}/{section_key}.md`.

```markdown
# {Project}: {section name} audit

Scope: files read. Method: reading plus which probes were run, and where.
Limits: what could not be tested.

## Summary
| Severity | Count | IDs |
|---|---|---|
| Critical | n | ... |
| High | n | ... |
| Medium | n | ... |
| Low | n | ... |

## Findings

### PREFIX-1 (High): one-line title
- **Where:** path/to/file.ext:120-134, other/file.ext:88
- **What is wrong:** ...
- **Scenario:** concrete inputs/state → wrong outcome
- **Fix:** ...
- **Evidence:** verified (run: probe name) | verified (read) | (unverified)

...

## Checked and OK
- Things verified to be correct (so the fixer doesn't break them).

## Cross-scope notes
- Issues noticed outside this section's files; not audited in depth.
```

## Severity scale

| Severity | Meaning |
|---|---|
| Critical | Remotely or trivially triggerable; data loss, security bypass, unbounded resource use, or a permanent hang. |
| High | Core flow broken; false success reported; a security weakness that needs a plausible precondition. |
| Medium | Bounded-impact bug, robustness gap, spec deviation, misleading UI or docs. |
| Low | Hygiene, latent issue, cosmetic, minor docs. |
