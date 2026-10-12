# SyncWeave real-mode test checklist

Manual QA for `bun src/main.ts --real`. Work top to bottom; check each box.
File bugs against what you actually see — note the instance, the step, and
the exact on-screen text or error.

## Setup

```sh
# terminal 1
bun src/main.ts --real --alias laptop1 --port 24816 --peer 127.0.0.1:24818
# terminal 2
bun src/main.ts --real --alias laptop2 --port 24818 --peer 127.0.0.1:24816
```

(On two LAN machines, drop `--port`/`--peer` and rely on multicast discovery.)

- [ ] Both instances boot to the workspace with no stack trace.
- [ ] A second instance on the default port exits with the friendly
      "already in use" message, not `EADDRINUSE`.
- [ ] Header shows `DISCOVERY` (never `MOCK DISCOVERY`).
- [ ] Status line does not claim anything is simulated.
- [ ] No mock peer names (MacBook-M3, etc.) ever appear.

## Discovery & peer selection

- [ ] Each instance lists the other in the Receiver pane within ~10 s.
- [ ] `Tab` to the Receiver pane; `↑`/`↓` cycles the peer list; the `▸`
      marker follows the selection.
- [ ] Status line announces the newly selected target peer.
- [ ] Killing one instance makes it disappear from the other's list
      within ~20 s (15 s expiry + 2 s sync).

## Send flow (laptop1 → laptop2)

Prep: put a small text file (e.g. `hello.txt`) in a scratch dir and browse
to it on laptop1.

- [ ] `Space` stages the file; staged count appears in the activity panel.
- [ ] `s` opens the review screen showing `Local → laptop2` (the selected
      peer) and the staged file list — no "mock preview" wording.
- [ ] `Enter` starts the send. Status line shows progress
      (`Sending hello.txt (1/1) · 100%`).
- [ ] No "No transfer is active" dead-end; you stay on the workspace.
- [ ] Send completes: `Sent 1 file(s) to laptop2`.

## Consent & receive (laptop2)

- [ ] Consent screen pops up showing the **actual sender** (`laptop1`),
      file name, and size.
- [ ] `a` accepts all → files land in `~/Downloads`, status confirms.
- [ ] Received bytes are identical: `sha256sum` matches the original.
- [ ] `x` on a second transfer declines it; the sender sees a clean
      failure, not a hang.
- [ ] Keyboard-only accept/decline never wedges the receiver — a third
      transfer still arrives and works afterwards.

## Collision & budgets

- [ ] Send the same file twice → second lands as `hello (1).txt`;
      the original is never overwritten.
- [ ] A file over 2 GiB (or a crafted over-budget session) is rejected
      before any bytes are accepted.

## Edge cases

- [ ] Sending with no peer selected → clear "select a peer" hint.
- [ ] Sending with nothing staged → clear "stage at least one file" hint.
- [ ] Receiver kills its instance mid-transfer → sender reports failure,
      no hang.
- [ ] `Ctrl+C` on either instance exits cleanly (no orphaned listeners;
      restart works immediately).

## After testing

- [ ] `git log --oneline -3` on main matches what you tested.
- [ ] Note anything in `docs/networking.md` "Unverified" that you can now verify.
