# Troubleshooting

Common problems in real mode (`--real`), what causes them, and what to try. Error
text is quoted as the app shows it. Real-mode behaviour on Termux and macOS has not
been verified (see [known-limitations.md](known-limitations.md)).

## Startup

**"already in use" or the instance exits at once.**
Another instance, or another program, is using the TCP port. Pick a free port on
both sides, for example `--port 24818`, and point the peers at it with `--peer`.

**Usage error, exit status 2.**
A flag was unknown, a value was missing, or a value was invalid. The message names
the problem and says to run `--help`. Use `--flag value` or `--flag=value`. Port
numbers must be 1 to 65535. An IPv6 `--peer` needs brackets: `--peer [::1]:24816`.

**`--bind` error, for example `EADDRNOTAVAIL`.**
The address is not configured on this machine. Use `127.0.0.1` for loopback, or an
address shown by `ip addr` (Linux) or `ifconfig` (macOS). Without `--bind`,
SyncWeave tries IPv6 `::` and falls back to `0.0.0.0` with a notice if IPv6 is not
available.

**Garbled header or boxes instead of icons.**
Use a wider terminal. The header has been seen garbled at widths around 90 to 112
columns. For terminals without Nerd Fonts, set `SYNCWEAVE_ASCII=1`.

**Too much motion.**
Set `SYNCWEAVE_REDUCED_MOTION=1`.

## Finding peers

**The other machine never appears in the Receiver pane.**
Discovery uses UDP multicast on port 24817. Check, in order:

1. Both machines are on the same subnet and VLAN. Guest Wi-Fi and some access points
   isolate clients, which blocks discovery and transfers.
2. UDP 24817 is allowed by the local firewall on both machines.
3. You are not on a VPN that does not carry multicast.
4. The two instances are not on the same host. Multicast may not loop back. Use
   `--peer` on that host.

If none of this helps, add the peer by address: `--peer 192.168.1.5:24816`.

**A peer disappears after a while.**
Discovery entries expire after 15 seconds without an announcement. Usually the
other instance stopped, the Wi-Fi changed, or the machine went to sleep. Manual
`--peer` entries do not expire.

**Two entries have the same name.**
Two instances use the same `--alias`. Pick the entry by its address. The default
alias is random for each run, so this only happens when you set `--alias`.

## Sending

**"select a peer" or "stage at least one file".**
Pick a peer with `Tab` and `↑`/`↓`, and stage files with `Space` before pressing `s`.

**The security codes differ.**
Do not confirm, and do not send. The two codes must match. A difference can mean the
request reached a different machine, or that someone is between you. Check that you
are talking to the right person, then start again. If the codes still differ, report
it (see [SECURITY.md](../SECURITY.md)).

**"Noise handshake timed out" (after 60 seconds).**
The peer accepted the TCP connection but did not finish the handshake. Usually the
peer is not SyncWeave, or it stopped. Check the port and the peer's instance.

**"connect to HOST:PORT timed out after 10s".**
Nothing is listening there, or a firewall drops the packets. Check the peer address,
the peer's `--port`, and the firewall on the peer. Use `--peer` and make sure the
peer is running with `--real`.

**"Peer closed" or "Noise channel is closed" on the sender.**
The receiver closed the connection. Typical causes: the receiver declined, the
consent window ended, the receiver was stopped or lost its network, or it rejected a
file. Look at the receiver's status line and `syncweave.log`.

**Protocol version rejected.**
Both sides must run a build that speaks protocol v2. Update the older one. Version
1 peers are refused.

## Receiving

**I missed the consent prompt.**
The receiver has 60 seconds to answer. After that the request is declined. The sender
waits up to 75 seconds for the answer and then reports that the transfer was not
accepted. Ask the sender to send again.

**A file arrived with " (1)" in its name.**
A file with that name already existed, so SyncWeave kept both. Nothing was
overwritten.

**Files are not in `~/Downloads`.**
Check the destination shown on the consent screen and in the picker. Files go to the
folder that was chosen. The folder is created at startup if it is missing.

**"destination ... refused" in the picker.**
The folder is a symlink, a system directory, a hidden (dot) directory, or world
writable. Choose another folder. To fix a world-writable folder, run `chmod o-w`
on it.

**A transfer failed and a `.syncweave-*.partial` file is left in a folder.**
A crash or `kill -9` leaves the partial behind. The next startup removes it, unless
the instance that wrote it is still running. Delete it by hand if you are sure
nothing is writing it.

**"integrity" or hash mismatch.**
The received bytes did not match the hash the sender sent. Nothing is saved. Send the
file again. If it keeps happening, check the network path and the disk.

## Stopping

**`Ctrl+C` seems slow.**
The instance cancels any receive in progress and then exits. Wait for the status
line to finish. If the process is killed before it finishes, a partial file may
remain (see above).

## Collecting information for a bug report

1. The exact command line (with the alias and addresses changed if you need to).
2. The on-screen text or error.
3. `syncweave.log` from `$XDG_STATE_HOME/syncweave/` or `~/.local/share/syncweave/`.
   Read [privacy.md](privacy.md) first. The log contains aliases, paths and Peer ID
   prefixes.
4. `bun --version`, the commit, and your OS and architecture.
