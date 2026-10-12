# Privacy

What SyncWeave reveals on your network, what it writes to disk, and how to remove
it. This describes the target behaviour for the 0.1.0 remediation round. It has no
telemetry: SyncWeave sends nothing to any server. No cloud relay is used.

## What other devices on the LAN can see

While `--real` is running:

| What | Where it goes | Visible to |
|---|---|---|
| Discovery announcement: `{v, alias, peerId, tcpPort}`, plaintext JSON, every 5 s | UDP multicast `224.0.0.167:24817`, TTL 1 (link-local only) | Everyone on the same network segment |
| Your IP address | Source address of every discovery packet, and of every TCP connection | Anyone who can see the traffic, and the peer you connect to |
| A TCP listener on `--port` (default `24816`) | Accepts connections from any reachable address | Anyone who can reach the port, including through a VPN if routing allows |

Details:

- **Alias.** The default is a random label generated for each run. It is not your
  username. If you pass `--alias`, that name is announced to everyone on the LAN.
- **Peer ID.** Generated for each run and never saved. It is constant for the life
  of the process, so it links the announcements within one run. A new run gets a new
  Peer ID, so runs cannot be linked to each other by Peer ID.
- **Security code (SAS).** Derived for each session and shown to the two people in
  the transfer. It is not sent in discovery.
- **File metadata.** The sender confirms the security code first. Then file names,
  sizes and count go only to the peer that was confirmed. The receiver sees this
  metadata before deciding to accept.
- **File contents.** Encrypted in transit with Noise (AES-GCM). Only the receiver
  sees them, and only if the receiver accepts.
- **Presence.** Anyone on the LAN can see that SyncWeave is running, because of the
  discovery announcements.

## What SyncWeave writes to disk

| Path | Contents | Removed when |
|---|---|---|
| `$XDG_STATE_HOME/syncweave/` (default `~/.local/share/syncweave/`) | Holds the two files below | You delete the directory |
| `syncweave.log` in that directory | One line per event with a timestamp: session start (alias, port, bind address), transfer start and finish (peer alias and address, file counts, the Peer ID prefix, the security code), consent accept or decline, destinations added or removed (folder paths), and failure messages. It never records file contents. Failure messages can include a file path. | You delete it. It is not rotated and grows over time. |
| `destinations.json` in that directory | The receive folders you added. A local preference that does not authorize anything. | You remove folders in the picker, or delete the file |
| Received files | In the folder you chose (default `~/Downloads`), mode `0600` | You delete them |
| `.syncweave-*.partial` | Temporary copy of a file being received, in the chosen folder | On completion, on failure or cancellation, or at the next startup if its owner is no longer running |

Not written to disk: identity keys, Peer IDs (except the prefix in the log), session
IDs, consent state, authorization tokens and the contents of discovery packets. These
live only in memory and disappear when the process exits.

## Reporting a bug without over-sharing

`syncweave.log` is the file to attach to a bug report. Before you attach it, check
it for your alias, folder paths and the Peer ID prefixes. Remove any lines you do not
want to share. The log holds no file contents.

## Removing SyncWeave's data

1. Stop all instances (`Ctrl+C`).
2. Delete `~/.local/share/syncweave/` (or `$XDG_STATE_HOME/syncweave/`).
3. Delete any `.syncweave-*.partial` files left in your receive folders.
4. Received files are yours and are not removed by SyncWeave.

## Choosing a name for the LAN

Pick a neutral `--alias` if you do not want your name shown to people on your
network. The default random label avoids this unless you choose a name yourself.
