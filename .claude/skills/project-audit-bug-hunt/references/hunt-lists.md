# Hunt-list starters per section

Pick the relevant lines and specialize them to the code. Name the actual
modules, flags and flows you saw in the survey.

## App core / orchestration (APP)
- Entry-point and CLI/config parsing: unknown flags ignored, missing
  values, values that look like flags, loose number parsing, no `--help`.
- Startup errors that are swallowed (a UI framework capturing stdout or
  stderr, an early exit with no message).
- Shutdown: signals, sockets, timers, child processes, and terminal or
  window state not restored. The process staying alive after "quit".
- Re-entrancy: double-submit, actions running concurrently, in-flight
  guards, stale closures.
- State that is never reset, state keyed by array index instead of ID, and
  a selection that silently retargets.
- Unhandled promise rejections and `void promise` with no catch.
- Mock, prototype or demo code reachable in the production path: fallbacks,
  fake data, simulated progress, mock wording, mock-only keybindings or
  routes.

## Network / API / protocol (NET / API)
- Timeouts at every stage (connect, handshake, idle, per-request, overall)
  that are actually enforced, not just declared.
- Backpressure and unbounded buffering; quadratic copying.
- Size limits before authentication; allocation sized by a length the peer
  declares.
- Success reported without acknowledgement; a close treated as success.
- Cancel and abort paths that are ignored once streaming starts.
- Serial accept loops, head-of-line blocking, unbounded pending queues.
- Retries and idempotency; duplicated or replayed requests.
- IPv6 and bind-address handling; spec and protocol deviations.

## Security / auth / crypto (SEC)
- Where trust comes from: is an "expected identity" actually supplied by
  the attacker?
- Is the authentication bound to the session or channel? Role, version and
  domain separation in signatures.
- Comparisons that are not constant-time; nonce reuse; single-use objects
  that can be reused.
- Input validation at trust boundaries (charset, length, Unicode
  bidi/zero-width characters, control characters in anything displayed).
- Secrets in logs, config or the repo; insecure defaults; privacy leaks
  (usernames, hostnames, stable IDs broadcast).
- DoS: flooding, eviction of legitimate entries, missing per-source limits.
- Test-only or debug code shipped in production.

## Data / storage / filesystem (DATA / FS)
- Path traversal, symlink following, TOCTOU, special files (FIFOs, devices,
  sockets).
- Atomic writes, fsync (file *and* directory), temp-file cleanup on crash,
  partial files left behind.
- Missing directories, permissions, disk full, filesystems lacking
  features (hard links, case sensitivity).
- Collision and rename logic near name-length limits.
- Silent truncation (listing caps, pagination), errors shown as "empty".
- Migrations, transactions, N+1 queries, missing indexes, unbounded queries.

## UI / presentation (UI)
- Mock or demo wording and controls still visible in production mode;
  hints that don't match the real handlers.
- Untrusted strings rendered unsanitized (escape injection, CR/LF, bidi
  characters); the displayed value differing from the stored value.
- Lists that don't scroll while actions affect hidden items.
- Layout at small, large and odd sizes; truncation by display width rather
  than code units.
- Progress shown over 100% or as NaN; number and byte formatting edge
  cases.
- Re-render cost (full rebuild per event, unthrottled progress updates).
- Accessibility: contrast, reduced motion, ASCII and no-color fallbacks,
  keyboard reachability.

## QA / build / release (QA)
- Run install (with a frozen lockfile), typecheck, lint and tests, with the
  tests run 3× for flakiness. Record exact results and durations.
- Coverage per file. Flag critical files with low coverage and files never
  loaded by any test.
- Tests that only exercise mocks; tautological or misnamed tests; stubs
  that hide production behaviour; skip paths that silently pass.
- Missing end-to-end and adversarial tests for the real paths.
- CI: OS matrix, version pinning, permissions, timeouts, duplicate runs,
  missing lint/format/coverage gates, dependency scanning.
- Packaging: how a user installs it; license; `bin` or entry point;
  release artifacts.
- Docs: claims the code doesn't meet, stale planning docs presented as
  current, missing SECURITY, threat model, changelog or troubleshooting.
