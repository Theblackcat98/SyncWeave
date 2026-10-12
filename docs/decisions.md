# SyncWeave Phase 2 — Recorded Decisions

Decided by Nick, 2026-10-11. These resolve the "Decisions required before
corresponding implementation" gates in `phase2.md`. Implementation must not
silently deviate from this record; changes need a new recorded decision.

## 1. Supported platforms and roles

- **Linux desktop: send and receive.** Primary target.
- **Termux/Android: send and receive, deferred where blocked.** Transfer-engine
  code must stay portable (no Linux-only syscalls in the protocol path), but
  physical-device verification (rendering, glyphs, touch) remains an open
  release gate until run on real hardware.

## 2. Transport and identity

- **Noise_XX_25519_AESGCM_SHA256 over raw TCP**, implemented on
  `node:crypto` (no libp2p dependency). Rationale: AES-GCM (not ChaChaPoly)
  because Bun's `node:crypto` provides hardware-backed AES-256-GCM but no
  ChaCha20-Poly1305; a pure-JS ChaCha20 would be slower and add unaudited
  code. Discovery (below) is a separate UDP-multicast mechanism and does not
  require a full libp2p stack. The implementation is verified against the
  official Noise test vector for `Noise_XX_25519_AESGCM_SHA256` (snow's
  vector set), which is stronger evidence than a dependency claim.
  (For reference: LocalSend v2 transfers use HTTPS/TLS over TCP with a
  REST-ish prepare/upload API and UDP multicast for discovery; SyncWeave
  uses Noise instead of TLS for transfers, with its own UDP-multicast
  discovery.)
- **Peer identity:** fresh ephemeral X25519 static key per session for the
  Noise handshake; fresh ephemeral Ed25519 identity key per session, exchanged
  and verified out of band as a libp2p-style Peer ID (protobuf-encoded
  Ed25519 public key, identity multihash, base58btc). The application compares
  the complete expected Peer ID with the verified identity on the exact
  authenticated connection before any metadata flows. No identity keys or IDs
  are persisted; a mismatch aborts the session.
- **Bootstrap:** automatic peer discovery via UDP multicast (LocalSend-style),
  plus manual numeric `IP:port` entry as fallback. Discovered peers are shown
  for the user to pick; discovery never substitutes for identity confirmation.
  The privacy constraint from the spec applies: before both endpoint users
  independently confirm the matching session-bound identity, only the minimum
  LAN discovery fields strictly needed to locate and open a candidate session
  may be visible, and any identifier must be random, session-scoped, and
  unlinkable across sessions. The listener binds `0.0.0.0` (all local
  interfaces; no per-interface selection is implemented) and starts
  automatically with `--real`; it stops when the process exits. It never runs
  hidden: the TUI shows listening state in the header.
  - *Correction 2026-10-11 (review):* the earlier text said "user-selected
    local interface(s), explicitly started/stopped by the receiver" — that
    describes an aspiration, not the implementation. Recorded here as
    unimplemented; see `docs/networking.md`.
  - *Amendment 2026-10-11 (Nick):* the original record said "user-entered
    numeric `IP:port` only, no discovery." That was wrong: SyncWeave is a TUI
    LocalSend and auto discovery is wanted. This amendment supersedes the
    no-discovery profile language in `phase2.md` (§bootstrap, acceptance
    gates); manual entry stays as fallback, not the only path.
- **Default port:** 24816 (unassigned; documented in-app). Interface binding,
  firewall guidance, and behavior under client isolation / VPNs / address
  changes are documented in `docs/networking.md` (to be written with the
  transport implementation).

## 3. Resource and performance budgets (initial; revisit with measurements)

| Budget | Value |
|---|---|
| Max file size | 2 GiB |
| Max session total | 10 GiB |
| Max files per session | 25 |
| Handshake/confirmation timeout | 60 s |
| Per-frame body cap (app framing) | 64 KiB chunks (files stream in chunks; whole files are never buffered) |
| Transfer retries | 3, bounded and user-visible |
| Concurrent sessions per endpoint | 1 (one active transfer session at a time) |

Derived from SyncWeave's direct-LAN file-transfer goals, not copied from
another product. Numbers are starting points; the performance gate in
phase2.md §5 requires measured throughput/memory/CPU before release.

## 4. Destination and recovery policy

- **Collision handling:** automatic rename with ` (1)`, ` (2)`, … suffix
  inserted before the extension, visible in the UI. Never overwrite an
  existing file; never fail the transfer on collision.
- **Temporary files:** received into `.syncweave-<uuid>.partial` inside the
  user-chosen destination, on that destination filesystem; removed on
  failure/cancellation, or retained only as a clearly labelled recoverable
  partial per the recovery rule below.
- **Resume policy:** restart-from-zero. The UI states this explicitly;
  resumability is not implied. Unverified client-reported offsets are never
  trusted.
- **State persistence:** session ids, identity keys/ids, confirmations, and
  authorization tokens are memory-only and die with the process. Only
  non-authorizing local transaction records (completed vs interrupted file
  lists) may persist, per the retention rule in the recovery implementation.

## 5. UI scope correction (Nick, 2026-10-11)

The mock UI's remote pane lists the *receiver's* files. The real app must
not: the receiver's filesystem is not visible to the sender (out of scope).
In real mode the remote pane shows peer/session/transfer status only. The
sender browses their own real filesystem; the receiver picks a destination
directory and accepts per transfer.
