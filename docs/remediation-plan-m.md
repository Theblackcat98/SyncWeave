# SyncWeave remediation plan — path to production-ready

Written 2026-10-11 after two review rounds (8 subagent sweeps total):
round 1 covered the network/security core, discovery, app wiring, and UI/docs;
round 2 covered mock leftovers, operational hardening, test gaps, and
supply chain. Everything round 1 found is fixed and on `main`; this document
tracks what remains.

"Production-ready" here means: a user can install it, run it, send and receive
files on a LAN, diagnose failures, and never see mock behavior or a broken
terminal. It does **not** mean audited against nation-states; the threat model
is a hostile LAN peer (see `docs/networking.md`).

## Already done (2026-10-11, on `main`)

Not repeated below — recorded so the plan doesn't re-litigate them.

- **Security:** Noise XX verified against official vectors; Gate B/C; receiver
  budgets enforced both ends; JSON shape validation; `manual:` discovery
  namespace reserved; alias control-char stripping; `dialNoise` strict
  `isIP()` (no DNS leak); consent screen shows the verified sender ID.
- **Availability:** 60 s handshake budget, 15 s header / 60 s body timeouts,
  abortable accept loop on dispose.
- **Real-mode correctness:** consent bridge (keyboard + mouse), send-review
  Enter path, peer cycling in the Receiver pane, no peer duplication, mock
  commands (`incoming`/`peer`/`favorites`/`p`/`favorite-open:`/`queue-retry`)
  gated, EADDRINUSE friendly message, `--peer`/`--port` validation.
- **UI truthfulness:** header, help, queue, footer hints, send-review,
  transfer title all mode-aware; no mock text reachable in real mode
  (exhaustive string sweep + call-path tracing).
- **Docs:** `docs/networking.md`, README real-mode section,
  `docs/real-mode-checklist.md`, `phase2.md` marked superseded,
  `docs/decisions.md` corrected (64 KiB chunks, actual binding).
- **Tests:** 102 passing; flaky peer-id test fixed (10/10 clean runs).
- **Supply chain:** one runtime dep (`@opentui/core` 0.6.0, exact pin,
  sha512-hashed lockfile, `--frozen-lockfile` CI, MIT/BSD/Apache only,
  no secrets in repo).

## P0 — blocks real usage, fix first

| # | Item | Why | Fix sketch | Effort |
|---|---|---|---|---|
| P0-1 | No SIGTERM/SIGHUP handling | `kill <pid>`, terminal close, SSH drop → instant death mid-alternate-screen: broken terminal (raw mode, hidden cursor), orphaned `.partial` files. No `process.on` handler exists anywhere. | Register `SIGTERM`/`SIGINT`/`SIGHUP` in `main.ts` running the same dispose path as Ctrl+C (`discovery.stop()`, `listener.close()`, `aborter.abort()`, `renderer.destroy()`), then `exit(0)`. Add `uncaughtException`/`unhandledRejection` → restore terminal, print error below TUI, exit non-zero. | S |
| P0-2 | `~/Downloads` never created | `safe-receive-sink` requires an *existing* dir; nothing creates it. Fresh machines, containers, **Termux** (explicit target) → every receive fails with cryptic `ENOENT`. | `mkdir(receiveDirectory, {recursive:true})` at real-mode startup; fail fast with a clear message on permission errors. | S |
| P0-3 | O(n²) buffer growth in transport reader ([`#24`](https://github.com/Theblackcat98/SyncWeave/issues/24)) | `SocketReader.onData` copies the whole buffer per TCP segment → ~90 GB memcpy for a 16 MiB message. Malicious peer only; our app never sends such records. | Chunk queue (array + offset), coalesce only when a read needs contiguous bytes. | M |

## P1 — should fix before wider testing

| # | Item | Why | Fix sketch | Effort |
|---|---|---|---|---|
| P1-1 | No `--help` / `--version` | CLI undiscoverable; `--help` currently launches the mock TUI. Version is a hardcoded `"0.1.0"` string in render.ts, drifting from package.json. | Print usage + exit 0 on `--help`/`-h`; read version from package.json; `--version`. | S |
| P1-2 | Timeout errors surface as `"aborted"` | 60 s handshake/body timeouts throw bare `DOMException("aborted")`. User sees `Send failed: aborted` — indistinguishable from cancel, no phase info. | Throw `signal.reason` / wrap: `"handshake timed out after 60s: peer stopped responding"`. Same for body path. | S |
| P1-3 | No log file | Every failure exists only as ephemeral status-line text. Nothing to attach to a bug report; "why did last night's transfer fail?" is unanswerable. | Append timestamped lines to `$XDG_STATE_HOME/syncweave/syncweave.log` (fallback `~/.local/share/...`): session start/stop, peer discovered/lost, transfer start/accept/decline/complete/fail + error, consent decisions. One `logEvent()` helper. | S |
| P1-4 | Consent-bridge + send-path tests | Tonight's critical bugs (wedged receive loop, mock send path) were found by *reading* — zero tests exercise `pendingConsent`, `command("consent-accept"/"decline")`, or `beginRealSend`. A regression re-wedges the receiver silently. | Drive `pendingConsent` via stubbed `receiveFiles` (or inject `realConsentResolver`); exercise keyboard `a`/`Enter`/`x`/`Esc` + commands; second-pending auto-decline; `beginRealSend` success/failure with stubbed `sendFiles`. | M |
| P1-5 | `main.ts` CLI tests | Entire CLI surface untested (Nick hit the EADDRINUSE crash live). `--peer` IPv6 parsing, `--port` validation, friendly errors. | Extract argv parsing to an injectable `parseArgs(argv)`; unit-test all variants. | S |
| P1-6 | Symlink send footgun ([`#25`](https://github.com/Theblackcat98/SyncWeave/issues/25)) | Symlink listed as 0-byte file, sent as target's bytes. Symlink → `/dev/zero`/FIFO hangs the sender forever. | Surface symlinks distinctly / filter from staging; refuse to send (or `O_NOFOLLOW`). | S |
| P1-7 | Discovery-start failure invisible | `console.error` before `renderer.start()` gets painted over; user sees no peers and no explanation. | Surface in-TUI (status line / header badge) in addition to stderr. | S |
| P1-8 | `--discovery-port` / `--dest` flags | Two instances on one host fight over UDP 24817; receive dir hardcoded (also [`#27`](https://github.com/Theblackcat98/SyncWeave/issues/27)). `DiscoveryService` already accepts `discoveryPort` — just not exposed. | Add both flags (+ env fallback `SYNCWEAVE_PORT` etc.). Document the rest of the constants in `docs/networking.md`. | S |
| P1-9 | Raw errno strings | `ENOSPC`/`EACCES`/`ECONNREFUSED` pass through with no actionable guidance. | Map common errnos at the `app.ts` boundary: disk-full → "free space and retry", refused → "is the other instance running on that port?", etc. | S |

## P2 — hardening & correctness follow-ups

| # | Item | Why | Effort |
|---|---|---|---|
| P2-1 | Retry loop ([`#26`](https://github.com/Theblackcat98/SyncWeave/issues/26)) — decisions.md says 3, only mock has it | M |
| P2-2 | Destination picker ([`#27`](https://github.com/Theblackcat98/SyncWeave/issues/27)) — `[D]` cycles one hardcoded option | M |
| P2-3 | Arg-parsing hardening — `--alias --port` silently sets alias to `"--port"`; unknown flags ignored | S |
| P2-4 | Peer disconnect mid-transfer (both sides) — untested; Wi-Fi drops are production reality | M |
| P2-5 | Handshake-timeout testability — `HANDSHAKE_TIMEOUT_MS` not injectable; the DoS fix has no test | S |
| P2-6 | `dialNoise` `isIP()` rejection test — one-line test guarding the DNS-leak boundary | S |
| P2-7 | Receiver-pane peer-cycling test — brand-new code, zero coverage | S |
| P2-8 | `syncPeers` dedup regression test — guards the duplication bug Nick saw live | S |
| P2-9 | 256-peer eviction + `onPeersChanged` change-semantics tests — spoofing-hardening code | S |
| P2-10 | `bodyTimeoutMs` stall test — header timeout has one, body doesn't | S |
| P2-11 | CI: SHA-pin actions, enable Dependabot, add `bun audit` step | S |
| P2-12 | Mock services still instantiated in real mode (`main.ts:117-119`) — inert but misleading; pass stubs or make optional | S |
| P2-13 | Sweep stale `.syncweave-*.partial` files on startup (kill -9 / SIGTERM orphans) | S |

## P3 — tracked, not blocking

- **Physical verification** ([`#28`](https://github.com/Theblackcat98/SyncWeave/issues/28)): two-host LAN end-to-end, packet captures, multicast across his router/AP, firewall behavior, throughput/CPU/memory, Termux physical device, client-isolation/VPN, threat-model review. Needs Nick's hardware.
- `SYNCWEAVE_MODE=real` env var undocumented — document or remove.
- `@types/bun` 1.4.2 vs CI Bun 1.4.3 drift — align on next dep bump.
- `diff`/`marked` transitive CVEs checked: pinned versions include the fixes; not exploitable here (no `parsePatch` on input, no browser DOM).
- `Mock*` type names (`MockPeer` etc.) now serve both modes — renaming is churn; left as-is.

## Test checklist for this plan

`docs/real-mode-checklist.md` remains the manual QA gate. It should pass
end-to-end *after* P0–P1 before any "production-ready" claim. Add automated
coverage for P1-4, P1-5, P2-4–P2-10 as the fixes land.

## Definition of done

- [ ] P0-1–P0-3 fixed, tested, on `main`
- [ ] P1-1–P1-9 fixed, tested, on `main`
- [ ] `docs/real-mode-checklist.md` passes on two real machines (not just loopback)
- [ ] CI green; `bun audit` clean
- [ ] Issue `#28` fully checked off (physical verification)
- [ ] P2 items either fixed or explicitly deferred with a decision record
