# SyncWeave real-mode test checklist

Manual QA for `bun src/main.ts --real`. Work top to bottom and check each box.
File bugs against what you actually see: note the instance, the step, and the
exact on-screen text or error. Results go in the run record at the end.

Cases marked **(two hosts)** need two machines on the same LAN and use multicast
discovery. Everything else runs on one machine with two instances.

## Setup

```sh
# terminal 1
bun src/main.ts --real --alias laptop1 --port 24816 --peer 127.0.0.1:24818
# terminal 2
bun src/main.ts --real --alias laptop2 --port 24818 --peer 127.0.0.1:24816
```

On two LAN machines, drop `--port` and `--peer` and rely on multicast discovery
(**two hosts**).

- [ ] Both instances boot to the workspace with no stack trace.
- [ ] A second instance on the default port exits with the friendly "already in
      use" message, not `EADDRINUSE`, and exits with status 1.
- [ ] Header shows `DISCOVERY` (never `MOCK DISCOVERY`) and a listening indicator.
- [ ] Status line does not claim anything is simulated.
- [ ] No mock peer names (MacBook-M3, etc.) ever appear.
- [ ] Default alias is a random label, not your username (run without `--alias`).
- [ ] Usage errors exit with status 2 and print a hint: `--reall`, `--port abc`,
      `--alias` with no value, and `--port=` with an empty value.
- [ ] `--port=24818` and `--alias=laptop3` (the `=` form) take effect.

## Discovery and peer selection

- [ ] Each instance lists the other in the Receiver pane within about 10 s
      **(two hosts)**. On one machine, the `--peer` entry appears.
- [ ] `Tab` to the Receiver pane; `↑`/`↓` cycles the peer list; the `▸` marker
      follows the selection.
- [ ] Status line announces the newly selected target peer.
- [ ] Discovered names are marked as claimed, not verified.
- [ ] Killing one instance makes it disappear from the other's list within about
      20 s (15 s expiry + 2 s sync).
- [ ] **Duplicate alias.** Start both instances with `--alias same`. Both run, and
      each list shows two entries. Stopping one removes exactly one entry. A send
      goes to the entry you selected, which is identified by address, not name.
- [ ] **IPv6 fallback.** On a host with IPv6 disabled, start without `--bind`. A
      notice says it fell back to `0.0.0.0`, and the instance runs. Start with
      `--bind ::` on the same host. It fails with a clear message and does not fall
      back.
- [ ] **IPv6 peer.** `--peer [::1]:24818` connects to a local instance listening on
      `::`. A bare `--peer ::1:24818` is rejected with the bracket hint.

## Send flow (laptop1 → laptop2)

Prep: put a small text file (e.g. `hello.txt`) in a scratch dir and browse to it on
laptop1.

- [ ] `Space` stages the file; staged count appears in the activity panel.
- [ ] `s` opens the review screen showing `Local → laptop2` (the selected peer),
      the staged file list and the peer's claimed name. No "mock preview" wording.
- [ ] **SAS confirm (sender).** Before anything is sent, the sender shows the
      security code and asks for confirmation. Confirming sends the request.
      Cancelling sends nothing: laptop2 shows no consent screen.
- [ ] `Enter` starts the send. Status line shows progress
      (`Sending hello.txt (1/1) · 100%`).
- [ ] No "No transfer is active" dead-end; you stay on the workspace.
- [ ] Send completes only after the receiver's acknowledgement:
      `Sent 1 file(s) to laptop2`.
- [ ] **Staging scope.** Stage `hello.txt` in folder A, browse to folder B, and
      stage a second file there. Review lists both files. `Shift+A` in folder B
      clears only folder B's staging, as documented.
- [ ] **No peer selected.** With no peer selected, `s` and `Enter` show a clear
      "select a peer" hint and do not start a send.
- [ ] **Nothing staged.** With nothing staged, `s` shows a clear "stage at least
      one file" hint.

## Consent & receive (laptop2)

- [ ] Consent screen pops up showing the sender's claimed name (`laptop1`), file
      name, size and the same security code the sender confirmed.
- [ ] `a` accepts all → files land in `~/Downloads`, status confirms.
- [ ] Received bytes are identical: `sha256sum` matches the original.
- [ ] **SAS match (both sides).** The code on laptop2's consent screen equals the
      code laptop1 confirmed. Record both values in the run record.
- [ ] `x` on a second transfer declines it; the sender sees a clean failure, not a
      hang.
- [ ] **Consent timeout.** Leave a request unanswered for 60 s. The consent prompt
      disappears. The sender reports the transfer as declined or timed out, within
      about 75 s. Nothing is written to `~/Downloads`.
- [ ] **Sender disconnect while consent is open.** Start a send, then stop the
      sender before answering. The prompt disappears on laptop2, and laptop2 does
      not show "Accepted" afterwards.
- [ ] Keyboard-only accept/decline never wedges the receiver. A third transfer still
      arrives and works afterwards.
- [ ] **Missing Downloads.** Move `~/Downloads` away and start the receiver. The
      folder is created at startup. If it cannot be created, the instance shows a
      clear message. Restore the folder afterwards.

## Collision, rename & budgets

- [ ] Send the same file twice → second lands as `hello (1).txt`; the original is
      never overwritten. The status shows the final name.
- [ ] **Two identical files in one request.** Stage two copies with the same
      content and send them together. Accept only the second one. Only that copy
      arrives, and it is not mixed up with the first.
- [ ] A file over 2 GiB (or a crafted over-budget session) is rejected before any
      bytes are accepted, and the sender is told why.

## Cancel, stalls and failure

- [ ] **Cancel from the sender.** Send a file of about 200 MB and cancel after
      progress starts. The sender reports cancelled. Laptop2 reports failure, and no
      file or `.syncweave-*.partial` remains in `~/Downloads`.
- [ ] **Stalled sender.** Send a large file, then suspend the sender process
      (`kill -STOP <pid>`). Laptop2 gives up within about 60 s and removes its
      partial. Resume the sender (`kill -CONT <pid>`) and check that it reports a
      failure.
- [ ] Receiver kills its instance mid-transfer → sender reports failure, no hang.
- [ ] **Sweep.** Kill laptop2 with `kill -9` during a receive. Restart it. The
      leftover `.syncweave-*.partial` is removed at startup. Run two live instances
      that both receive into the same folder, and confirm that a live partial from
      the other instance survives the startup sweep.
- [ ] A destination folder that you removed after choosing it fails the transfer
      with a readable message, and the sender is told.

## After testing

- [ ] `Ctrl+C` on either instance exits cleanly: no orphaned listeners, the terminal
      is restored, and restart works immediately.
- [ ] `git log --oneline -3` on the branch matches what you tested.
- [ ] Update the "Unverified" list in [networking.md](networking.md) with what you
      have now verified.
- [ ] Record the run in the table below, and update
      [release-gates.md](release-gates.md) if a gate changed.

## Run record

| Date | Commit | Hosts (OS, arch) | Network | Steps failed (number and text) | Notes |
|---|---|---|---|---|---|
| | | | | | |
