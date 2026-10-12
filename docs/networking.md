# SyncWeave networking

How real mode (`--real`) moves files, what a receiver and a sender see, and what
is still unverified. This describes the target behaviour for the 0.1.0
remediation round. Where the code does not yet do this, the gap is listed in
[known-limitations.md](known-limitations.md). Decisions and their status are in
[decisions.md](decisions.md).

## Transports

| Plane | Protocol | Default port | Notes |
|---|---|---|---|
| Transfer | `Noise_XX_25519_AESGCM_SHA256` over raw TCP | 24816 (`--port`) | Listener binds `::` (dual-stack). If IPv6 is unavailable and `--bind` was not given, it falls back to `0.0.0.0` and shows a notice. An explicit `--bind` never falls back. |
| Discovery | UDP multicast, JSON announcements | 24817 | Group `224.0.0.167`, TTL 1 (link-local only). |

No mDNS, no DNS lookups for dial targets (`dialNoise` rejects non-numeric
hosts), no cloud relay, no broadcast fallback, and no retry of a failed transfer.

## Discovery

Every `--real` instance announces `{v, alias, peerId, tcpPort}` every 5 seconds
and immediately on start. Peers expire after 15 seconds of silence.

- **Alias.** Defaults to a random label generated for each run, not your
  username. `--alias` overrides it. The alias is visible to everyone on the LAN.
- **Peer ID.** Generated per run and never persisted. It is a display hint only.
  It is never used as the expected identity of a session. Identity is checked
  with the security code (below).
- **Claimed names.** A discovered alias is shown as *claimed*. Anyone can announce
  any alias, so a name on the list is not proof of who is there.
- Malformed or oversized (over 512 bytes) packets are ignored. Announcements that
  claim the reserved `manual:` peer-ID namespace are rejected. Control characters
  are stripped from aliases before display.

**Manual peers.** `--peer 192.168.1.5:24816` (repeatable; IPv6 as
`--peer [::1]:24816`). Manual peers never expire. They are verified exactly like
discovered peers, with the security code. There is no trust-on-first-use (TOFU)
pinning: nothing about a peer is stored between runs. Invalid `--peer` values are
rejected: `parsePeerSpec` throws `UsageError` and the process exits with status 2.

## Protocol v2

The frame version byte is `0x02`. v1 frames are rejected. All application frames
travel inside the Noise channel.

Session flow, sender on the left:

1. TCP connect (10 s budget), then the Noise XX handshake (60 s budget).
2. Identity proofs (Gate B). Each side signs a tagged, role-bound message:
   `"syncweave-id-proof-v2" || role ("sender"/"receiver") || 0x02 || handshake hash`.
   The proof carries `{v: 2, role, peerId, identityPublicKey, identitySignature}`.
   A proof whose Peer ID equals the verifier's own is rejected (no reflection).
   The Noise prologue `NOISE_PROLOGUE_V2` (`"syncweave-noise-prologue-v2"`) is
   passed by the transport.
3. **Sender confirms the security code.** Both sides derive the same short
   authentication string (SAS, `1234-5678-9012`) from the handshake hash. The
   sender shows it and must confirm it (`SendOptions.confirmSas`) before it sends
   any file metadata. If the sender does not confirm, the session ends and no
   metadata is sent.
4. The sender sends `TRANSFER_REQUEST` with file names, sizes and count. The
   budgets are checked here, before consent.
5. **Receiver confirms on consent.** The consent screen shows the sender's name,
   the file names and sizes, and the same SAS. The receiver has **60 seconds** to
   answer. If the sender disconnects, cancels, or the deadline passes, the consent
   prompt is withdrawn and the request is treated as declined.
6. The receiver replies `TRANSFER_ACCEPT` with the accepted indices and a
   receiver-issued `transferToken`, or `DECLINE`. Acceptance refers to the
   offered files by index, so two identical files in one request stay distinct.
   The sender waits up to **75 seconds** for this reply.
7. For each accepted file the sender streams `FILE_HEADER` and `FILE_CHUNK`
   frames. A `FILE_CHUNK` body is at most 65,474 bytes, so the Noise ciphertext
   never exceeds the 65,535-byte message limit. Files are read in chunks and never
   buffered whole.
8. The receiver verifies the SHA-256 and the exact byte count, publishes the file,
   and replies `FILE_RESULT` per file: `{index, ok, finalName, bytes, sha256}` or
   `{index, ok: false, errorCode}`. **The sender checks the acknowledged hash and
   size against what it sent.** A mismatch is a failure, even if the receiver
   reported `ok`.
9. The receiver sends `SESSION_RESULT`. The sender reports success only when every
   accepted file has a matching acknowledgement. A close or timeout before the
   results is a failure.

Other frames:

- `CANCEL` and `ERROR` carry a reason code. They are sent on local abort or
  failure and are handled in every reading state.
- Per-type body caps are enforced on the header: handshake-adjacent frames at most
  4 KiB, request and accept frames at most 64 KiB.
- Each session has its own identity and session ID. The session ID is derived
  from the transcript hash (`SHA-256("syncweave-session-id-v2" || handshakeHash)[0:16]`)
  and is validated on every frame.

## Timeouts

| Wait | Budget | Notes |
|---|---|---|
| TCP connect | 10 s | |
| Noise handshake | 60 s | Covers the whole handshake, from accept or dial. |
| Frame header | 15 s | Applies to each header read. |
| Frame body | 60 s | A sender that stalls mid-body is cut off. |
| Receiver wait for the transfer request | 120 s | After identity proofs; gives the sender time to compare the security code before any metadata is sent. |
| Receiver consent | 60 s | After the request is shown. |
| Sender wait for acceptance | 75 s | Longer than the consent window, so a late but valid accept is not lost. |
| Waiting for file and session results | 60 s | Own deadline, separate from the frame-header timeout. |

A silent peer after the handshake is rejected at the header timeout. The
listener caps concurrent handshakes (4), so stalled peers cannot wedge it.

## Security properties

- **Encryption.** Noise XX with fresh ephemeral X25519 keys per session, verified
  against the official Noise test vectors.
- **Identity.** A fresh Ed25519 identity per session, signed over the role-bound v2
  proof (Gate B). The two humans compare the SAS: the sender before any metadata
  (step 3), the receiver on consent (step 5). Discovery never substitutes for this.
  There is no pinning, no trust-on-first-use and no persistent pairing.
- **Consent.** The receiver must accept each transfer (Gate C) before any file
  bytes flow. No auto-accept.
- **Budgets (both ends).** 25 files per session, 2 GiB per file, 10 GiB per session.
  Enforced on advertised metadata before consent, and on actual received bytes
  during streaming.
- **Integrity.** SHA-256 and the exact byte count are verified before a file is
  published. The sender checks each acknowledgement (step 8).
- **Destination safety.** Files are saved to the chosen folder, which defaults to
  `~/Downloads`. The picker refuses symlinks, system directories, hidden (dot)
  directories and world-writable directories.
- **Filenames.** Only the last path component is kept. Leading dots, control and
  bidi characters, and Windows device names are removed or rejected.
- **Paths.** The destination directory is resolved with `realpath`. The final name
  must be a single component inside it.
- **No overwrite.** Collisions are renamed `name (1).ext`, `name (2).ext`, and so
  on. Publication uses `link(2)`, which fails rather than replace an existing
  file. If another file takes the chosen name after the check and before
  publication, the transfer fails; it is not retried with a new name yet
  (see known-limitations).
- **Temporary files.** `.syncweave-<id>.partial` in the destination, created with
  `O_EXCL` and mode `0600`. Removed on failure or cancellation. A `SIGKILL` leaves
  the partial behind. At startup, SyncWeave removes leftover partials only when
  their owning process is no longer running, so a live partial from another
  instance is not touched.

## Same-machine testing

Two instances on one host need distinct TCP ports, and each must point at the
other, because multicast may not loop back:

```bash
bun src/main.ts --real --alias laptop1 --port 24816 --peer 127.0.0.1:24818
bun src/main.ts --real --alias laptop2 --port 24818 --peer 127.0.0.1:24816
```

A second instance on the default port exits with a clear "already in use" message
instead of an `EADDRINUSE` stack trace.

## Firewall and network behaviour

- **Inbound TCP 24816** (or your `--port`) must be reachable from peers. On Fedora:
  `sudo firewall-cmd --add-port=24816/tcp` (adjust for `--port`).
- **Inbound UDP 24817** must be reachable for discovery. Without it, use `--peer`.
- **Client isolation** (guest Wi-Fi, AP isolation) blocks both planes. Use `--peer`
  with the peer's IP if layer-3 routing exists. Otherwise transfers cannot work by
  design, because there is no relay.
- **VPNs.** The listener is reachable on every interface, so a peer on a VPN
  interface can connect if routing and the firewall allow it. Multicast discovery
  typically does not cross VPN tunnels; use `--peer`.
- **Listening.** While real mode runs, the header shows a listening indicator. The
  listener stops when the process exits.

## Unverified

Nothing in this section has been run on real hardware yet.

- Real two-host LAN transfer, end to end.
- Packet captures of the handshake and discovery.
- Multicast behaviour across real routers and access points (IGMP snooping, isolation).
- Throughput, memory and CPU under load.
- Termux (Android).
- Interface change, sleep and wake, and address change.
- macOS: the CI job exists but has not run.

Release gates and their evidence are tracked in [release-gates.md](release-gates.md).
