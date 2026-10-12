# Remediation verification

> **SUPERSEDED.** This document verified `main` at `7f0c0d1`. The round-2
> remediation (PR #32, merged as `4dcff52`) and subsequent fixes supersede
> it. Kept as a historical record; do not treat its verdicts as current.

Verified: 2026-10-12 · Plan: [`docs/remediation-plan.md`](remediation-plan.md) (audit of `a87d307`) · Code verified: `main` at `7f0c0d1` (27 commits after the audit)

Six parallel verifiers each took one slice of the plan:

| Slice | Plan items |
|---|---|
| Protocol and identity | P0-1, P0-2, P0-6, P0-7, P1-9 to P1-14, P1-33 to P1-36 |
| Transport | P0-3, P0-4, P0-5, P0-8, P1-15 to P1-18 |
| App, mock leftovers, CLI | P0-9, P0-10, P0-12 to P0-14, P1-1 to P1-8, P1-37 to P1-42, P2-1 to P2-3 |
| Filesystem and discovery | P0-11, P1-19 to P1-32 |
| UI | P2-4 to P2-20 |
| Tests, CI and docs | P1-43 to P1-56, P2-21 to P2-26, plus the plan's definition of done |

The verifiers judged the code itself, not commit messages. Most verdicts are backed by re-running the original audit probes, or new ones, against the current code (loopback transfers, headless renderer frames, a spawned `main.ts`, strace).

> **ID collision.** `docs/remediation-plan-m.md` reuses the same P0-1…P2-26 IDs
> for *different* items, and several commits, test comments and `ci.yml` cite
> its numbering. Everywhere in this document, IDs refer to
> `docs/remediation-plan.md`.

---

## 1. Summary

| Verdict | P0 | P1 | P2 | Total |
|---|---|---|---|---|
| Fixed | 3 | 9 | 0 | **12** |
| Partial | 11 | 29 | 5 | **45** |
| Not fixed | 0 | 17 | 21 | **38** |
| Regressed | 0 | 1 | 0 | **1** |
| **Total** | 14 | 56 | 26 | 96 |

**Bottom line: no, not everything is fixed.** Substantial work landed,
especially on P0. Every release blocker was attempted, and 3 of 14 are fully
closed:

- Protocol v2 now has role-bound proofs, a Noise prologue, receiver
  acknowledgements, per-type size caps, index-based acceptance, wire binding
  and a session state machine.
- Real timeouts and backpressure exist.
- Startup error messages appear.
- The mock services are out of the real-mode wiring.

However, the fixes introduced **one critical regression**: transfers to
peers found by discovery fail every time. They also introduced several new
high-severity bugs. The test suite is red, and **0 of 7** "definition of
done" criteria are met.

**Toolchain at `7f0c0d1`:**
- `bun install --frozen-lockfile`: passes.
- `tsc`: passes.
- `bun audit`: clean.
- `bun test`: 171 pass, 1 fail. The failing test is
  `e2e: abort signal cancels an in-flight send`, which timed out in 5 of 6
  runs; see [§2, R7](#2-regressions-and-new-issues-fix-these-first).
- Coverage: `app.ts` fell from 57% to 45% of lines, and `main.ts` is still
  never loaded by a test. No lint step and no coverage gate exist.

---

## 2. Regressions and new issues (fix these first)

These were introduced by the fixes, or newly exposed by them. Duplicates
reported by more than one verifier are merged.

| # | Sev | Issue | Where | Fix |
|---|---|---|---|---|
| R1 | **Critical** | **Every transfer to a discovered peer fails.** P1-13 made each session use a fresh identity, but discovery still announces the per-process ID, and the sender pins `expectedPeerId` to it. The proof can never match. Only `--peer` transfers work. The consent card also cannot match the sender to its alias. No test catches this, because every test injects identities. | `main.ts:96,115`; `app.ts:923,1081`; `transfer-protocol.ts:723,1033` | Choose one: (a) per-session identity, and stop using the discovery ID as the expected identity (treat it as a hint and rely on SAS); or (b) one identity per run, and amend `decisions.md`. Either way, add an app-level test that uses discovery-sourced IDs. |
| R2 | High | **The sender gives up after 15 s while the receiver's consent window is 60 s.** The parser's 15 s header timeout also covers the waits for TRANSFER_ACCEPT and FILE_RESULT. A user who accepts after 15 s gets "channel closed", and slow finalization of a large file may be reported as failed. | `transfer-protocol.ts:762,1048` vs `:83,1126` | Give the ACCEPT and result waits their own deadlines of at least the consent window. |
| R3 | High | **A stale consent card stays up after the sender disconnects.** Accept then reports "Accepted… receiving…" or "Noise channel is closed", and the next incoming request auto-declines the stale one. | `app.ts:909-938, 984-988`; `transfer-protocol.ts:1125-1148` | Race consent against channel close, and clear `state.request`, the resolver and the screen on receive failure. |
| R4 | High | **The startup sweep deletes a second instance's live partial file.** The receive in progress then fails with ENOENT. The docs recommend running two instances on one machine. | `main.ts:138-151` | Sweep only partials whose owner is dead (PID plus liveness check, or flock), or older than a threshold, or use a staging directory per instance. |
| R5 | High (affected hosts) | **The default bind `::` has no IPv4 fallback.** Real mode exits at startup on hosts with IPv6 disabled, with a non-actionable message. | `cli-args.ts:72` | Fall back to `0.0.0.0` with a notice, and give an actionable error. |
| R6 | High | **Real transfer history is erased on every render.** The P1-1 fix writes records into `state.transferQueue`, then `syncQueue()` replaces them with the null service's `[]`. The queue and Receiver panel are always empty or idle. | `app.ts:101,107,971,1072`; `null-services.ts:42` | Skip `syncQueue()` in real mode, and set `activeTransferId`. |
| R7 | High | **CI is red: `e2e: abort signal cancels an in-flight send`.** The bug is in the test, not production. The 200 ms wall-clock abort fires during the roughly 280 ms pre-dial hash, before any connection, so `await receiverDone` hangs. Production mid-transfer abort works (1.01 s, CANCEL sent, no partial file). | `protocol-v2-e2e.test.ts:369-409` | Abort from `onProgress` after at least 1 MiB, and bound `receiverDone` with a timeout. A fixed version is in the verifier's scratch (passes in 2.3 s). Separately, make hashing abortable (P0-8). |
| R8 | Medium | **A successful save is reported as failed.** If the temp unlink fails after publishing, the `finally` block retries and throws AggregateError. The sender gets `E_RECEIVE_FAILED`, and a hidden duplicate remains. | `safe-receive-sink.ts:347-360` | Track a `published` flag; after a successful link, never throw. |
| R9 | Medium | **SIGTERM/SIGHUP no longer stop a receive.** The new handlers call `dispose()`, which doesn't abort the receive, so the transfer runs to completion about 15 s later. Before this change, the default handler terminated immediately. | `main.ts:192-198`; `app.ts:952,1166-1184` | Pass an AbortSignal into receive and send, await cleanup, and exit with a bounded timeout. |
| R10 | Medium | **Destination picker problems:** <br>• It accepts `/`, `/etc`, world-writable parents and symlinked paths, and silently creates relative and `~user` paths. Combined with raw names on the consent screen, a user-chosen sensitive directory such as `~/.config/autostart` can receive a new file. <br>• A destination that has vanished is accepted, then fails with ENOENT after consent. <br>• Partial files left in picker destinations are never swept. <br>• Typed input and validation messages are invisible on the consent screen. <br>• The queue record shows the wrong directory. | `destinations.ts:23-36, 67-92`; `app.ts:616-635, 782-817, 978` | Add a deny-list or `$HOME` scoping, `lstat` and refuse symlinks, re-validate before accept, sweep every destination, and draw the input inside the consent card. |
| R11 | Medium | **Two identical files in one request can't be accepted.** The receiver maps accepted entries back to indices by content and fails with "duplicate accepted file". | `transfer-protocol.ts:1167-1179`; consent rows keyed by sha256 | Key the rows and the mapping by request index. |
| R12 | Medium | **The sender can't see a receiver error mid-stream.** It writes without reading, so it reports only "Noise channel is closed". | `transfer-protocol.ts:877-895` | Read control frames concurrently while streaming. |
| R13 | Medium | **The real-mode header is garbled at every width from 90 to 112 columns.** The new LISTENING indicator has no width budget. At the audit, only 90–94 was affected. | `render.ts:86-106` | Fold into P2-5. |
| R14 | Medium | **Memory is still reachable before consent.** Connections that complete the handshake but are never accepted each buffer 30–40 MiB: 24 channels from one IP reached 707 MiB. Chunks are pinned for about 15 s by per-read abort listeners, so 512 MiB of transfer leaves 639 MiB of live buffers. | `transport.ts` | Use a per-connection cap that is lower before consent, and remove read listeners when they settle. |
| R15 | Medium | **An interrupted send re-sends files that were already confirmed.** The abort path doesn't unstage them, even though the comment says it does. | `app.ts:1118-1135` | Unstage confirmed outcomes from `SendAbortedError`. |
| R16 | Medium | **CLI: `--real=1` and `--real=true` silently start mock mode, and `--port=`, `--alias=`, `--peer=` and `--bind=` are silently dropped.** | `cli-args.ts:49,62` | Support the `=` form, or reject it. |
| R17 | Low | **Misc:** <br>• `SECURITY.md` says the sender confirms the SAS before metadata; it doesn't. <br>• `networking.md` and `noise.ts` say the prologue "isn't passed yet"; it is. <br>• A hung send keeps the in-flight flag set. <br>• A mixed selection silently drops special files. <br>• The listing hides any file named `.syncweave-*`. <br>• A timed-out ByteSource read can swallow the next frame (latent). <br>• No overall session deadline: a trickling peer finished at 73 s. <br>• `package.json` has no `files` allowlist, so plans, tests and the skill ship. <br>• `src/main.ts` isn't executable in git. <br>• Root runs silently skip the read-only test. | various | See the per-item table below. |

---

## 3. Per-item status

Legend: ✅ fixed · 🟡 partial · ❌ not fixed · 🔻 regressed

### P0: release blockers

| ID | Status | Done | Remaining |
|---|---|---|---|
| P0-1 Identity | 🟡 | Role-bound tagged proof, Noise prologue, rejection of own ID and reflected proofs, SAS on the receiver's consent card, `void confirmation` removed. | Sender has no SAS confirm step before metadata. The discovery ID is still the expected identity (and is now broken, R1). No full Peer ID on send-review or consent. Aliases aren't marked "claimed". No duplicate-alias or changed-alias flags. Manual peers are still unpinned TOFU, and no decision is recorded. |
| P0-2 Receiver ack | 🟡 | FILE_RESULT and SESSION_RESULT exist. Success requires them. `sendFiles` returns per-file outcomes. Files are read through a single fd and fstat snapshot. EEXIST, ENOENT and hash-mismatch cases are tested. | The sender doesn't compare the acked sha256 and bytes: a lying ack succeeds. The effective wait is 15 s (R2). |
| P0-3 Timeouts | 🟡 | A silent peer after the handshake is rejected at 15.0 s. The consent deadline fires at 60 s. | Consent isn't raced against disconnect (R3). The sender's accept wait is capped at 15 s (R2). No overall session deadline. The timeout unit test still uses stubs. |
| P0-4 Backpressure | 🟡 | A stalled consumer is paused at about 32 MiB (was over 94 MiB and rising). A 256 MiB transfer takes 12.6 s (was 42 s). | No regression test. Chunk pinning and pre-consent channel memory (R14). |
| P0-5 Pre-auth DoS | 🟡 | One idle socket no longer delays a valid peer (0.01 s, was 59.7 s). | Four idle sockets still stall a valid peer for about 60 s. |
| P0-6 Size caps | 🟡 | Per-type body caps are checked on the header before allocation. FILE_CHUNK fits the 65,535-byte Noise limit. | No ~256 B handshake cap (a 65,000-byte msg1 is accepted). The transport still accepts 16 MiB messages before authentication. |
| P0-7 Re-stream | ✅ | Acceptance is by index. Duplicate, out-of-range, empty and over-budget sets are rejected before any FILE_HEADER. | Side effect: R11. |
| P0-8 Cancellation | 🟡 | Aborting mid-transfer works (1.01 s, CANCEL sent, no partial file). 10 s dial timeout. | Receive has no signal. Consent and pre-dial hashing ignore abort. `dispose()` doesn't abort send or receive. No `process.exit`. `end()` has no destroy fallback. No `x` cancel key. See R7 and R9. |
| P0-9 Double send | 🟡 | Double Enter now sends once. | Still on send-review with no visible progress, completion or cancel feedback. Enter and the button aren't disabled. |
| P0-10 Downloads | 🟡 | `~/Downloads` is created at startup with mode 0700. Consent shows the destination. | No writability check, no `link()` probe or fallback, and destinations aren't validated before accept (R10). |
| P0-11 Special files | 🟡 | FIFOs, sockets, devices and symlinks are listed as unsupported and excluded from sends. fstat rejects devices. | A FIFO swapped in after staging still hangs (open blocks before fstat). Budgets are checked after hashing (a 2.5 GiB file is hashed before rejection). Hashing isn't abortable. One bad file fails the batch. Symlink targets aren't shown. |
| P0-12 Consent screen | 🟡 | Control and bidi characters are rejected on the wire. `a` truly selects all. Enter with nothing selected is a no-op. The list scrolls at 120×36. | Overdraw at 120×24 (the window is hard-coded to 10 rows). The shown name still differs from the saved name. The "choose files" message isn't drawn. 155 Unicode `Cf` code points still pass the sanitizer (e.g. U+061C, U+2060-2064). |
| P0-13 Startup errors | ✅ | The listener and discovery start before the renderer, and errors go to stderr with a friendly message. | R5 (IPv6-only default bind). |
| P0-14 Compact borders | ✅ | Clean at 72×14. | |

### P1

| ID | Status | Remaining |
|---|---|---|
| P1-1 Real queue | ❌ | The records are written, then wiped (R6). The Receiver panel is always idle. The copy is still mock-era. |
| P1-2 Rename / Destination | 🟡 | The destination picker is real. The `r` key and the "(from peer)" preview still work in real mode. The footer says "r Rename". D is shown with a single entry. |
| P1-3 `p` / toolbar / help | 🟡 | `p` is guarded. The Peers, Favorites and Receive toolbar buttons are still dead in real mode, and the `q / v / p` help row is wrong. |
| P1-4 Diff | ❌ | `d` is guarded, but the Enter hint, the footer "d Diff" and the help row still advertise it. |
| P1-5 SYNC badge | ✅ | |
| P1-6 Retry | 🟡 | The mock text is unreachable. There is no real bounded retry, `decisions.md` still promises 3, and the footer still advertises "r Retry". |
| P1-7 Peer state | ✅ | |
| P1-8 Mock structure | 🟡 | No Mock* objects in real mode. Still missing: a fail-fast when `real` is absent. Still present: the `as unknown as` cast in `main.ts:172` and 26 uses of `MockEntry`/`MockPeer` types. |
| P1-9 Decline | 🟡 | A DECLINE frame exists, and the sender shows "declined". The receiver shows "Receive failed: …", and a consent timeout is sent as ERROR. |
| P1-10 CANCEL/ERROR | 🟡 | Reason codes exist and partials are deleted. The sender doesn't read while streaming (R12), and a CANCEL during consent is unread. |
| P1-11 Partial results | 🟡 | The error types carry outcomes. The app ignores the receiver's list, and the abort path doesn't unstage files (R15). |
| P1-12 Wire binding | ✅ | |
| P1-13 Per-session identity | 🔻 | Correct on the wire, but not reconciled with discovery (R1). |
| P1-14 Session lifecycle | ✅ | |
| P1-15 IPv6 | 🟡 | Dual-stack `::` is the default. There is no fallback (R5), and IPv6 reachability is untestable here. |
| P1-16 Bind / listening | 🟡 | `--bind` and the LISTENING indicator exist (the indicator garbles the header, R13). No receive on/off toggle. |
| P1-17 Zero-length message | ✅ | Rejected in 5–9 ms. No test. |
| P1-18 Per-frame timers | 🟡 | Still 1 `AbortSignal.timeout`, 2 `AbortSignal.any` and 1 `setTimeout` per frame. |
| P1-19 Partials / signals | 🟡 | Startup sweep added, but it covers only `~/Downloads` and deletes live partials (R4). Signals don't abort the receive (R9). |
| P1-20 Collision rename | ❌ | A 255-byte name drops `.txt`. A third copy fails. A dangling symlink fails. No retry on EEXIST. |
| P1-21 Rollback | 🟡 | The verified file is kept and the comment is fixed, but success is now reported as failure (R8). |
| P1-22 Directory fsync | ✅ | Confirmed with strace. |
| P1-23 500-entry cap | 🟡 | The footer shows the correct "first 500 of N". Entries 501+ are still unreachable, and stage-all stops at 500. |
| P1-24 Unreadable folders | ✅ | No test for the error text. |
| P1-25 Dotfiles / partials | 🟡 | `.syncweave-*` is hidden. No dotfile toggle. |
| P1-26 Local root | 🟡 | Default is `$HOME`. You can't navigate above it, there's no home jump, and `--root` is rejected as unknown. |
| P1-27 Mode / TOCTOU | 🟡 | Mode 0600 is documented. A world-writable parent is still accepted (now through the picker too). |
| P1-28 Discovery flood | ❌ | 300 forged announcements still evict a live peer. The test still encodes oldest-first eviction. |
| P1-29 Alias privacy | 🟡 | Visibility is documented. The alias is still `$USER`, and `networking.md` still claims peers are unlinkable across restarts. |
| P1-30 Discovery events | 🟡 | A bind failure shows in the TUI. `events` still isn't wired, so join and announce errors and address changes are silent. |
| P1-31 Discovery start/stop | ❌ | `stop()` during `start()` leaks the socket. Still uses `Date.now()`. No `manual:` prefix check. |
| P1-32 PeerId / alias validation | ❌ | ESC and non-base58 characters are accepted in a peerId. Bidi and zero-width characters survive in aliases. |
| P1-33 Noise split / bound | ❌ | `split()` can be called twice and reuses nonce 0. A 4th handshake message is allowed. |
| P1-34 Test-only crypto | ❌ | The BigInt ladder and dead functions are still in production `noise.ts`. |
| P1-35 Peer ID encoding | ❌ | Unchanged. The 12-character display has only 6 random characters. |
| P1-36 session-auth encodings | 🟡 | Empty identity and the non-injective join remain (unreachable from the wire). |
| P1-37 Staging after send | 🟡 | The success path is fixed. The interrupted path re-sends files (R15). |
| P1-38 `s` on Receiver | ✅ | |
| P1-39 Peer by index | ❌ | Picking B can still dial C. |
| P1-40 CLI | 🟡 | Unknown flags are rejected and `--help` works. Remaining: the `=` form (R16), `parseInt` laxness, empty `$USER`, hostnames accepted, and exit code 1 instead of 2. |
| P1-41 Promise handling | 🟡 | Catches were added. A `render()` throw still ends the receive loop, and `beginRealSend` has no catch. |
| P1-42 Peer timer | ✅ | |
| P1-43 Real-mode app tests | ❌ | None. The smoke test is still misnamed. |
| P1-44 Adversarial TCP tests | 🟡 | Pre-handshake silence, disconnect and abort are covered. Missing: post-handshake silence, flood, oversize chunk, over-budget request, duplicate accept, reflection, and parallel sessions. |
| P1-45 Ack tests | 🟡 | 4 cases. No injected write-error case. |
| P1-46 main.ts tests | 🟡 | The parser is extracted with 11 tests. No EADDRINUSE spawn test, and `main.ts` is still unloaded. |
| P1-47 Wrong-peer test | 🟡 | The sender-side case was added. The original test still uses a bare `toThrow()` with a swallowed catch. |
| P1-48 Packaging | 🟡 | LICENSE, `bin`, shebang and `engines` added. Missing: a `files` allowlist, the executable bit, and release binaries in CI. |
| P1-49 Lint / coverage gate | ❌ | |
| P1-50 CI matrix | ❌ | Ubuntu only. No two-process job. |
| P1-51 phase1/phase2 | ❌ | Still at the repo root and stale. |
| P1-52 README | ❌ | Still claims "restart-from-zero recovery" and "verified before any metadata flows". The layout section is stale. |
| P1-53 networking.md | 🟡 | The timeout claims are now true. The TOFU, realpath, 0.0.0.0 and prologue claims are still wrong. |
| P1-54 decisions.md | ❌ | No status column. The retries, 0.0.0.0 and concurrency rows are wrong. |
| P1-55 Checklist | ❌ | Unchanged and not re-run. |
| P1-56 Release docs | 🟡 | SECURITY.md was added, but its SAS-ordering claim is wrong. No privacy note, CHANGELOG, troubleshooting or release-gate checklist. |

### P2

| ID | Status | Remaining |
|---|---|---|
| P2-1 Hash progress | ❌ | |
| P2-2 Env flags / NO_COLOR | ❌ | |
| P2-3 Dead app code | ❌ | The "stale consent" branch is now reachable (R3). |
| P2-4 Render performance | ❌ | A 16 MiB transfer causes 260 renders for 258 chunks. |
| P2-5 Header overflow | ❌ | Worse in real mode (R13). |
| P2-6 Narrow rows | ❌ | Code unchanged. The symptom didn't reproduce in the sweep. |
| P2-7 72×24 hint overlap | ❌ | |
| P2-8 Card truncation | ❌ | |
| P2-9 `truncate()` width | ❌ | |
| P2-10 Receiver list > 8 | ❌ | |
| P2-11 `formatBytes` | ❌ | |
| P2-12 Progress > 100% | ❌ | Verified by reading the code. |
| P2-13 Resize cursor | ❌ | |
| P2-14 Mouse wheel | ❌ | |
| P2-15 Contrast | ❌ | |
| P2-16 ASCII fallback | ❌ | `icons.check` is now used in two places. |
| P2-17 Breakpoints | ❌ | |
| P2-18 < 20 columns | ❌ | No crash. |
| P2-19 Dead UI code | ❌ | |
| P2-20 Dead protocol surface | 🟡 | Only `TranscriptConfirmation` remains. |
| P2-21 Silent-pass tests | ❌ | |
| P2-22 Missing service tests | 🟡 | The eviction test exists, but it encodes the flood-vulnerable behaviour. No error-event, EXDEV or symlink-staging tests. |
| P2-23 TS strictness | ❌ | 11 errors with the four named flags. |
| P2-24 CI hygiene | 🟡 | SHA pins and Dependabot added. Missing: the push branch filter, `permissions`, a timeout and `concurrency`. |
| P2-25 Bun version | 🟡 | `engines` added. No `.bun-version`, `@types/bun` is still on 1.4.2, and the README states no version. |
| P2-26 Dependency policy | 🟡 | Dependabot and `bun audit` added. No OpenTUI upgrade policy. |

---

## 4. Still solid (re-checked)

These protections held on the current code:
- Path traversal containment: 20 hostile names tested.
- No overwrite, and no symlink following on publish.
- Temp-file cleanup on every failure mode, including a real ENOSPC.
- Published files are mode 0600.
- Noise test vector.

The crash sweep rendered 418 frames, across 19 sizes from 12×6 to 200×60, 11 screens and both modes, with no exceptions.

## 5. Definition of done (plan §14): 0 of 7 met

1. **All P0 closed with regression tests: not met.** 11 P0 items are partial, and the cancel test is red.
2. **No Mock* in real mode, asserted by a test: not met.** The code is clean, but no test asserts it.
3. **Two-process e2e in CI on Linux and macOS: not met.**
4. **Coverage floors, with `app.ts` real-mode paths at 80% or more: not met.** `app.ts` is at 45%.
5. **Checklist passed on two hosts: not met.**
6. **Docs match the code: not met.**
7. **LICENSE, SECURITY, threat model, privacy note and release binaries: partly met.** LICENSE and SECURITY.md exist; the rest is missing.

## 6. Recommended next steps

1. **R1:** decide the identity model and add a discovery-path app test. Without this, the main real-mode flow doesn't work.
2. **R7:** fix the abort test so CI is green.
3. **R2 and R3:** align the sender's wait with the consent window, and tear down stale consent prompts.
4. **R4, R5, R6, R8, R9:** these are small, contained fixes.
5. **R10:** scope the destination picker before release, because of the sensitive-directory write path.
6. Finish the 🟡 P0 items, then follow the plan's original sequencing (§13) for the rest.
7. Add a status column to `remediation-plan.md`, or retire `remediation-plan-m.md`, so the plan IDs stop colliding.

Limits: nothing was tested on two physical hosts, on macOS or Windows, on a
host with IPv6, or with the TUI driven over a real terminal session for
discovery. Probes and full per-slice reports are in the session's scratch
directory (`verify/v1-protocol.md` … `v6-qa.md`).
