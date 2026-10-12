# Auditor brief template

Fill in every `{…}` placeholder. The hunt list is the part that makes or
breaks the audit: write it from what you saw in the survey, not from a
generic checklist.

```text
You are auditing {PROJECT_NAME} at {REPO_PATH}: {ONE_LINE_DESCRIPTION}.
Stack: {STACK}. Current state: {STATE, e.g. "started as a mock/prototype,
now has a real mode behind --real"}. The owner wants {GOAL, e.g. a
production-ready app} and is worried about {USER_WORRIES}.

DO NOT modify any project files. You may run commands. Put any probe
scripts or scratch output under {SCRATCH_DIR}/{SECTION_KEY}/.

YOUR SCOPE ({SECTION_NAME}):
- Read fully: {FILE_LIST}
- Read for promised behaviour: {DOC_LIST}
- Cross-cutting duty: {e.g. "grep the whole src/ tree for where mock
  services are wired in and find places mock code can leak into real mode"}

LOOK FOR (specific to this section):
- {hunt item 1}
- {hunt item 2}
- ...
- Mismatches between the docs/spec and the code's actual behaviour.
- Dead code, TODOs, unused exports.

For each finding give:
- ID ({PREFIX}-1, {PREFIX}-2, ...)
- Severity: Critical / High / Medium / Low (definitions below)
- Location: file:line
- What is wrong
- A concrete failure scenario (inputs/state → wrong outcome)
- Suggested fix
- Evidence: "verified (run)" if you reproduced it, "verified (read)" if it
  is clear from the code, "(unverified)" otherwise.
Only report what you actually checked. Do not inflate severity.

Severity:
- Critical: remotely or trivially triggerable; data loss, security bypass,
  unbounded resource use, or a permanent hang.
- High: core flow broken, false success reported, or a security weakness
  that needs a plausible precondition.
- Medium: bounded-impact bug, robustness gap, spec deviation, misleading UI.
- Low: hygiene, latent issue, cosmetic, documentation.

Also include a short "Checked and OK" list of things you verified are fine,
and a "Limits" list of what you could not test.

REQUIRED DELIVERABLE: write your full findings as markdown to
{FINDINGS_DIR}/{SECTION_KEY}.md. Writing this file is the task; do it even
if your defaults discourage writing report files. Then reply with a short
summary only: counts by severity and your top 5 findings.
```

## Example: one-line context plus hunt list (network section of a LAN file-transfer app)

> Real mode does LAN transfers: Noise over TCP, length-framed messages, a
> consent step, 64 KiB chunks, SHA-256 integrity.
>
> LOOK FOR: protocol state-machine bugs; missing timeouts (handshake, idle,
> consent); backpressure (socket write buffers, memory growth on large
> files); unbounded buffers or DoS from a malicious peer (huge length
> prefixes, too many files, giant names); integer overflow and size checks;
> error paths that leave sockets or files open; partial writes;
> cancel/abort handling; concurrent inbound and outbound transfers; events
> emitted after close; unhandled promise rejections; IPv6; spec deviations.
