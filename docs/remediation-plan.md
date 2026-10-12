# SyncWeave remediation plan

Audit date: 2026-10-12 · Audited commit: `a87d307` · Bun 1.4.2 / 1.4.3

This document lists everything found wrong with SyncWeave on the way to a
production-ready real mode, deduplicated and ordered into a fix plan. It was
produced from six parallel audits: app core, network/protocol,
crypto/identity/discovery, filesystem, UI, and QA/CI/docs. Together they
raised about 200 raw findings, which merge into the 96 items below. Most
High and Critical items were reproduced with loopback harnesses or headless
renderer probes, not only found by reading the code. Items that are inferred
are marked *(unverified)*.

## Contents

1. [Summary](#1-summary)
2. [What is already solid](#2-what-is-already-solid)
3. [P0: release blockers](#3-p0--release-blockers)
4. [P1: mock-mode leftovers in real mode](#4-p1--mock-mode-leftovers-in-real-mode)
5. [P1: protocol and transport correctness](#5-p1--protocol-and-transport-correctness)
6. [P1: filesystem](#6-p1--filesystem)
7. [P1: discovery and identity hygiene](#7-p1--discovery-and-identity-hygiene)
8. [P1/P2: app behaviour and CLI](#8-p1p2--app-behaviour-and-cli)
9. [P2: UI layout, accessibility, performance](#9-p2--ui-layout-accessibility-performance)
10. [Tests](#10-tests)
11. [CI, tooling, packaging](#11-ci-tooling-packaging)
12. [Documentation](#12-documentation)
13. [Suggested sequencing](#13-suggested-sequencing)
14. [Definition of done for 1.0](#14-definition-of-done-for-10)

---

## 1. Summary

**Status today:** typecheck clean, 102/102 tests pass, no flaky tests across
7 runs, and 94.8% line coverage. The Noise implementation matches the spec,
and the receive sink's path-safety rules hold up against adversarial input.

The green suite gives a misleadingly good picture. Real-mode orchestration
in `app.ts` has 57% coverage, and `main.ts` is never loaded by any test. All
of the most serious problems live in those untested paths.

**The five themes that matter most:**

1. **Identity is not actually confirmed by a human.** A discovered peer's
   "expected Peer ID" comes from an unauthenticated multicast packet. Manual
   peers get no check at all. The Gate-B transcript code is computed and then
   thrown away. Any LAN host can announce `laptop2` and receive files meant
   for it.
2. **The sender reports success without proof.** There is no receiver
   acknowledgement. "Sent N file(s)" appears even when the receiver saved
   nothing, for example because of a hash mismatch, a missing `~/Downloads`,
   or EEXIST.
3. **One peer can wedge or exhaust the receiver.** The documented 15 s/60 s
   frame timeouts never fire, consent has no timeout, the accept loop runs
   one handshake at a time with an unbounded queue, and inbound data is
   buffered without backpressure. In testing, a 256 MiB transfer peaked at
   811 MiB of memory (RSS) and took 68 s.
4. **Mock-era UI is still live in real mode.** The transfer queue and the
   Receiver status are driven by `MockTransferService`. Rename, Destination,
   Favorites, Diff and the SYNC badges are mock controls with no real effect.
   Retry says "simulated".
5. **No control over in-flight work.** A double Enter sends twice, and
   nothing can cancel a send, a receive, or a connect. Ctrl+C leaves the
   process alive while a session holds a socket.

**Item counts in this plan:** P0: 14 · P1: 56 · P2: 26 (96 total).

---

## 2. What is already solid

These were checked and need no action. Keep them covered by tests while
refactoring.

- **Noise_XX core:** key mixing, transcript hash, nonce format, AEAD tag
  checks, and rejection of low-order/all-zero DH keys. It passes the official
  test vector.
- **Identity proof:** the Ed25519 signature is bound to the handshake hash,
  so a proof cannot be relayed to another connection. Peer-ID and token
  comparisons are length-checked and timing-safe where it matters.
- **Receive sink:** path traversal (`../`, `..\`, absolute paths, NUL,
  reserved names, long names) is contained. Temp files are created
  exclusively with mode 0600. Size and SHA-256 are verified before publish.
  Publishing never overwrites an existing file and never follows a symlink.
  Temp files are cleaned up on every in-process failure, including a real
  ENOSPC.
- **Frame parser:** checks magic, version, type, length and state before
  reading any body. Unknown extension keys are rejected early.
- **Discovery parser:** 512-byte cap, strict version check, typed fields,
  reserved `manual:` namespace, control characters stripped from aliases.
- **Budgets:** 25 files / 2 GiB per file / 10 GiB per session, with
  overflow-safe arithmetic.
- **Terminal escape injection:** OpenTUI 0.6.0 strips ESC/CSI/OSC/C1 before
  output, so control sequences cannot be injected. The leftover visible text
  is still a problem; see P0-12.
- **Rendering:** no crashes from 12×6 to 200×60 on any screen in either
  mode. No Nerd Font glyphs leak in ASCII mode. The animation clock doesn't
  leak timers.
- **Mock isolation:** mock peers, the mock filesystem and the mock pulse do
  not run in real mode. The remaining leaks are UI controls and services;
  see §4.

---

## 3. P0: release blockers

Several P0 items change the wire protocol (P0-1, P0-2, P0-6, P0-7). Bundle
them into a single protocol version bump (`v: 2`) rather than shipping them
one at a time.

### P0-1 · Identity is never confirmed by a user (spoofable receiver and sender)
- **Where:** `app.ts:739-744` (`fingerprint: d.peerId`), `app.ts:857-860`
  (`expectedPeerId` comes from discovery; `undefined` for manual peers),
  `transfer-protocol.ts:100-116, 152-163, 312, 337-341, 408, 486-488`,
  `render.ts:324, 351, 437`.
- **Problem:**
  - Discovered peers are "verified" against an ID taken from an
    unauthenticated UDP announcement.
  - Manual peers accept whatever key answers.
  - The transcript confirmation is computed and then discarded with
    `void confirmation`.
  - The local confirmation is recorded automatically, with no user step.
  - A listener that echoes the sender's own proof back is accepted.
    Reproduced: the sender treated its own Peer ID as the receiver's and
    streamed the file.
  - The signature covers the raw handshake hash, with no role, version or
    prologue binding.
  - The consent screen shows only the attacker-chosen alias. The comment at
    `app.ts:810` claims the verified ID is shown; it isn't.
- **Reproduced:** a forged `laptop2` announcement received `secret.txt`.
- **Fix:**
  1. Show a short transcript-derived code (SAS) on both sides. Require an
     explicit confirm on each side before any `TRANSFER_REQUEST` metadata is
     sent.
  2. Sign a tagged message: `"syncweave-id-proof-v2" ‖ role ‖ version ‖ H`.
     Add a Noise prologue. Reject a proof whose Peer ID equals our own.
  3. Never label a discovery-sourced ID as "verified". Show the full Peer ID,
     grouped, on send-review and consent. Mark the alias as *claimed*. Flag
     duplicate aliases, and flag a known alias that changes ID or address.
  4. Manual peers: accept `--peer host:port#<peerId>`, or require the SAS
     step. If TOFU stays, implement real pinning and record the decision in
     `docs/decisions.md`.
- **Sources:** SEC-1, SEC-2, SEC-5, SEC-6, SEC-12, NET-6, NET-7, NET-11,
  APP-1, APP-18, UI-4, QA-2, QA-7, QA-25, QA-43.

### P0-2 · The sender reports success without a receiver acknowledgement
- **Where:** `transfer-protocol.ts:407` (`waitForPeerClose(10_000)` resolves
  on close, end or timeout), `transport.ts:248-267`, `app.ts:868-870`.
- **Problem:** The only completion signal is the receiver closing its
  socket, and the receiver closes on every path, failure included.
- **Reproduced:** sender showed "Sent" in all three of these cases:
  - receiver failed with EEXIST
  - receiver failed with ENOENT
  - receiver rejected a SHA-256 mismatch after the source file changed
    mid-send
- **Also:** "Accept all" counts are wrong, because the sender reports
  `fileList.length`, not the accepted subset.
- **Fix:**
  - Add a per-file `FILE_RESULT{ok, finalName, bytes, sha256 | errorCode}`
    frame and a final session result.
  - The sender succeeds only after a matching result arrives. A close before
    the result, or a timeout, is a failure.
  - `sendFiles` returns the per-file outcomes, and the UI reports those.
  - Read each file through a single fd and `fstat` snapshot, so hashing and
    streaming see the same bytes.
- **Sources:** FS-1, FS-11, NET-5, QA-1, APP-9 (count part).

### P0-3 · Post-handshake timeouts never fire; consent waits forever
- **Where:** `transport.ts:196-203` (`asByteSource().read(n)` drops the
  `signal` that `FrameParser` passes at `frame-parser.ts:241-247, 412`),
  `transfer-protocol.ts:357, 485`, `app.ts:771-827`.
- **Problem:**
  - A peer that completes the handshake and then goes silent holds the
    receiver's serial receive loop indefinitely. Reproduced: still pending
    at 70 s; the expected limit was 15 s.
  - A consent prompt outlives its sender: accepting later fails with
    "channel closed".
  - The sender waits for `TRANSFER_ACCEPT` with no limit.
  - `docs/networking.md:53` and `decisions.md §3` claim these are bounded.
  - The frame-parser timeout test passes only because its stub honours the
    signal.
- **Fix:**
  - Forward the signal from `ByteSource.read` into `readExact`.
  - Add a consent deadline (default 60 s, configurable) that declines.
  - Race the consent wait against channel close, and dismiss the prompt
    with "sender disconnected".
  - Add idle and overall-session deadlines.
  - Make the timeout test run against a real socket pair, so it fails on
    today's code.
- **Sources:** NET-1, NET-9, APP-2, SEC-21, QA-3, QA-6, QA-28, FS X-3.

### P0-4 · No read backpressure; unbounded, quadratic inbound buffering
- **Where:** `transport.ts:40-57` (permanent `data` listener, never
  `pause()`; every chunk copies the entire backlog), `transport.ts:~210`.
- **Measured:**
  - 96 MiB sent during consent stayed resident in memory.
  - A 210 MB flood took RSS to about 1.3 GB.
  - A 256 MiB legitimate transfer took 67.6 s with an 811 MiB RSS peak,
    against 0.8 s for 16 MiB.
- **Fix:**
  - Store incoming data as a chunk list and copy each frame once.
  - `pause()` above a high-water mark (about 2× the max frame size) and
    `resume()` when the reader needs more.
  - Set a hard cap on buffered bytes, and destroy the socket when it is
    exceeded.
  - Add a regression test that feeds 64 MiB to a stalled consumer and
    asserts the buffer stays bounded.
- **Sources:** NET-2, QA-5, SEC-8 (copy part).

### P0-5 · Pre-auth DoS: serial handshakes and an unbounded pending queue
- **Where:** `transport.ts:371-405`, `transport.ts:281` (the 60 s budget
  starts at dequeue, not at accept).
- **Problem:**
  - One idle TCP connection delays a legitimate peer by 60 s (reproduced);
    N idle connections delay it by N × 60 s.
  - Queued sockets have no timer, no cap, and no `error` listener.
- **Fix:**
  - Run handshakes concurrently, capped at about 4–8.
  - Start the deadline at accept.
  - Cap `pending`, add a per-IP limit, and close excess connections
    immediately.
  - Attach `error` and `close` handlers at accept.
  - Track in-flight sockets so `close()` can destroy them.
- **Sources:** NET-3, NET-24, SEC-7, QA-4.

### P0-6 · Size limits far too large before authentication
- **Where:** `transport.ts:27` (16 MiB + 1 KiB per Noise message, including
  handshake messages), `transfer-protocol.ts:54` (`APP_MAX_BODY` 16 MiB for
  every frame type), `frame-parser.ts:408` (allocates the declared length
  up front), `noise.ts:226-260, 406-420` (no 65535 limit, no input length
  checks).
- **Problem:**
  - Before identity is checked, a peer can make the receiver allocate and
    `JSON.parse` 16 MiB. Measured: 703 ms and 209 MiB heap per frame.
  - `decisions.md` specifies a 64 KiB body cap.
  - FILE_CHUNK ciphertext is 65,597 bytes, over the Noise limit of 65,535.
- **Fix:**
  - Handshake messages: about 256 B.
  - SESSION_OPEN / IDENTITY_CONFIRM: 4 KiB or less.
  - TRANSFER_REQUEST / ACCEPT: about 64 KiB or less.
  - FILE_CHUNK: sized so the ciphertext is at most 65,535 bytes.
  - Allocate buffers incrementally. Enforce the limits and exact handshake
    lengths in `noise.ts`.
- **Sources:** NET-13, NET-26, SEC-8, SEC-9, QA-20.

### P0-7 · A malicious receiver can make the sender re-stream files
- **Where:** `session-auth.ts:236-245` (membership check only),
  `transfer-protocol.ts:361-403`.
- **Reproduced:** a one-file request was accepted 5 times, and the sender
  streamed it 5 times.
- **Fix:** Accept entries by request index. Require them to be unique, a
  subset of the request, and within budget. Reject anything else before
  streaming starts.
- **Sources:** NET-8.

### P0-8 · Nothing can be cancelled; Ctrl+C leaves the process alive
- **Where:**
  - `app.ts:807, 854`: `receiveFiles` and `sendFiles` get no `AbortSignal`.
  - `transfer-protocol.ts:370-403`: the chunk loop never checks `signal`.
  - `transport.ts:333-345`: no connect timeout, and an abort before connect
    is ignored.
  - `transport.ts:389-415`: abort leaves the server bound, a pre-aborted
    `accept()` hangs, and `close()` waits on live connections.
  - `app.ts:901-918`: `dispose()` only aborts the accept loop.
- **Reproduced:**
  - Aborting at 1 s into a 64 MiB send still delivered the whole file and
    reported success.
  - A dial to a blackholed address ignored its abort for over 28 s.
  - After `dispose()`, a silent peer kept the process alive.
- **Fix:**
  - Use one `AbortController` per session, aborted from `dispose()` and from
    a cancel key (Esc or `x`).
  - Check the signal in the chunk loop and send a `CANCEL` frame (see P1-10).
  - Add a 10 s connect timeout.
  - On abort, close the server and destroy pending and in-flight sockets.
  - `close()` and `abort()` must wake pending readers. Add an
    `end()` → destroy fallback timer.
  - Call `process.exit` explicitly after teardown.
- **Sources:** NET-4, NET-10, NET-18, NET-27, NET-28, APP-3, QA-26, QA-41.

### P0-9 · A double Enter sends twice; send progress is invisible
- **Where:** `app.ts:688, 835-875` (no in-flight guard, no `setScreen`),
  `render.ts:68, 303-306` (the status line renders only on the workspace),
  `render.ts:335`.
- **Reproduced:** two Enter presses gave two receiver prompts and two files
  (`a.txt`, `a (1).txt`). The sender stays on send-review with no progress
  shown, which contradicts `real-mode-checklist.md:42-44`.
- **Fix:** Add a `sending` state. Move to the workspace or a dedicated
  progress screen. Disable Enter and the button while a send is in flight.
- **Sources:** APP-6, UI-2, QA-8, FS X-2.

### P0-10 · `~/Downloads` is never created; destination failures happen after consent
- **Where:** `main.ts:106`; there is no `mkdir` anywhere in `src/`;
  `safe-receive-sink.ts:245`; `transfer-protocol.ts:485-497` sends
  `TRANSFER_ACCEPT` before checking the destination; `safe-receive-sink.ts:308`
  publishes with `link()`.
- **Problem:**
  - On a fresh account, Termux, or a headless box, every accepted transfer
    fails with a raw ENOENT, after the sender has been told "accepted".
  - On filesystems without hard links (exFAT, many Android/SMB/FUSE mounts),
    every receive fails *(unverified on real mounts)*.
- **Fix:**
  - Create the directory at startup (`mkdir -p`, mode 0700) and check that
    it is writable.
  - Probe `link()` support once.
  - Fail before consent with a clear message.
  - Add an `O_EXCL` final-create fallback for filesystems without hard links,
    or list the unsupported filesystems.
  - Show the resolved destination on the consent screen.
- **Sources:** APP-5, FS-4, FS-12, NET-23, QA-12, QA-27.

### P0-11 · Special files hang or break a send
- **Where:** `real-filesystem.ts:55-65` lists everything that isn't a
  directory or symlink as a 0-byte "file". `transfer-protocol.ts:297-303`
  hashes every file before dialing and before the budget check.
- **Reproduced:**
  - A staged FIFO hangs on open.
  - A symlink to `/dev/zero` hashes forever (448 MB in 2 s).
  - A symlink to a directory fails the whole batch with EISDIR.
  - A symlink to a file shows "0 B" but sends the target's bytes.
- **Fix:**
  - In `list()`, classify with `stat` and mark non-regular files
    unsupported.
  - In `sendFiles`, open the file, `fstat` it, and reject anything that is
    not a regular file.
  - Apply budgets *before* hashing, and make hashing abortable.
  - Skip and report bad files individually instead of failing the batch.
  - Show symlink targets on the review screen.
- **Sources:** FS-2, FS-3, NET-14, QA-23.

### P0-12 · The consent screen misrepresents what is being accepted
- **Where:** `render.ts:355-357, 384-386` (no scroll, raw names),
  `transfer-protocol.ts:186-203` (names checked only for length),
  `app.ts:482-495, 657` (accept paths), `safe-receive-sink.ts:109`
  (sanitizer misses bidi and zero-width characters).
- **Problems (all reproduced):**
  - The list doesn't scroll. At 120×24, 14 of 25 files are visible, yet
    "Accept all" accepts all 25, and the screen says "Review every item".
  - `"line1\nline2.txt"` displays as `line1`, and `\r` hides the rest of a
    name. U+202E (right-to-left override) passes through both the display
    and the disk sanitizer, so `invoice‮fdp.exe` is saved with the override
    intact.
  - The displayed name is not the saved name: `.env` is saved as `env`, and
    `a\b.txt` as `b.txt`. Collision suffixes aren't shown.
  - `a` ("Accept all") actually means "accept what is checked" and drops
    deselected files.
  - Enter with nothing selected silently declines, while the mock path
    refuses.
- **Fix:**
  - Scroll the consent list with the same logic as the panes, with
    "↓ N more (M accepted)".
  - Make `a` truly select all.
  - Make Enter with nothing selected a no-op that shows a message.
  - Run the disk sanitizer plus collision resolution *before* consent and
    show the final name.
  - Strip the Unicode `Cf` category (bidi and zero-width characters, plus
    U+2028/2029) in both sanitizers.
  - Reject control characters in `validateProtocolFiles`.
- **Sources:** UI-3, UI-5, UI-7, FS-6, FS-7, APP-7, APP-9, NET-16.

### P0-13 · Startup errors are swallowed by OpenTUI's console capture
- **Where:** `main.ts:59` creates the renderer before listen/discovery at
  `main.ts:76-95`. OpenTUI's `consoleMode` sends `console.error` to a hidden
  buffer.
- **Reproduced:** "Port … already in use" prints nothing and the process
  exits 1. Commit `e04f5a0`'s friendly message is never seen. A discovery
  failure is likewise silent.
- **Fix:** Bind the listener and start discovery *before*
  `createCliRenderer()`, and write errors with `process.stderr.write`. Or
  create the renderer with `consoleMode: "disabled"`. Errors that happen at
  runtime go to the status line.
- **Sources:** APP-4, QA-17, SEC-17a.

### P0-14 · Compact layout (14 rows or fewer) garbles the header and status bars
- **Where:** `render.ts:78-79, 298-299`. OpenTUI 0.6.0 forces a border
  whenever `borderColor` is set, even with `border:false`.
- **Fix:** Pass `borderColor` only when a border is wanted.
- **Sources:** UI-6.

---

## 4. P1: mock-mode leftovers in real mode

This is the class of bug that keeps resurfacing. The structural fix is
P1-8. Do it early so the others can't come back.

| ID | Problem | Where | Fix | Sources |
|---|---|---|---|---|
| P1-1 | Receiver panel always says "no active session / idle"; transfer queue (`t`) always empty; empty-state copy says incoming transfers "appear here". | `app.ts:78`, `render.ts:254-261, 537-540`, `main.ts:119` | Replace `MockTransferService` in real mode with a real transfer-status model (direction, peer, files, final names, progress, outcome) fed by send/receive. Until that exists, hide these lines and `t`. | UI-1, APP-11, FS-14, NET-33 |
| P1-2 | Consent **Rename** toggles a "(from peer)" preview that has no effect. **Destination [D] change** cycles a one-entry list. | `render.ts:353, 361-362, 384, 628-632`; `app.ts:484-486, 552-557` | Hide both in real mode, or implement a real rename (sanitized and sent to the sink) and a destination picker. | FS-13, APP-16, UI-8, UI-30, QA-13 |
| P1-3 | `p` opens the mock Favorites screen, bypassing the real-mode guard on `command("favorites")`. The empty state says "Open Peers…", which real mode blocks. Toolbar shows Peers/Favorites/Queue/Receive buttons that only set status text. Help row `q / v / p` is wrong: `v` does nothing. | `app.ts:633`, `render.ts:121-126, 462, 515` | Guard `p` like `q`. Hide the dead toolbar buttons in real mode. Fix the help row. | APP-14, UI-9, FS-22 |
| P1-4 | `d` Diff is advertised, and "press d to inspect its diff" appears on Enter, but every real file is `synced`, so it always says "No divergence". | `app.ts:356, 380-389`, `render.ts:575`, `real-filesystem.ts:67, 82-85` | Remove the hint, the footer key and the screen in real mode. | APP-15, UI-9, FS-24 |
| P1-5 | Every real file shows a **SYNC** badge and the added/modified/deleted legend. | `real-filesystem.ts:67`, `render.ts:203, 215-218, 310-313` | Drop the state column and the legend in real mode. | UI-10 |
| P1-6 | Retry shows "Retry simulated". `decisions.md` promises 3 bounded, visible retries; none exist. | `app.ts:440-452, 587-591` | Implement session-level retry (fresh identity, fresh consent, restart from zero, at most 3 attempts, attempt number shown), or amend the decision. | APP-20, NET-21, QA-37 |
| P1-7 | Real peers are all `online: true`, including manual peers that were never probed. | `app.ts:744` | Mark manual peers "not probed". Drop the online flag for discovered peers, or derive it from `lastSeen`. | UI-17 |
| P1-8 | **Structural:** real mode still builds `MockFileSystemService` (discarded), `MockPeerService` (live favorites) and `MockTransferService` (live queue). Mock fallbacks run if `real` is missing or the consent resolver is unset. `Mock*` types are used for real data. `main.ts:120` uses an `as unknown as` cast. The initial status says "all … simulated". `ports.ts` interfaces are mock-era. | `main.ts:63, 116-123`; `app.ts:60-61, 95, 512-516, 660-663, 669-670`; `domain.ts:11-27`; `state/app-state.ts:11`; `ports.ts` | Throw if `mode === "real"` without `real`. Make the mock fallbacks no-ops in real mode. Rename types to `Peer`/`FileEntry`. Give real mode its own null or in-memory services. Remove the cast. Move mock copy into the mock module. | APP-23, APP-29, FS-23, FS-25, NET-33, QA-51 |

---

## 5. P1: protocol and transport correctness

| ID | Problem | Where | Fix | Sources |
|---|---|---|---|---|
| P1-9 | A decline is implemented as an exception. The receiver shows "Receive failed: Acceptance requires at least one file"; the sender shows "peer closed the session". | `app.ts:497-506, 820-823`, `session-auth.ts:236-238`, `transfer-protocol.ts:489-490` | Add an explicit DECLINE (or ACCEPT with an empty set and a reason). Show "Declined" on both sides. | APP-10, NET-9, QA-40 |
| P1-10 | `CANCEL`/`ERROR` frames are defined but never sent or handled. A mid-file CANCEL becomes "unexpected frame 0x30". | `frame-parser.ts:48-49, 133-147`, `transfer-protocol.ts:531` | Define reason codes. Send on local abort or error. Handle in every reading state, deleting partial files and reporting "cancelled by peer". | NET-20 |
| P1-11 | A multi-file failure discards the list of files already completed. | `transfer-protocol.ts:439, 552-557` | Emit per-file completion through a callback, or throw an error carrying the completed list. Show completed and failed files separately. | NET-15 |
| P1-12 | The session ID, request ID and file index are not checked on the wire. Each side makes its own session ID. | `transfer-protocol.ts:311-312, 346-360, 441, 491, 533-536` | Agree the session ID from the transcript. Validate SessionId on every frame, RequestId on ACCEPT, FileIndex on FILE_HEADER. Add a receiver-issued transfer token. | NET-12, QA-21 |
| P1-13 | One Peer ID per process, reused for every session. Spec says per-session ephemeral. | `main.ts:72`, `app.ts:813, 861` | Generate a fresh identity per session. Keep the discovery identifier separate, or amend `decisions.md`. | NET-19, QA-37 |
| P1-14 | Session state is never destroyed. `validateAuthorization` is a test-only second path that consumes tokens. No TTL sweep. Gate B/C state is asserted by the caller rather than enforced. | `session-auth.ts:22-23, 213-219, 285-298` | Call `destroySession` in `finally` of send and receive. Remove `validateAuthorization` from the public API. Make the gates a typed state machine fed only by the proof path and user actions. | NET-30, SEC-19 |
| P1-15 | The IPv6 `--peer [::1]:…` form is documented, but the listener binds `0.0.0.0` only. | `main.ts:76`, `README.md:45` | Bind `::` (dual-stack) or document IPv4-only. Test where available. | NET-17, QA-18 |
| P1-16 | The listener binds every interface at launch. There is no listening indicator and no start/stop. | `main.ts:76`, `render.ts` | Add `--bind <addr>`, a header state such as `LISTENING :24816`, and a receive on/off toggle. | NET-22, QA-24 |
| P1-17 | A zero-length transport message is treated as end-of-stream. | `transport.ts:126-127, 185-187, 214-216` | Reject length 0 as a protocol error. | NET-25 |
| P1-18 | One `AbortSignal.timeout` and one `AbortSignal.any` are allocated per frame (2 timers per 64 KiB chunk). | `frame-parser.ts:241-244, 412-413` | Use one deadline per stage, reset per frame. | NET-32 |

---

## 6. P1: filesystem

| ID | Problem | Where | Fix | Sources |
|---|---|---|---|---|
| P1-19 | A killed receive leaves `.syncweave-*.partial` in `~/Downloads`. No SIGINT/SIGTERM handler and no startup sweep. `decisions.md` promises removal. | `safe-receive-sink.ts:59-60, 195-206`; no handler anywhere in `src` | Add signal handlers that abort the active session and await cleanup. Sweep stale partial files at startup. Consider a `.syncweave-staging/` subdirectory. | FS-10, QA-22 |
| P1-20 | Collision rename breaks near 255 bytes: the extension is dropped and a third copy fails EEXIST. `access()` treats any error as "free". A dangling symlink makes the receive fail instead of renaming. The check and the `link()` are separate steps with no retry. | `transfer-protocol.ts:239-256`, `safe-receive-sink.ts:118, 308` | Byte-budget the stem, never the suffix. Use `lstat` and treat only ENOENT as free. On EEXIST from `link()`, retry with the next index. | FS-5, FS-15, NET-29, QA-42 |
| P1-21 | If temp-file unlink fails after publish, the rollback deletes the *verified* final file and keeps its bytes under the hidden name. The comment says the opposite. | `safe-receive-sink.ts:308-321` | Keep the published file and report success with a warning. Fix the comment. | FS-16 |
| P1-22 | No directory fsync after publish, so a crash can lose a file that was reported as received *(unverified)*. | `safe-receive-sink.ts:301-321` | fsync the directory after link and unlink. | FS-17 |
| P1-23 | Listing is silently capped at 500 entries. "Stage all" says 500, and the footer count is wrong. | `real-filesystem.ts:9, 48-49` | Page or virtualize the list. Show "first 500 of N". Fix the test so it checks that the tail is reachable. | APP-22, FS-8, UI-16 |
| P1-24 | Unreadable or vanished folders show "This folder is empty". | `real-filesystem.ts:42-46, 59-60` | Return an error state and render the reason. | FS-19, UI-29 |
| P1-25 | Dotfiles and SyncWeave's own `.partial` temp files are listed and stageable. | `real-filesystem.ts:43-66` | Hide `.syncweave-*`. Add a dotfile toggle. | FS-21 |
| P1-26 | The local pane is rooted at `process.cwd()` and Backspace can't go above it. At `/`, Backspace says "Moved to parent" and does nothing. | `real-filesystem.ts:34-35`, `app.ts:367-378` | Default to `$HOME` (or the last folder used), allow navigating up to `/`, add a "home" jump and a `--root` flag, and check `parentPath(p) === p`. | APP-17, FS-26, UI-29 |
| P1-27 | Received files are always mode 0600, which is undocumented. Paths are checked once with realpath and then used by name (an accepted TOCTOU risk). | `safe-receive-sink.ts:9-10, 200, 245-249` | Document both, or make the mode configurable. Refuse a destination whose parent is world-writable. | FS-18, FS-20 |

---

## 7. P1: discovery and identity hygiene

| ID | Problem | Where | Fix | Sources |
|---|---|---|---|---|
| P1-28 | A flood of spoofed announcements evicts real peers from the 256-entry table. Reproduced: 300 forged announcements pushed out a live peer. | `discovery.ts:312-332` | Cap entries per source address. Rate-limit new IDs per source. Never evict a recently seen or verified entry. | SEC-3, QA-15 |
| P1-29 | The alias defaults to `$USER` and is broadcast every 5 s before any confirmation. It is the same on every run, so it breaks Gate A and the unlinkability promise. | `main.ts:15-16`, `discovery.ts:74, 235, 360-381` | Default to a random per-run label, or omit the alias until identity is verified. Document that the alias is visible on the LAN. | SEC-4, QA-19 |
| P1-30 | Discovery `onError`/`onPeersChanged` are never wired, so a multicast join failure is silent and address changes aren't surfaced. | `main.ts:92`, `discovery.ts:196, 205, 222-231, 333-341, 368-380` | Pass `events`. Show "discovery off — use --peer" in the status line. Alert when a known ID changes address. | SEC-17a, QA-16, UI-17 |
| P1-31 | Calling `stop()` while `start()` is still pending is lost, so timers and the socket keep running. Expiry uses `Date.now()`. `addManualPeer` doesn't enforce the `manual:` prefix. | `discovery.ts:198-233, 274-290, 331, 345` | Set a state flag before awaiting and re-check it afterwards. Use `performance.now()`. Validate the prefix. | SEC-17b-d |
| P1-32 | `peerId` from an announcement isn't charset- or length-checked (ESC accepted). The alias sanitizer misses bidi characters. The dial target is the attacker-chosen source IP and port. | `discovery.ts:110-125, 296-332` | Enforce the Peer ID format (`z` + base58, bounded length). Strip `Cf` characters from aliases. | SEC-15, SEC-16 |
| P1-33 | Noise hygiene: `split()` can be called twice and returns identical nonce-0 cipher states. Handshake turns aren't bounded at 3 messages. | `noise.ts:364, 399, 443-449` | Make `split()` single-use. Throw when `messageIndex >= 3`. | SEC-10, SEC-11 |
| P1-34 | Test-only, non-constant-time BigInt X25519 ladder ships in production code, with dead `mixKeyAndHash` and `hasKey`. | `noise.ts:84-159, 222-224, 289-294` | Move the ladder to test helpers. Derive public keys via `KeyObject`. Delete the dead code. | SEC-13 |
| P1-35 | The Peer ID encoding (`z` + base58(protobuf)) matches neither its doc comment ("12D3KooW…") nor libp2p. Only 6 of the first 12 characters are random, so the 12-character fallback display is weak. | `peer-id.ts:53-58`, `app.ts:785-790` | Emit the libp2p identity-multihash form, or fix the doc and record the decision. Never display fewer than 16 random characters. | SEC-14, APP-18 |
| P1-36 | `session-auth` accepts an empty identity as confirmed. Canonical encodings join peer-controlled strings with `\0`/`\n`, which is not injective. | `session-auth.ts:97-103, 167-177, 239-244, 259-266` | Require a fixed identity length. Use length-prefixed encodings. | SEC-18, SEC-20 |

---

## 8. P1/P2: app behaviour and CLI

| ID | Pri | Problem | Where | Fix | Sources |
|---|---|---|---|---|---|
| P1-37 | P1 | A send clears *every* staged item in the pane, including items in other folders that were never sent. It also clears the pane active at completion, not at start, so sent files can stay staged and be re-sent. | `app.ts:81, 836, 870` | Capture the pane at start and remove only the IDs that were sent and confirmed. Decide whether staging is per folder or global, and show items that were excluded. | APP-12, APP-13, QA-14, FS X-1 |
| P1-38 | P1 | Pressing `s` on the Receiver pane says "Nothing staged" while the activity bar shows "1 staged". | `app.ts:161-163, 835-836`, `render.ts:291-306` | Always send from the Local staged set. | APP-37, UI-11 |
| P1-39 | P1 | The target peer is tracked by array index. If the peer list changes but keeps the same length, the send is silently retargeted. Re-render happens only when the count changes. | `app.ts:79, 313, 755, 762-764` | Store the selected peer ID. Re-render on any change. | APP-19 |
| P1-40 | P1 | The CLI ignores unknown flags and has no `--help`, so `--reall` silently starts *mock* mode. `--alias --real` sets the alias to `"--real"`. `--port` with no value falls back to the default. `parseInt("24816abc")` is accepted. A trailing `--peer` is ignored. An empty `$USER` breaks discovery. `--peer` accepts hostnames that can never connect. | `main.ts:12-57` | Strict parser in an exported pure function. Unknown flag → usage message, exit 2. Reject values starting with `--`. Ports must match `/^\d+$/`. Validate hosts with `isIP` and warn. | APP-21, APP-24, APP-25, QA-30 |
| P1-41 | P1 | Unhandled promise chains: `void receiveLoop()` has no catch, so one `render()` throw ends listening silently. `void listener.close()` also has none. OpenTUI hides unhandled rejections. | `app.ts:827`, `main.ts:126` | Add `.catch` that surfaces the error to the status line. Make the loop survive a failure in one iteration. | APP-26 |
| P1-42 | P1 | The peer-sync interval isn't cleared in `dispose()`, which keeps the process alive up to 2 s. `void peerTimer` is dead. | `app.ts:757-765, 828` | Store the handle, call `clearInterval` in `dispose()`, delete the dead line. | APP-27, UI-28 |
| P2-1 | P2 | Every file is hashed before dialing while the UI says "Connecting…". | `transfer-protocol.ts:297-302`, `app.ts:849` | Show "Hashing n/m". | APP-36 |
| P2-2 | P2 | Environment flags accept only `"1"`. `NO_COLOR` is ignored. | `app-state.ts:3`, `theme.ts:67`, `main.ts:13` | Accept 1/true/yes/on. Honour `NO_COLOR`. Document the variables. | APP-31 |
| P2-3 | P2 | Dead or misleading code: the unreachable stale-consent branch, the identity map `pendingSha256`, the `workspace` command not resolving a parked consent, unused imports. | `app.ts:2, 10, 69, 509, 775-782` | Delete or fix. | APP-28 |

---

## 9. P2: UI layout, accessibility, performance

| ID | Problem | Where | Fix | Sources |
|---|---|---|---|---|
| P2-4 | A full tree rebuild and two `readdirSync`+`lstat` passes per render. A render on every 64 KiB chunk (32k renders for 2 GiB). An 850 ms idle tick re-lists directories. 100k entries cost about 85–100 ms per list call. | `render.ts:36-39, 167, 292`; `app.ts:259-267, 815-818, 862-866`; `real-filesystem.ts:43-55` | Throttle progress to about 10 Hz and update text in place. Cache listings per (path, mtime) and refresh asynchronously. List once per render. Stop the idle tick when nothing animates. | APP-8, APP-35, UI-19, FS-9 |
| P2-5 | The header overflows and garbles at 90–98 columns. | `render.ts:84-99` | Budget header segments by width, and drop the tagline and peer below about 106 columns. | UI-13 |
| P2-6 | In narrow layout, rows overflow by up to about 5 columns, and the icon spacing is clipped. | `render.ts:151, 206, 218` | Compute row budgets from the real inner width. | UI-14 |
| P2-7 | At 72×24 in real mode, the scroll hint overlaps the last row because the two-line target note isn't counted. | `render.ts:153-169` | Derive visible rows from the measured remaining height. Shorten the note. | UI-15 |
| P2-8 | Long aliases, hosts and paths aren't truncated on the send and consent cards, so the port gets cut and the next row is overwritten. | `render.ts:324, 329, 351, 353, 472, 596-611` | Truncate to the card's inner width. | UI-20 |
| P2-9 | `truncate()` counts UTF-16 code units: CJK and emoji overflow, and surrogate pairs get split. | `primitives.ts:59-64` | Measure with `Bun.stringWidth` and cut at grapheme boundaries. | UI-18 |
| P2-10 | The Receiver list shows only 8 peers. A selection beyond index 7 is invisible. | `render.ts:270-281` | Window the list around `peerIndex`. | UI-21 |
| P2-11 | `formatBytes`: 1048575 → "1024 KB", no TB unit, NaN → "NaN B". | `domain.ts:97-102` | Choose the unit after rounding, add TB, guard non-finite values. | APP-30, UI-22 |
| P2-12 | Receive progress can briefly exceed 100% *(unverified)*. | `transfer-protocol.ts:537-538` | Check before reporting, and clamp. | UI-23 |
| P2-13 | After a resize, the cursor can be outside the visible window. | `app.ts:890`, `render.ts:171` | Call `keepCursorVisible` on resize. | APP-34, UI-24 |
| P2-14 | The mouse wheel moves the cursor, not the viewport. | `app.ts:106-113, 151-159` | Scroll the offset about 3 rows per tick and keep the cursor in view. | UI-12 |
| P2-15 | Contrast below WCAG AA: `dim` #64748B (3.45–3.89:1), `remote` #A855F7 (4.15:1), `disabled` (3.11:1). | `theme.ts:8, 13, 22, 31` | Use e.g. `#8A97AD` and `#B98BFF`, and re-check the ratios. | APP-32, UI-25 |
| P2-16 | The ASCII fallback is partial: ◆, the spinner and discovery frames, the braille gauge, arrows, ▸ ● ‹ and a hard-coded ✓ remain. | `theme.ts:45-65`, `primitives.ts:90-91`, `render.ts:84, 329` | Extend `createIcons` to cover these and use `icons.check`. | UI-26 |
| P2-17 | Layout breakpoints (14 and 18 rows) are hard-coded in three places. | `theme.ts:36`, `app-state.ts:29-30`, `render.ts:169` | Use one helper for all three. | APP-33 |
| P2-18 | Terminals narrower than 20 columns may overflow *(unverified)*. | `render.ts:33, 544` | Clamp to the real width and show a "terminal too small" message. | UI-31 |
| P2-19 | Dead UI code: unused theme tokens, the `bg` option, `peerService` and `selectConsentFile` in render, a duplicated `renamePreview`, `transferSummary`, `MockEntry.summary`, the `favorite-open:` branch, element IDs `mock-discovery`/`phase-label`. | `theme.ts`, `primitives.ts:25, 35`, `render.ts:13, 23, 94, 98, 628`, `mock-transfer-service.ts:105-111`, `app.ts:592-598` | Delete or rename. | UI-27 |
| P2-20 | Dead protocol surface: `void header`, the unused `abort()`, the `FileIndex` and `TranscriptConfirmation` keys. | `transfer-protocol.ts:167-168`, `transport.ts:236-241`, `frame-parser.ts:153-154, 381` | Delete, or implement via P0-1 and P1-12. | NET-31 |

---

## 10. Tests

Coverage is high on the services and low exactly where the bugs are. Only
17 of the 102 tests exercise mock code alone, but the single real-mode app
test asserts nothing beyond "mounted".

| ID | Problem | Fix | Sources |
|---|---|---|---|
| P1-43 | No real-mode app tests. `setupRealMode` and `beginRealSend` are uncovered. `real-mode-smoke` is named "starts the receive loop" but asserts only the screen. | Add a keypress-driven two-instance loopback suite: send, accept, decline, double Enter, rename, staging across folders, cancel. | QA-9, QA-45 |
| P1-44 | No adversarial tests over real TCP. Parser adversarial cases use in-memory stubs. | Add a TCP suite where each case asserts bounded time, bounded memory and no destination write: silent peer pre- and post-handshake, connection flood, killed sender, oversized chunk, over-budget request, duplicate accept set, reflected proof, parallel sessions. | QA-10, QA-46 |
| P1-45 | A receiver-failure ACK test is missing (P0-2). | For missing, read-only, write-error and hash-mismatch destinations, assert that the sender rejects. | QA-1 |
| P1-46 | `main.ts` is untested. | Unit-test the extracted argument parser. Add a spawn test for EADDRINUSE that asserts the stderr text. | QA-30 |
| P1-47 | The wrong-peer test only checks `rejects.toThrow()` and the receiver swallows all errors. The sender-side mismatch (the spoof case) is untested. | Assert the error message and that `onTransferRequest` was never called. Add the sender-side case. | QA-29 |
| P2-21 | The live multicast test silently passes when multicast is unavailable. The "unpredictable" and "role swap" test names overstate what is tested. | Use `test.skipIf`, and fail in CI when multicast is expected. Rename the tests or add real coverage. | QA-44, QA-45 |
| P2-22 | No discovery eviction, flood or error-event tests. No sink link-failure (EXDEV/ENOTSUP) tests. No symlink-staging test. | Add them alongside the fixes in P1-28, P1-30, P0-10 and P0-11. | QA-15, QA-16, QA-23, QA-27 |

---

## 11. CI, tooling, packaging

| ID | Problem | Fix | Sources |
|---|---|---|---|
| P1-48 | Not installable: `private`, no `bin`, no shebang, no `files`, `engines`, `description`, `repository` or `license`. No LICENSE file and no compiled binaries. | Add a LICENSE. Add `bin` with a shebang, `engines.bun` and the metadata fields. Build release binaries with `bun build --compile` per OS and architecture in CI. Document install. | QA-31, QA-39 |
| P1-49 | No linter, formatter or coverage gate. | Add Biome (or ESLint and Prettier) with `lint` and `format:check` in CI. Add `bun test --coverage` with floors, including per-file floors for `app.ts`, `transport.ts` and `transfer-protocol.ts`. | QA-32 |
| P1-50 | CI runs on Ubuntu only, with no two-process loopback job. | Add a macOS job and a loopback e2e job. Decide on and document the supported platforms. | QA-33 |
| P2-23 | Turning on stricter compiler flags surfaces 37 errors, including unused values that hide real bugs (`expectedPeerId` destructured and unused, `fileIndex`). | Enable `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride` and `noFallthroughCasesInSwitch` now. Enable `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` after cleanup. | QA-50 |
| P2-24 | CI hygiene: `on: push` for all branches plus `pull_request` runs every job twice, and the smoke step is redundant. No `permissions`, `timeout-minutes` or `concurrency` settings. Actions are pinned by tag. | Restrict push to main, drop the redundant step, add `permissions: contents: read`, a timeout and concurrency, and pin actions by SHA. | QA-47 |
| P2-25 | Bun version drift: CI uses 1.4.3, local 1.4.2, `@types/bun` 1.4.2, and nothing is declared. | Add `engines.bun` and `.bun-version`, align `@types/bun`, and state the version in the README. | QA-48 |
| P2-26 | No Dependabot/Renovate config and no vulnerability scan. `@opentui/core` is pre-1.0 and has native optional dependencies. | Enable Renovate or Dependabot, add a scan step, and set an upgrade policy for OpenTUI. | QA-49 |

---

## 12. Documentation

| ID | Problem | Fix | Sources |
|---|---|---|---|
| P1-51 | `phase1.md` says "no real network transfer is implemented". `phase2.md` contradicts its own banner and has stale test counts. Both sit at the repo root. `phase1.md:7` has broken link markup. | Move both to `docs/history/` with dated banners. Update references (`README.md:82-83`, `decisions.md:4, 54, 75`, and the header comments in `transfer-protocol.ts`, `frame-parser.ts` and `session-auth.ts`). Fix the link. | QA-11, QA-34, QA-52, QA-53 |
| P1-52 | The README overclaims: "restart-from-zero recovery", "verified before any metadata flows", files "land in ~/Downloads". The layout section describes `services/` as mock-only. | Rewrite the Status section (works / unverified / known limitations). Update the layout. Link `networking.md` and the checklist. | QA-35 |
| P1-53 | `networking.md` claims enforced timeouts, TOFU verification, "the final path is realpath-checked", temp files "unlinked on any failure", and collisions that never fail. | Correct each claim as its fix lands, or now. | NET-34, QA-36 |
| P1-54 | `decisions.md` items are not implemented: per-session identity, a listening indicator, a 60 s confirmation timeout, a 64 KiB frame cap, 3 retries, 1 concurrent session. | Add a status column (implemented / deviation / deferred). Record any TOFU or alias decision there. | QA-37 |
| P1-55 | `real-mode-checklist.md` has steps that fail as written (port-in-use message, "stay on workspace") and is missing cases. | Re-run it after the P0 fixes. Add cases: duplicate alias, consent timeout, missing Downloads, rename, staging scope, stalled sender, IPv6, cancel. | QA-38 |
| P1-56 | Missing release documentation: SECURITY.md, a threat model (required by phase2 §2), a privacy statement (alias and Peer ID disclosure), CHANGELOG, troubleshooting, known limitations, Termux notes. The phase2 release gates (packet capture, two-host runs, filesystem matrix, performance thresholds) have no evidence. | Add the files. Track the release gates in one checklist with status and an evidence link for each. | QA-39 |

---

## 13. Suggested sequencing

Each step should land with its tests. Nothing below depends on a later step.

**Step 1: quick wins (about 1–2 days, no protocol change)**
- P0-3 part 1: forward the abort signal in `asByteSource`, which restores
  the 15 s/60 s timeouts. Add the consent timeout and close watcher.
- P0-9: in-flight guard plus `setScreen`.
- P0-10: create and check `~/Downloads` before consent.
- P0-13: print startup errors before the renderer starts.
- P0-14: compact border fix.
- P0-12 part 1: make `a` accept everything, make Enter with nothing selected
  a no-op, scroll the consent list, and add the display sanitizer.
- P1-2, P1-3, P1-4, P1-5: hide the mock controls in real mode.
- P1-37, P1-38: staging fixes.
- P1-40: strict CLI parsing.
- P1-41, P1-42: promise handling and timer cleanup.

**Step 2: transport hardening (no wire change)**
- P0-4: backpressure and chunk queue.
- P0-5: concurrent capped handshakes.
- P0-8: AbortControllers end to end, connect timeout, listener teardown.
- P0-11: special-file handling.
- P1-17, P1-18: zero-length messages and per-frame timers.
- P1-44: the adversarial TCP suite. It should be red before these fixes and
  green after.

**Step 3: protocol v2 (one wire-version bump)**
- P0-1: SAS confirmation, tagged and role-bound proof, prologue, own-ID
  rejection.
- P0-2: FILE_RESULT acknowledgement.
- P0-6: per-type size caps and the Noise 65535 limit.
- P0-7: unique, index-based acceptance.
- P1-9, P1-10: DECLINE, CANCEL and ERROR frames.
- P1-11: partial results.
- P1-12: wire binding.
- P1-13: per-session identity.
- P1-14: session lifecycle.
- P1-33 to P1-36: Noise and session-auth hygiene.

**Step 4: the real status model, which removes the mock services from real mode**
- P1-8: structural removal of the mock services from real mode.
- P1-1: real queue and Receiver status.
- P1-6: real retry.
- P1-7: honest peer state.
- P1-16: listening indicator and bind option.
- P1-30: wire discovery events.
- P1-39: select peers by ID.

**Step 5: filesystem and discovery polish**
- Filesystem: P1-19 to P1-27.
- Discovery: P1-28, P1-29, P1-31, P1-32.
- IPv6: P1-15.

**Step 6: release engineering**
- Tests: P1-43, P1-45 to P1-47.
- Tooling and packaging: P1-48 to P1-50.
- Documentation: P1-51 to P1-56, then re-run the manual checklist on two
  real hosts.

**Step 7: P2 backlog**
- UI layout and accessibility: P2-5 to P2-18.
- Performance: P2-4.
- Dead code: P2-19, P2-20.
- Tooling strictness and CI hygiene: P2-21 to P2-26.

---

## 14. Definition of done for 1.0

- All P0 items closed, each with a regression test that fails on `a87d307`.
- No `Mock*` class is constructed or reachable in real mode. A test asserts
  this.
- A two-process loopback e2e test runs in CI on Linux and macOS: send,
  accept, decline, cancel, receiver failure, and a stalled peer.
- Coverage floors are enforced, and `app.ts` real paths are at least 80%
  covered.
- `docs/real-mode-checklist.md` has passed on two physical hosts on a real
  LAN, with results recorded.
- README, networking.md and decisions.md match the code, with every
  deviation recorded.
- LICENSE, SECURITY.md, the threat model and the privacy note are present,
  and release binaries are built in CI.
