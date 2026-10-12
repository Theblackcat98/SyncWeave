# SyncWeave Recorded Decisions

Decided by Nick, 2026-10-11, unless marked otherwise. These resolve the
"Decisions required before corresponding implementation" gates in
`docs/history/phase2.md` (archived). Implementation must not silently deviate
from this record. A change needs a new recorded decision, and the Status column
must be updated.

**Status values**

- **implemented**: the code does this, and tests or evidence exist (see
  [release-gates.md](release-gates.md) for what is verified on hardware).
- **deviation**: the code or this round's target differs from the 2026-10-11
  record. The record is amended below and the reason is given.
- **deferred**: recorded as intended, but not built in this round. Known gaps are
  in [known-limitations.md](known-limitations.md).

---

## 1. Supported platforms and roles

| Platform | Roles | Status |
|---|---|---|
| Linux desktop | Send and receive. Primary target. | implemented |
| macOS (arm64 and x64) | Send and receive. CI runs the test suite on `macos-latest`. | deferred: the macOS CI job was added in this round and has not run yet. It becomes supported when that job is green and a manual run is recorded. |
| Termux/Android | Send and receive. Transfer-engine code stays portable (no Linux-only syscalls in the protocol path). | deferred: physical-device verification (rendering, glyphs, touch, networking) is an open release gate. |

## 2. Transport and identity

- **Noise_XX_25519_AESGCM_SHA256 over raw TCP**, implemented on `node:crypto`
  (no libp2p dependency). Rationale: AES-GCM (not ChaChaPoly) because Bun's
  `node:crypto` provides hardware-backed AES-256-GCM but no ChaCha20-Poly1305; a
  pure-JS ChaCha20 would be slower and add unaudited code. Discovery (below) is a
  separate UDP-multicast mechanism and does not require a full libp2p stack. The
  implementation is verified against the official Noise test vector for
  `Noise_XX_25519_AESGCM_SHA256` (snow's vector set).
  (For reference: LocalSend v2 transfers use HTTPS/TLS over TCP with a REST-ish
  prepare/upload API and UDP multicast for discovery. SyncWeave uses Noise instead
  of TLS for transfers, with its own UDP-multicast discovery.)
  Status: implemented.

- **Peer identity, per session.** A fresh ephemeral X25519 static key per session
  for the Noise handshake, and a fresh ephemeral Ed25519 identity per session.
  The identity is shown as a Peer ID: `z` + base58btc of the protobuf-encoded
  Ed25519 public key (`08 01 12 20 <32-byte key>`), with no multihash wrapper —
  it is NOT a libp2p Peer ID (no identity-multihash header, no `12D3KooW`
  prefix). See `src/services/peer-id.ts`. No identity keys or IDs are persisted.
  Status: implemented.

- **Identity check: security code, not discovery.** *Amended 2026-10-12.* The
  original record said the application compares the complete expected Peer ID
  with the verified identity before any metadata flows. That is withdrawn. A
  discovery Peer ID is a display hint and is never used as the expected identity.
  Identity is checked by the humans on both ends: the sender confirms the
  security code (SAS) before any file metadata is sent (`SendOptions.confirmSas`),
  and the receiver confirms it on the consent screen. Manual `--peer` peers work
  the same way. Reason: discovery Peer IDs are per run, so they could never match
  the per-session identity that the handshake proves. Status: deviation, amended.

- **No TOFU pinning.** *Recorded 2026-10-12.* Nothing about a peer (its alias,
  Peer ID, key or address) is pinned or stored between runs, for discovered or
  manual peers. A user compares the security code for each transfer. Status:
  implemented.

- **Discovered names are claimed.** *Recorded 2026-10-12.* A discovery alias is
  shown as "claimed" on the send and consent screens, because anyone on the LAN
  can announce any alias. Status: implemented.

- **Default alias is a random per-run label.** *Recorded 2026-10-12.* The default
  is no longer `$USER`. The alias is generated for each run, so it does not link
  runs together or leak the username by default. `--alias` overrides it, and the
  alias is visible on the LAN. Status: implemented.

- **Protocol v2 (2026-10-12).** The wire version was bumped after a hostile-peer
  audit. Changes: identity proofs sign a tagged, role-bound message
  (`syncweave-id-proof-v2 ‖ role ‖ 0x02 ‖ handshakeHash`) with a Noise prologue;
  the SAS (`1234-5678-9012`) derived from the handshake hash is shown on both ends
  for human confirmation; the sender confirms the SAS before it sends metadata;
  the receiver acknowledges each file (`FILE_RESULT`, with hash and size that the
  sender checks) and the session (`SESSION_RESULT`); the sender reports success
  only on matching acknowledgements; explicit `DECLINE`, `CANCEL` and `ERROR`
  frames; per-type body caps (handshake-adjacent 4 KiB, request and accept 64 KiB,
  chunk ciphertext at most 65,535 B); acceptance by unique indices, referring to
  the offered files by reference; session ID derived from the transcript hash and
  validated per frame. v1 is rejected. Status: implemented.

- **Bootstrap.** Automatic peer discovery via UDP multicast (LocalSend-style), plus
  manual numeric `host:port` entry as a fallback. Discovered peers are shown for
  the user to pick. Discovery never substitutes for identity confirmation. The
  privacy constraint from the original spec still applies: only the fields needed
  to locate a candidate are visible, and any identifier is random, session-scoped
  and unlinkable across sessions. See [privacy.md](privacy.md) for what is visible
  on the LAN. Status: implemented.
  - *Correction 2026-10-11 (review):* the earlier text said "user-selected local
    interface(s), explicitly started/stopped by the receiver". That described an
    aspiration. The implementation does not select interfaces. Status: deferred.
  - *Amendment 2026-10-11 (Nick):* the original record said "user-entered numeric
    `IP:port` only, no discovery." That was wrong. SyncWeave is a TUI LocalSend and
    auto discovery is wanted. Manual entry stays as a fallback, not the only path.
    This supersedes the no-discovery language in the archived `phase2.md`.
    Status: implemented.

- **Listener bind address.** *Amended 2026-10-12.* The 2026-10-11 record said the
  listener binds `0.0.0.0`. That is withdrawn. The default bind is `::`
  (dual-stack). If no `--bind` was given and IPv6 is unavailable, SyncWeave falls
  back to `0.0.0.0` and shows a notice (R5). An explicit `--bind` never falls back.
  Interface selection is still not implemented (see the correction above).
  Status: deviation, amended.

- **Listening state.** The listener starts automatically with `--real`, stops when
  the process exits, and never runs hidden: the header shows a listening indicator.
  Status: implemented.

- **Default port:** 24816 (unassigned; documented in-app). Interface binding,
  firewall guidance, and behaviour under client isolation, VPNs and address changes
  are in [networking.md](networking.md). Status: implemented for the port and
  guidance. Address-change behaviour is unverified.

## 3. Resource and performance budgets (initial; revisit with measurements)

| Budget | Value | Status |
|---|---|---|
| Max file size | 2 GiB | implemented |
| Max session total | 10 GiB | implemented |
| Max files per session | 25 | implemented |
| Handshake/confirmation timeout | 60 s handshake. Receiver consent window 60 s. Sender waits up to 75 s for acceptance. | implemented |
| Per-frame body cap (app framing) | Chunk bodies at most 65,474 B, so the ciphertext stays under 65,535 B. Recorded as 64 KiB; the 64 KiB figure was the target and the Noise limit sets the real value. Files stream in chunks and are never buffered whole. | deviation, amended |
| Transfer retries | None. Retries are deferred. A failed transfer is resent by hand from the start. | deferred (amended 2026-10-12; the 2026-10-11 value was 3) |
| Concurrent sessions per endpoint | Receiver: one at a time. Sender: not capped. | deviation: the sender cap is not implemented and is not planned for this round |

Derived from SyncWeave's direct-LAN file-transfer goals, not copied from another
product. Numbers are starting points. The performance gate in the archived
`phase2.md` §5 requires measured throughput, memory and CPU before release. No
measurements exist yet (see [release-gates.md](release-gates.md)).

## 4. Destination and recovery policy

- **Collision handling.** Automatic rename with ` (1)`, ` (2)`, … inserted before
  the extension, visible in the UI. Never overwrite an existing file. Status:
  implemented for the normal case.
  - *Deviation 2026-10-12:* the original record said "never fail the transfer on
    collision". If another file takes the chosen name between the collision check
    and publication, the transfer fails, and it is not retried with a new name.
    Status: deviation, open.

- **Destination picker.** *Recorded 2026-10-12.* The picker can add, remove and
  cycle receive folders, and the list persists in `destinations.json`. It refuses
  symlinks, system directories, hidden (dot) directories and world-writable
  directories, and it does not create relative or `~user` paths. Status:
  implemented in this round (see known-limitations for checks that run only at
  selection time).

- **Temporary files.** Received into `.syncweave-<id>.partial` inside the
  user-chosen destination, on that filesystem. Removed on failure and cancellation.
  Created with `O_EXCL` and mode `0600`. Status: implemented.

- **Startup sweep.** *Recorded 2026-10-12.* At startup, SyncWeave removes
  `.syncweave-*.partial` files only when the process that created them is no longer
  running. A live partial, including one from a second running instance, is never
  removed. Status: implemented in this round (the 2026-10-11 record said partials
  are removed or retained as a labelled recoverable partial; the recoverable-partial
  option is not built).

- **Resume policy: restart from zero.** The transfer is not resumed. Unverified
  client-reported offsets are never trusted. The user is told this on the screen and
  in the docs; there is no automatic recovery. Status: implemented (no resume exists;
  the retry path is deferred, see section 3).

- **State persistence.** Session IDs, identity keys, Peer IDs, confirmations and
  authorization tokens are memory-only and die with the process. Persisted:
  - the destination list (`destinations.json`), which is a local preference and
    does not authorize anything;
  - the diagnostic log (`syncweave.log`), which records events, aliases, bind
    addresses, destination paths, file counts, Peer ID prefixes and the SAS. It
    never records file contents. See [privacy.md](privacy.md).

  Status: deviation. The 2026-10-11 record allowed only transaction records to
  persist. The destination list and diagnostic log are recorded here.

## 5. UI scope (Nick, 2026-10-11)

The mock UI's remote pane lists the *receiver's* files. The real app must not: the
receiver's filesystem is not visible to the sender (out of scope). In real mode the
remote pane shows peer, session and transfer status only. The sender browses their
own real filesystem, and the receiver picks a destination directory and accepts per
transfer. Status: implemented.

## 6. Tooling and dependency policy

- **Runtime.** Bun **1.4.3**, pinned in `.bun-version` and used by CI through
  `setup-bun`. `engines.bun` is `>=1.4.0`. `@types/bun` matches the pinned version.
  Status: implemented.
- **Lint.** Biome 2, lint only. The formatter is off, so the existing code style is
  not rewritten. Rules that flag the existing style are turned off in `biome.json`.
  `noUnsafeFinally` is off; the `safe-receive-sink.ts` finally-block issue (R8)
  that motivated the exception is fixed (the `published` flag now guards the
  finally block), so the rule can be re-enabled. Status: implemented, with that
  exception pending cleanup.
- **Strict TypeScript.** `strict`, `noImplicitOverride` and
  `noFallthroughCasesInSwitch` are on. `noUnusedLocals` and `noUnusedParameters`
  are off. Turning them on currently reports 11 unused declarations in `src/`
  (see [known-limitations.md](known-limitations.md)). They should be enabled after
  that cleanup. Status: deferred.
- **Coverage floors.** Enforced by `bun run test:coverage`, which runs
  `bun test --coverage` and then `scripts/check-coverage.ts` on the lcov report.
  Floors are global (lines 89%, functions 85%) and per file for `app.ts` (lines
  44%), `transport.ts` (lines 91%) and `transfer-protocol.ts` (lines 99%). Each is
  set just below its 2026-10-12 value. Bun's own `coverageThreshold` is not used,
  because it applies to each file separately and `friendly-errors.ts` is at 0%.
  The 80% goal for `app.ts` real-mode paths is not enforced. Status: implemented
  for the floors above; deferred for the 80% goal.
- **OpenTUI upgrade policy.** `@opentui/core` is pinned to an exact version, because
  it is pre-1.0 and has native optional dependencies. Upgrades happen only as a
  separate, reviewed change, never as a range bump. Each upgrade must pass lint,
  typecheck, the full test suite, the headless UI smoke test, and a manual run in
  real mode on Linux. The change goes in `CHANGELOG.md`. Dependabot proposes
  updates weekly, and `bun audit` runs in CI. Whether Dependabot's bun ecosystem
  accepts these updates has not been confirmed. Status: implemented as policy.
- **Actions.** Third-party actions are pinned by commit SHA and updated by
  Dependabot (remediation plan P2-24). Status: implemented.
- **Remediation plan IDs.** The canonical plan is `docs/remediation-plan.md`.
  `docs/remediation-plan-m.md` is superseded because its IDs collide with ours.
  Status: implemented (banner).
