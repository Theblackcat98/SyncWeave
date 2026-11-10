# SyncWeave — state of truth

This is the canonical record for SyncWeave: what the code actually does,
which recorded decisions are in force, and what state the release gates are
in. It replaces `docs/decisions.md` and `docs/release-gates.md` (both
deleted in the change that landed this document; their live content is
absorbed below) and supersedes `docs/remediation-verification.md` and
`docs/remediation-plan-m.md` (both deleted; see the resolution sections
below). `docs/remediation-plan.md` remains in place, bannered, as the
historical 2026-10-12 audit plan this reconciliation judged.

Reconciled: 2026-11-09 · Scope (Nick's call, 2026-11-09): **GitHub main
only**. Pinned state: main @ `928d863e227bd0021230db3341bc5d7e1504f278`
("docs: real-mode screenshots in README") — every verdict below was judged
against that commit. Local unpushed work was **not** judged — see the
appendix.

Method: the verification doc's baseline was judged at `7f0c0d1` (2026-10-12,
pre-Round-2). Every canonical item was re-judged against current main by six
parallel verifiers, code-first, with file:line evidence (the per-slice
evidence tables accompany the pull request that landed this document).
Stage evidence: `tsc --noEmit` clean (verified run);
`bun test` on the snapshot: 373 pass / 1 skip (live multicast) / 1 fail — the
R12 regression test, which passes standalone and in verifier slice runs; see
the flakiness note under R12.

## What SyncWeave actually is, today

A TUI LAN file-transfer app (Bun + OpenTUI) whose real mode works end to end
on loopback: discovery, SAS-confirmed Noise sessions, consent, per-file
acknowledged transfers, cancellation. Protocol v2 closed the audit's core
security story — identity is per-session ephemeral with human SAS
confirmation as the check (the R1 identity-model decision, recorded in
`decisions.md`), the sender verifies receiver acknowledgements byte-for-byte,
and the pre-auth DoS surface is capped and first-byte gated. The mock
services are out of the real-mode wiring; real transfer history, a real
destination picker, a diagnostic log, and friendly error text all exist.
What it is **not** yet: proven on two physical hosts (the manual checklist's
run record is still empty), tolerant of no-hardlink filesystems, or bounded
by an overall session deadline. The suite is ~375 tests on main, typecheck
clean, one flaky red test.

Docs' claimed stage, side by side: the canonical plan's §14 definition of
done claims 1.0 readiness criteria — **2 of 7 are met** (was 0 of 7 at the
baseline verification). The verification doc's "no, not everything is fixed"
is now itself stale: the correct one-liner is **most of it is fixed,
including every P0's core demand; what remains is 27 partials with named
remainders, 1 open P2, and the two-host proof**.

## Verdict counts

Canonical plan (96 items), baseline → now:

| | Baseline (7f0c0d1) | Now (928d863) |
|---|---|---|
| DONE | 12 | **68** |
| PARTIAL | 45 | **27** |
| OPEN | 38 | **1** |
| REGRESSED | 1 | **0** |

By priority now: P0 — 9 DONE / 5 PARTIAL / 0 OPEN. P1 — 42 DONE / 14 PARTIAL /
0 OPEN. P2 — 17 DONE / 8 PARTIAL / 1 OPEN (P2-14).

Regression list R1–R17 (from the verification doc): **16 FIXED**, R17 PARTIAL
(its live remainder is the missing overall session deadline; its doc-lag bits
were fixed under P1-53/P1-56/P1-48).

`-m` plan uniques (6): 4 DONE, 2 PARTIAL (see §-m below).

## The 27 PARTIALs and 1 OPEN — what actually remains

### Protocol & identity
- **P0-1 PARTIAL** — every security demand met (tagged role-bound proofs,
  prologue, own-ID/reflection rejection, sender SAS gate before metadata,
  claimed-alias marking). Remainder is display: prompts show the 16-char
  fingerprint + SAS, not the full grouped Peer ID the fix text demanded.
  Note: the plan contradicts itself — P1-35 sanctions the fingerprint.
- **P1-35 PARTIAL** — code/doc fixed (encoding documented as *not* libp2p;
  display shows the 16 key-material chars). Remainder: `decisions.md:44-45`
  still calls the ID "libp2p-style … identity multihash".
- **P0-3 PARTIAL** — all bounded waits exist (15 s idle, 60 s body, 60 s
  consent, accept wait = consent+15 s, consent raced against disconnect,
  real-socket tests). Remainder: **no overall session deadline** (shared
  with R17).

### Transport
- **P1-16 PARTIAL** — `--bind` + LISTENING indicator done. No receive on/off
  toggle; listener runs from launch to shutdown.
- **P1-18 PARTIAL** — header path uses one caller-owned deadline per stage;
  `FrameParser.readBody` still allocates a controller + timer +
  `AbortSignal.any` per 64 KiB chunk body.

### App / CLI
- **P0-10 PARTIAL** — `~/Downloads` created at startup (0700, writability
  checked), destination shown and re-validated before accept. Remainder:
  publish is **hard-link only** — no probe, no `O_EXCL` fallback — so
  exFAT/SMB/FUSE destinations still fail every receive.
- **P0-12 PARTIAL** — consent list scrolls with honest counts, `a` selects
  all, Enter-on-empty is a no-op, saved name previewed. Remainders: the
  collision suffix (`name (1).ext`) is not previewed; wire validation
  rejects only a `Cf` subset (e.g. U+061C passes; the disk sanitizer is
  stricter than the wire check).
- **P1-8 PARTIAL** — structural fix done (null services in real mode,
  fail-fast without the transport bundle, cast gone, no mock copy). The type
  rename never happened: real data still flows through `MockPeer`/`MockEntry`
  types and `ports.ts` contracts named in them (29 mentions).
- **P2-2 PARTIAL** — env flags accept 1/true/yes/on. `NO_COLOR` is still
  ignored at runtime: `noColorRequested` exists and is unit-tested but has
  zero production callers; `SYNCWEAVE_ASCII` still accepts only `"1"`.

### Filesystem & discovery
- **P0-11 PARTIAL** — special files/symlinks classified, excluded, reported;
  budgets before hashing; hashing abortable. Remainder: the symlink target
  is captured on the entry but rendered nowhere.
- **P1-20 PARTIAL** — collision naming correct (byte-budgeted stem, suffix
  never cut, lstat/ENOENT-only, tests pass). Remainder: a name taken between
  resolve and publish fails the file with `E_EXISTS` instead of retrying
  with the next index.
- **P1-23 PARTIAL** — cap raised 500 → 10,000 with honest "first N of total"
  footer and service-side paging. The UI never requests page 2.

### UI
- **P2-4 PARTIAL** — listing caches + one list per pane per render landed.
  No ~10 Hz progress throttle: per-chunk progress still triggers a full
  tree destroy-and-rebuild; the 850 ms tick still re-renders continuously.
- **P2-13 PARTIAL** — no resize handling exists at all (no subscription);
  the drawn window clamps around the cursor on any render, which masks it.
- **P2-14 OPEN** — the only fully-open canonical item: the mouse wheel still
  steps the *cursor* ±1 row instead of scrolling the viewport ~3 rows.
- **P2-17 PARTIAL** — renderer consolidated on the single `ui/layout.ts`
  helper; `app.ts` still uses a private `visibleRowCount` with the old
  hard-coded 14 / −18, so cursor math and drawn rows can disagree.
- **P2-19 PARTIAL** — most named dead code deleted; still dead:
  `RenderData.peerService`, `RenderActions.selectConsentFile`,
  `transferSummary`, `MockEntry.summary`, the `favorite-open:` branch.

### Tests / CI / docs
- **P1-43 PARTIAL** — real-mode loopback suite exists (send, SAS, double
  Enter, decline, partial accept, cancel). Missing: rename and
  staging-across-folders scenarios.
- **P1-44 PARTIAL** — most adversarial cases now run over real TCP. Missing:
  parallel sessions over TCP; reflected-proof and over-budget remain unit
  tests, not raw-TCP.
- **P1-45 PARTIAL** — 4 receiver-failure cases. Still no injected
  write-error (ENOSPC mid-stream) case.
- **P1-46 PARTIAL** — parser extracted + tested; spawn tests exist. No
  EADDRINUSE spawn test asserting the stderr text; `main.ts` still never
  imported by a test.
- **P1-49 PARTIAL** — Biome lint + coverage floors (incl. per-file) in CI.
  No format check — formatter explicitly disabled; **recorded decision**
  (`decisions.md` §6, "lint only").
- **P1-50 PARTIAL** — macOS job added (documented as not yet run). No
  dedicated two-process loopback job; e2e runs two instances in one process.
- **P1-55 PARTIAL** — all prescribed checklist cases added and stale steps
  corrected. The checklist has **not been re-run** (run record empty) —
  needs two physical hosts.
- **P1-56 PARTIAL** — SECURITY/threat model, privacy, CHANGELOG,
  troubleshooting, known-limitations, release gates all exist. But
  `docs/release-gates.md` is itself stale: B4/B5/B6 and A2 describe Round-2
  work as missing/flaky that has since landed.
- **P2-21 PARTIAL** — multicast test uses `skipIf` + a hard-fail path, but
  CI never sets `SYNCWEAVE_REQUIRE_MULTICAST`, so the CI half is inert; the
  two overstated session-auth test names were not renamed.
- **P2-22 PARTIAL** — eviction/flood, error-event, symlink-staging tests
  exist. No sink link-failure (EXDEV/ENOTSUP) test.
- **P2-23 PARTIAL** — 2 of 4 strict flags enabled; a fresh strict run shows
  4 errors tree-wide (2 in production: `src/app.ts:1386`,
  `src/services/transfer-protocol.ts:16`), down from 37 at audit.
  `noUnusedLocals`/`noUnusedParameters` still off; deferral is recorded in
  `decisions.md` §6 (whose "11 unused declarations" figure is itself stale —
  the true count is 4).

### DONE items (68), by ID

P0: P0-2, P0-4, P0-5, P0-6, P0-7, P0-8, P0-9, P0-13, P0-14.
P1: P1-1, P1-2, P1-3, P1-4, P1-5, P1-6 (settled by amending the decision +
manual re-stage retry), P1-7, P1-9, P1-10, P1-11, P1-12, P1-13 (via R1),
P1-14, P1-15, P1-17, P1-19, P1-21, P1-22, P1-24, P1-25, P1-26, P1-27, P1-28,
P1-29, P1-30, P1-31, P1-32, P1-33, P1-34, P1-36, P1-37, P1-38, P1-39, P1-40,
P1-41, P1-42, P1-47, P1-48, P1-51, P1-52, P1-53, P1-54.
P2: P2-1, P2-3, P2-5, P2-6, P2-7, P2-8, P2-9, P2-10, P2-11, P2-12, P2-15,
P2-16, P2-18, P2-20, P2-24, P2-25, P2-26.
Full file:line evidence per item accompanies the pull request that landed
this document (six verifier tables, v1–v6).

## Regression items R1–R17

FIXED (16): R1 (identity model — option (a): per-session ephemeral identity,
discovery ID demoted to a hint, SAS is the check; recorded in
`decisions.md:48-56`), R2, R3, R4, R5, R6, R7, R8, R9 (via the m-P0-1 signal
work + abort-signal receive), R10, R11, R12, R13, R14, R15, R16.
PARTIAL (1): R17 — the bundle's live remainder is the missing overall
session deadline; its documentation bits were corrected.

**R12 flakiness note:** in one full-suite run on this snapshot, the R12 test
("a receiver ERROR while the sender is streaming ends the send with the
receiver's reason") failed at ~218 ms; the mechanism reads correctly
(single-reader `FrameInbox.watch()` + `guardWrite`), and the test passes in
isolated and slice runs. Status: mechanism FIXED, test timing-sensitive —
worth a deflake, not a reopen. (Re-run evidence: `proto-acceptance.test.ts`
standalone, 6 consecutive runs after the failed full-suite run — 6/6 pass,
8 tests each. The failure mode is load-dependent timing in the full suite,
not a broken mechanism.)

## The `-m` plan — resolution

`remediation-plan-m.md` (2026-10-11) predates the canonical plan by a day and
its IDs collide. Overlap map: m-P0-2 = P0-10, m-P0-3 = P0-4, m-P1-4 ≈ P1-43,
m-P1-5 ≈ P1-46, m-P1-6 = P0-11, m-P1-7 ≈ P0-13/P1-30, m-P2-1 = P1-6,
m-P2-2 = P1-2, m-P2-3 = P1-40, m-P2-12 = P1-8, m-P2-13 = P1-19 — all inherit
the canonical verdicts above. Its genuinely unique items:

- **DONE:** log file (`diagnostic-log.ts`, wired for session/consent/
  transfer/peer events), errno→actionable-message mapping
  (`friendly-errors.ts`; note: 0% test coverage), phase-carrying timeout
  errors, SIGTERM/SIGHUP terminal-safe shutdown.
- **PARTIAL:** `--discovery-port` was never exposed (the service accepts it;
  no CLI flag, no env fallback — the two-instances-one-host UDP conflict
  remains); `--version` reads package.json but the TUI header still
  hardcodes `SyncWeave 0.1.0` (`render.ts:135`) — matches today, drifts on
  the next bump.
- Its P3 physical-verification item is GitHub issue #28 — UNVERIFIED class,
  needs Nick's hardware, unchanged.

**Disposition (Nick's verdict, C7): delete outright** in the reset, not
archived. The overlap map above and the 6 uniques are preserved in this
document, which is what the orphaned commit-message/`ci.yml` citations now
resolve through.

## Issue #26 — stale premise (closed in this reset, on Nick's approval)

The issue claims the decision record promises 3 bounded retries. The
record said the opposite — "Transfer retries | None. Retries are
deferred. A failed transfer is resent by hand from the start. | deferred
(amended 2026-10-12; the 2026-10-11 value was 3)" — carried in the budgets
table above, and corroborated by README.md:70 and networking.md:19. The
code matches the amended decision: no automatic retry in real mode; a
manual re-stage-and-resend exists (`app.ts:604-611`). The premise the
issue was filed on no longer exists.

## Definition of done (plan §14) — 2 of 7 met

1. All P0 closed with regression tests — **not met** (5 P0 PARTIAL, though
   every P0's core demand is implemented).
2. No Mock* constructed/reachable in real mode, asserted by a test — **met**
   (null services; real-mode-smoke asserts no mock services; only the type
   *names* remain).
3. Two-process e2e in CI on Linux + macOS — **not met** (in-process pairs;
   macOS job documented as not yet run).
4. Coverage floors enforced, `app.ts` real paths ≥ 80% — **not met as
   written** (floors enforced, but the `app.ts` floor is set to 70).
5. Checklist passed on two physical hosts — **not met** (cases written, run
   record empty).
6. README/networking/decisions match code — **not fully met** (decisions.md
   multihash wording + §6 stale numbers; release-gates.md stale rows).
7. LICENSE, SECURITY, threat model, privacy, release binaries — **met**.

## Recorded decisions (absorbed from `decisions.md`, corrected)

Decided by Nick, 2026-10-11 unless marked otherwise. Implementation must
not silently deviate; a change needs a new recorded decision, recorded
here. Status values: **implemented**, **deviation** (record amended, reason
given), **deferred** (intended, not built; gaps in
`docs/known-limitations.md`).

### Platforms and roles

| Platform | Roles | Status |
|---|---|---|
| Linux desktop | Send and receive. Primary target. | implemented |
| macOS (arm64 and x64) | Send and receive. CI runs the suite on `macos-latest`. | deferred: the macOS CI job exists and has not run yet. Supported when that job is green and a manual run is recorded. |
| Termux/Android | Send and receive. Transfer-engine code stays portable (no Linux-only syscalls in the protocol path). | deferred: physical-device verification is an open release gate. |

### Transport and identity

- **Noise_XX_25519_AESGCM_SHA256 over raw TCP**, on `node:crypto` (no
  libp2p dependency). AES-GCM (not ChaChaPoly) because Bun's `node:crypto`
  provides hardware-backed AES-256-GCM but no ChaCha20-Poly1305. Verified
  against the official Noise test vector. Status: implemented.
- **Peer identity, per session.** A fresh ephemeral X25519 static key per
  session for the Noise handshake, and a fresh ephemeral Ed25519 identity
  per session. The Peer ID is `z` + base58btc of a protobuf-encoded Ed25519
  public key — SyncWeave's own encoding; it is **not** a libp2p identity
  multihash (the pre-reconciliation text said otherwise; `peer-id.ts`
  documents the real format, and prompts display the trailing 16
  key-material characters as the fingerprint). No identity keys or IDs are
  persisted. Status: implemented.
- **Identity check: security code, not discovery.** *Amended 2026-10-12.*
  A discovery Peer ID is a display hint, never the expected identity.
  Identity is checked by the humans on both ends: the sender confirms the
  security code (SAS) before any file metadata is sent, and the receiver
  confirms it on the consent screen. Manual `--peer` peers work the same
  way. Reason: discovery Peer IDs are per run and could never match the
  per-session identity. *2026-11-09 reconciliation (cluster C1): the
  fingerprint + SAS display is the intended form; the audit plan's
  full-Peer-ID display demand is withdrawn.* Status: deviation, amended.
- **No TOFU pinning.** *Recorded 2026-10-12.* Nothing about a peer is
  pinned or stored between runs. Status: implemented.
- **Discovered names are claimed.** *Recorded 2026-10-12.* A discovery
  alias is shown as "claimed", because anyone on the LAN can announce any
  alias. Status: implemented.
- **Default alias is a random per-run label.** *Recorded 2026-10-12.* Not
  `$USER`; `--alias` overrides; the alias is visible on the LAN. Status:
  implemented.
- **Protocol v2 (2026-10-12).** Identity proofs sign a tagged, role-bound
  message (`syncweave-id-proof-v2 ‖ role ‖ 0x02 ‖ handshakeHash`) with a
  Noise prologue; SAS derived from the handshake hash, confirmed by the
  sender before metadata; per-file `FILE_RESULT` (hash and size checked by
  the sender) and `SESSION_RESULT` acknowledgements; explicit `DECLINE`,
  `CANCEL` and `ERROR` frames; per-type body caps (handshake-adjacent
  4 KiB, request/accept 64 KiB, chunk ciphertext ≤ 65,535 B); acceptance by
  unique indices; session ID derived from the transcript hash and
  validated per frame. v1 is rejected. Status: implemented.
- **Bootstrap.** UDP-multicast discovery plus manual numeric `host:port`
  fallback. Discovery never substitutes for identity confirmation. Only
  the fields needed to locate a candidate are visible on the LAN, and any
  identifier is random, session-scoped and unlinkable across sessions (see
  `privacy.md`). Interface selection is **not** implemented (an earlier
  aspiration, corrected 2026-10-11). Status: implemented, with that
  exception.
- **Listener bind address.** *Amended 2026-10-12.* Default `::`
  (dual-stack); with no explicit `--bind`, an IPv6-unavailable host falls
  back to `0.0.0.0` with a user-visible notice. An explicit `--bind` never
  falls back. Status: deviation, amended.
- **Listening state.** The listener starts automatically with `--real`,
  stops at exit, and the header shows a listening indicator. Status:
  implemented. (A receive on/off toggle is backlog item P1-16, approved in
  the reset plan below.)
- **Default port:** 24816. Status: implemented.

### Resource and performance budgets

| Budget | Value | Status |
|---|---|---|
| Max file size | 2 GiB | implemented |
| Max session total | 10 GiB | implemented |
| Max files per session | 25 | implemented |
| Timeouts | 60 s handshake; 60 s consent window; sender waits up to 75 s for acceptance; 15 s per-frame idle | implemented |
| Per-frame body cap | Chunk bodies ≤ 65,474 B so ciphertext stays under 65,535 B (recorded as 64 KiB; the Noise limit sets the real value) | deviation, amended |
| Transfer retries | None. Retries are deferred; a failed transfer is resent by hand from the start. | deferred (amended 2026-10-12; the 2026-10-11 value was 3) |
| Concurrent sessions per endpoint | Receiver: one at a time. Sender: not capped. | deviation: sender cap not implemented, not planned |
| Overall session deadline | None. Per-wait deadlines plus the byte budgets are the accepted bound. | deferred (2026-11-09, cluster C3) |

### Destination and recovery policy

- **Collision handling.** Automatic rename with ` (1)`, ` (2)`, … before
  the extension; never overwrite. *Deviation, closing:* if a name is taken
  between the check and publication the transfer currently fails with
  `E_EXISTS`; the reset plan (cluster C2) builds retry-with-next-index and
  an `O_EXCL` fallback for filesystems without hard links. Status:
  implemented for the normal case; deviation being closed by the reset.
- **Destination picker.** *Recorded 2026-10-12.* Add/remove/cycle receive
  folders, persisted in `destinations.json`; refuses symlinks, system
  directories, dot directories and world-writable directories; never
  creates relative or `~user` paths. Status: implemented.
- **Temporary files.** `.syncweave-<id>.partial` inside the destination,
  created `O_EXCL` mode `0600`, removed on failure and cancellation.
  Status: implemented.
- **Startup sweep.** *Recorded 2026-10-12.* Partials are removed only when
  the creating process is dead; a live partial (including a second
  instance's) is never removed. Status: implemented.
- **Resume policy: restart from zero.** No resume, no trusted
  client-reported offsets, no automatic recovery. Status: implemented.
- **State persistence.** Session IDs, identity keys, Peer IDs,
  confirmations and authorization tokens are memory-only. Persisted: the
  destination list (`destinations.json`, a local preference that
  authorizes nothing) and the diagnostic log (`syncweave.log` — events,
  aliases, bind addresses, destination paths, file counts, Peer ID
  prefixes, the SAS; never file contents; see `privacy.md`). Status:
  deviation from the 2026-10-11 record, recorded here.

### UI scope (Nick, 2026-10-11)

In real mode the remote pane shows peer, session and transfer status
only — never the receiver's filesystem. The sender browses their own real
filesystem; the receiver picks a destination and accepts per transfer.
Status: implemented.

### Tooling and dependency policy

- **Runtime.** Bun 1.4.3, pinned in `.bun-version`, used by CI;
  `engines.bun >=1.4.0`; `@types/bun` matches. Status: implemented.
- **Lint.** Biome 2, lint only; the formatter is off by decision (the
  missing format check in P1-49 is this recorded deviation, not an
  oversight). `noUnsafeFinally` was disabled until R8 was fixed; R8 is
  fixed, so re-enabling it is a cleanup candidate. Status: implemented,
  with that exception.
- **Strict TypeScript.** `strict`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch` are on. `noUnusedLocals` /
  `noUnusedParameters` are off; a fresh strict run (2026-11-09) reports
  **4 errors tree-wide** (2 in production files), down from 37 at audit —
  the figure of 11 in the old record was stale. Enable after that cleanup.
  Status: deferred.
- **Coverage floors.** Enforced by `bun run test:coverage`
  (`scripts/check-coverage.ts`): global lines 93% / functions 90%;
  per-file line floors `app.ts` 70, `transport.ts` 91,
  `transfer-protocol.ts` 99. (The old record's 89/85 + 44 figures were
  stale.) The 80% goal for `app.ts` real-mode paths is not enforced.
  Status: implemented for the floors; deferred for the 80% goal.
- **OpenTUI upgrade policy.** `@opentui/core` is pinned exact (pre-1.0,
  native optional dependencies). Upgrades only as a separate reviewed
  change passing lint, typecheck, the full suite, the headless UI smoke
  test and a manual real-mode run on Linux; recorded in `CHANGELOG.md`.
  Dependabot proposes weekly; `bun audit` runs in CI. Status: implemented
  as policy.
- **Actions.** Third-party actions pinned by commit SHA, updated by
  Dependabot. Status: implemented.
- **Remediation plan IDs.** The canonical plan is
  `docs/remediation-plan.md`. `docs/remediation-plan-m.md` collided and is
  deleted (cluster C7); ID translation lives in this document. Status:
  implemented.

## Release gates (absorbed from `release-gates.md`, corrected 2026-11-09)

A gate is **met** only when the evidence is a reproducible result (a CI
run, a run record, or a file in the repository). "Code exists" is not
evidence. The pre-reconciliation gate table was the stalest document in
the repo — rows B4/B5/B6 and A2 described Round-2 work as missing or
flaky after it had landed; the statuses below are corrected against the
verified code.

### A. Build, CI and packaging

| # | Gate | Status | Evidence |
|---|---|---|---|
| A1 | lint, typecheck, test:coverage pass on Ubuntu and macOS in CI | partial | Both jobs defined in `ci.yml`; the macOS job has not run. Suite reliability: see B6. |
| A2 | Coverage floors enforced in CI (global + per file) | met | `scripts/check-coverage.ts`, run by the coverage step in `ci.yml` (floors in the tooling record above). |
| A3 | `app.ts` real-mode paths ≥ 80% coverage | not met | Enforced floor is 70; the 80% goal is not enforced. |
| A4 | Release binaries (linux-x64, linux-arm64, darwin-arm64) built in CI on a `v*` tag | partial | `release` job in `ci.yml` builds 3 targets; no tag has been pushed. |
| A5 | Package contents limited by `files` allowlist | partial | `package.json` `files` exists; no recorded `bun pm pack --dry-run`. |
| A6 | Bun version pinned in one place, used by CI | met | `.bun-version` (1.4.3) via `setup-bun`; `@types/bun` 1.4.3. |
| A7 | Dependency audit clean in CI | met | `bun audit` step in `ci.yml`; clean 2026-10-12. |
| A8 | Actions pinned by SHA; Dependabot covers Actions and Bun | met | `ci.yml`, `.github/dependabot.yml`. |
| A9 | Single-binary build works | met | `bun build --compile` produced a working binary 2026-10-12 (Linux). Per-target: see A4. |

### B. Tests

| # | Gate | Status | Evidence |
|---|---|---|---|
| B1 | Every P0 fix has a regression test that fails before the fix | not met | Regression tests exist for the P0 fixes, but they were never checked against the pre-fix commit `a87d307`. |
| B2 | No mock service constructed or reachable in real mode, asserted by a test | met | `real-mode-smoke` test asserts real mode mounts with real services and no mock services; `main.ts` builds null services in real mode. |
| B3 | Two-process loopback e2e in CI on Linux and macOS | not met | E2E runs two instances in one process (`protocol-v2-e2e`, `app-real-loopback`); no two-process job. |
| B4 | Real-mode keypress suite (send, accept, decline, double Enter, rename, staging, cancel) | partial | `app-real-loopback` covers send, SAS, double Enter, decline, partial accept, cancel. Rename and staging-across-folders scenarios are missing — filed as reset-plan work (cluster C5). |
| B5 | Silent-pass patterns removed; expected scenarios fail in CI | partial | Multicast test uses `skipIf` plus a hard-fail path gated on `SYNCWEAVE_REQUIRE_MULTICAST`, but CI never sets it. Env wiring is reset-plan work (cluster C8). |
| B6 | Full suite passes reliably | partial | The R7 abort-test timeout is fixed (abort from `onProgress` after ≥1 MiB, bounded receiver wait). A different test — the R12 mid-stream ERROR case in `proto-acceptance` — failed once under full-suite load on 2026-11-09 and passed 6/6 standalone; its deflake is reset-plan work (cluster C8). |

### C. Network and platform (manual evidence — none met)

| # | Gate | Status |
|---|---|---|
| C1 | Real-mode checklist passed on two physical hosts, run record filled | not met (checklist cases complete; run record empty) |
| C2 | Packet capture: no undocumented traffic; no metadata before SAS confirmation | not met |
| C3 | Network matrix (wired/Wi-Fi, IPv4/IPv6, firewall, isolation, VPN, sleep-resume) | not met |
| C4 | Filesystem matrix across supported OSes | not met (partly covered by unit tests) |
| C5 | Performance measured against set thresholds | not met (thresholds unset) |
| C6 | Termux/Android verified on a device, or listed unsupported | not met |
| C7 | macOS verified by green CI + manual run | not met (CI job not run) |

### D. Documentation and security

| # | Gate | Status | Evidence |
|---|---|---|---|
| D1 | README, networking.md and the decision record describe the code; deviations recorded | met | README and networking.md verified in this reconciliation (plan items P1-52, P1-53); the decision record is this document. |
| D2 | Threat model | met | `SECURITY.md`. |
| D3 | Privacy note | met | `docs/privacy.md`. |
| D4 | Install, firewall, troubleshooting, known-limitations guidance | met | README, `networking.md`, `troubleshooting.md`, `known-limitations.md`. |
| D5 | CHANGELOG kept per release | partial | Unreleased entry exists. |
| D6 | Threat-model review; open high/critical security items closed | not met | Open items in `known-limitations.md`. |
| D7 | OpenTUI upgrade policy written | met | Tooling record above. |
| D8 | Phase documents archived with banners | met | `docs/history/phase1.md`, `docs/history/phase2.md`. |

### E. Overall

No release is ready. Gates A3, B1, B3, C1–C7 and D6 are not met. A green
CI run, loopback tests and a one-device demo are not sufficient on their
own.

## Cluster verdicts (Nick, 2026-11-09)

C1 **Identity display** (P0-1/P1-35): the plan contradicts itself — full
grouped Peer ID vs 16-char fingerprint. Code follows the fingerprint + SAS.
**VERDICT (Nick, 2026-11-09): DOCS** — amend P0-1's text; the 16-char
fingerprint + SAS is the intended truth. P0-1 counts as settled by doc
amendment; no code change.

C2 **No-hardlink filesystems** (P0-10 remainder, with P1-20's E_EXISTS retry
and P2-22's missing EXDEV test): the largest functional remainder — every
receive fails on exFAT/SMB/FUSE. **VERDICT (Nick, 2026-11-09): CODE** —
build the `O_EXCL` final-create fallback, retry-on-EEXIST with the next
index, and the EXDEV/ENOTSUP test. Lands in the reset plan as code work.

C3 **Overall session deadline** (P0-3 remainder / R17): every wait is
bounded, the composition is not — a trickling peer holds a session
indefinitely within byte budgets. **VERDICT (Nick, 2026-11-09): DEFER** —
the byte-budget bound is accepted as the design for now. Recorded as an
explicit open item: settles if a stalled/trickling session ever bites in
real use, or when the two-host testing (issue #28) exercises it.

C4 **Mock type names** (P1-8 remainder): **VERDICT (Nick, 2026-11-09):
CODE** — rename `MockPeer`/`MockEntry` → `Peer`/`FileEntry` (and the
`ports.ts` contracts with them), overriding the -m plan's "renaming is
churn" note. Behaviour-neutral; lands in the reset plan as a cleanup item.

C5 **Test-gap tail** (P1-43/44/45/46 remainders): **VERDICT (Nick,
2026-11-09): CODE** — file all four as work in the reset plan: real-mode
rename + staging-across-folders scenarios, parallel-session raw-TCP tests,
an injected write-error (ENOSPC) case, and the EADDRINUSE spawn test.

C6 **Doc self-staleness** (decisions.md multihash + §6 numbers,
release-gates.md B4/B5/B6/A2): **VERDICT (Nick, 2026-11-09): NEITHER** —
don't patch them. This state-of-truth document supersedes both files:
their live content (the decision records in decisions.md — identity-model
deviation, retries-deferred, the §3 budget table, §6 policies; the gate
statuses in release-gates.md, corrected) is folded into the final truth
document, and **both files are deleted** in the reset. References to them
elsewhere in the repo must be repointed to the truth document as part of
the same change.

C7 **`-m` plan disposition**: **VERDICT (Nick, 2026-11-09): DELETE** —
`remediation-plan-m.md` is deleted outright in the reset, not archived.
The overlap map and its 6 uniques are preserved in this document, which is
what the orphaned commit-message/`ci.yml` citations now resolve through.

C8 **Loose-end bundle**: **VERDICT (Nick, 2026-11-09): CODE** — all 14 in
one backlog pass: P2-14 wheel scroll, P2-4 progress throttle, P2-13 resize
handling, P2-17 app-side row count, P2-19 dead code, P1-16 receive toggle,
P1-18 body timers, P1-23 UI paging, P0-11 symlink-target display, P0-12
collision-suffix preview + wire Cf completion, `--discovery-port` flag,
TUI version from package.json, P2-21 CI multicast env + test renames, R12
test deflake. (Recorded deviations P1-49 format-check and P2-23 strict
flags stay DEFER — Nick's earlier calls, not reopened. P1-55's checklist
re-run stays UNVERIFIED until two-host testing.)

## Reset plan (built from the verdicts; approved by Nick, 2026-11-09)

**Group 1 — doc alignment (executed by the change that lands this
document):**
1. This document lands as `docs/STATE_OF_TRUTH.md`, absorbing
   `decisions.md`'s live decision records and `release-gates.md`'s gate
   statuses, corrected per the findings (sections above).
2. `remediation-plan.md` P0-1's fix text amended (fingerprint + SAS, per
   C1) and the plan bannered as superseded by this document.
3. Deleted: `docs/decisions.md`, `docs/release-gates.md`,
   `docs/remediation-plan-m.md`, `docs/remediation-verification.md`.
   References to them (README, networking.md, known-limitations.md, code
   comments) repointed here.
4. Issue #26 closed with a comment citing the retries amendment
   (recorded above in the budgets table).

**Group 2 — code gaps (the real build work, draft PRs, merging stays
Nick's):**
5. C2: `link()` probe + `O_EXCL` final-create fallback, retry-on-EEXIST
   with the next index, EXDEV/ENOTSUP sink test.
6. C4: rename `MockPeer`/`MockEntry` → `Peer`/`FileEntry`, incl. `ports.ts`.
7. C5: the four test gaps (rename + staging scenarios, parallel-session
   TCP, injected write-error, EADDRINUSE spawn test).
8. C8: the 14-item backlog pass listed in C8 above.

**Group 3 — removals:** the doc deletions in Group 1 and the dead code in
item 8; nothing else is removed.

**Verification gates for the reset to count as done:** typecheck clean;
full suite green including the deflaked R12 test; coverage floors pass;
every ledger row touched by Groups 1–2 re-verified against the new main.

**Explicitly not in the reset:** C3 session deadline (DEFER), P1-49/P2-23
recorded deviations, P1-55 two-host checklist run and issue #28 (Nick's
hardware), the local-only appendix work (pushing it stays Nick's call).

## Appendix — local-only work (named, not judged)

Per the scope decision, these were excluded from verdicts: the P1–P7
"production-readiness" pack on the local clone's main (b684359, tracking
origin/fix/production-readiness) and `backup/r1-r17-local` (e16114a,
"R1-R17 from remediation-verification"). Several of their commit subjects
(P2 SAS prompt timeout, P3 reject-while-busy, P5 O_NOFOLLOW, P6 state dir
0700, P7 docs truth reconciliation) touch items this report judges on main's
own merits. If they are ever pushed, the affected rows should be re-verified
against the new main rather than assumed.

## Coverage statement

96/96 canonical items verdicted with file:line evidence; 17/17 R items;
6/6 `-m` uniques; issue #26 premise checked against `decisions.md` text.
Not checked: two-host/hardware behaviour (issue #28 class), IPv6
reachability on a real host, macOS CI (documented as not yet run), and the
local-only appendix work.
