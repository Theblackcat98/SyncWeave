# SyncWeave networking

How the real-mode (`--real`) network stack works, what to expect on a LAN,
and what is still unverified. Written 2026-10-11 after the transport
implementation merged (PRs #21–#23).

## Transports

| Plane | Protocol | Default port | Notes |
|---|---|---|---|
| Transfer | `Noise_XX_25519_AESGCM_SHA256` over raw TCP | 24816 | Listener binds `0.0.0.0` (all interfaces). Override with `--port`. |
| Discovery | UDP multicast, JSON announcements | 24817 | Group `224.0.0.167`, TTL 1 (link-local only). |

No mDNS, no DNS lookups for dial targets (`dialNoise` rejects non-numeric
hosts), no cloud relay, no broadcast fallback.

## Discovery

Every `--real` instance announces `{v, alias, peerId, tcpPort}` every 5
seconds and immediately on start. Peers expire after 15 seconds of silence.
Announcements carry the **ephemeral** Peer ID (fresh per run, never
persisted), so peers are unlinkable across restarts.

Malformed or oversized (>512 B) packets are ignored. Announcements claiming
the reserved `manual:` peer-ID namespace are rejected — that prefix is
local-only. Aliases are stripped of control characters before display.

**Manual fallback:** `--peer 192.168.1.5:24816` (repeatable; IPv6 as
`--peer [::1]:24816`). Manual peers never expire and use TOFU identity
verification; discovered peers use exact Peer-ID verification. Invalid
`--peer` specs are skipped with a warning.

## Protocol v2 (wire changes)

Frame version byte is `0x02`; v1 frames are rejected. All application
frames still travel inside the Noise channel.

- **Identity proof (P0-1):** each side signs a tagged, role-bound message —
  `"syncweave-id-proof-v2" || role ("sender"/"receiver") || 0x02 ||`
  handshake hash — instead of the raw hash. The proof body carries
  `{v: 2, role, peerId, identityPublicKey, identitySignature}`. A proof
  whose Peer ID equals the verifier's own is rejected (no self-accept /
  reflection). A short authentication string (SAS, `1234-5678-9012`
  format, derived from the handshake hash) is exposed on both ends for the
  users to compare out of band; the UI must display it on send-review and
  consent. Planned: a Noise prologue (`NOISE_PROLOGUE_V2`,
  `"syncweave-noise-prologue-v2"`) — not yet passed by the transport.
- **Session id (P1-12):** derived from the transcript hash
  (`SHA-256("syncweave-session-id-v2" || handshakeHash)[0:16]`) so both
  ends agree; the `SessionId` extension is validated on every frame.
- **Acceptance (P0-7):** `TRANSFER_ACCEPT` carries `acceptedIndices`
  (indices into the request, unique, in range) instead of file objects, plus
  a receiver-issued `transferToken` echoed in every `FILE_HEADER`
  extension, binding the stream to the Gate C decision.
- **Acknowledgement (P0-2):** the receiver sends `FILE_RESULT`
  `{index, ok, finalName, bytes, sha256} | {index, ok: false, errorCode}`
  per file, then a final `SESSION_RESULT`. The sender reports success only
  after matching results arrive; a close or timeout before the result is a
  failure. `sendFiles` returns `{outcomes, verifiedPeerId, sas}`.
- **Decline (P1-9):** explicit `DECLINE` frame instead of
  decline-as-exception; both sides report "declined".
- **Cancel/error (P1-10):** reason-coded `CANCEL`/`ERROR` frames are sent
  on local abort/failure and handled in every reading state.
- **Size caps (P0-6):** per-type body caps enforced on the header —
  handshake-adjacent frames ≤ 4 KiB, request/accept ≤ 64 KiB.
  `FILE_CHUNK` bodies are 65,474 bytes so the Noise ciphertext never
  exceeds the 65,535-byte message limit (plaintext ≤ 65,519 enforced in
  the Noise layer; handshake messages structurally length-checked).
- **Identity discipline (P1-13):** one ephemeral Ed25519 identity per
  session; reuse across sessions fails closed.

## Security properties

- **Encryption:** Noise XX handshake, fresh ephemeral X25519 keys per
  session; verified byte-for-byte against the official Noise test vectors.
- **Identity:** ephemeral Ed25519 Peer ID per session (never reused),
  signature over the tagged, role-bound v2 proof message (Gate B), plus a
  user-comparable SAS. Discovery never substitutes for verification.
- **Consent:** receiver must accept each transfer (Gate C) before any file
  bytes flow. No auto-accept, no persistent pairing.
- **Budgets (both ends):** 25 files/session, 2 GiB/file, 10 GiB/session.
  Enforced on advertised metadata *before* authorization and on actual
  received bytes during streaming.
- **Integrity:** SHA-256 verified before a file is finalized; exact
  byte-count match required.
- **Destination safety:** files land in `~/Downloads` (currently hardcoded;
  the consent screen's destination picker has a single entry). Collision
  autorename (`name (1).ext`), never overwrite. Filenames are sanitized
  (last path component only, no leading dots, no control chars, no Windows
  device names) and the final path is `realpath`-checked to stay inside the
  receive directory. Temp files are `O_EXCL` `0o600` and unlinked on any
  failure.
- **Timeouts:** 60 s handshake budget, 15 s frame-header timeout, 60 s frame-
  body timeout. A stalled peer cannot wedge the listener forever.

## Same-machine testing

Two instances on one host need distinct TCP ports, and each must be pointed
at the other (multicast may not loop back):

```bash
bun src/main.ts --real --alias laptop1 --port 24816 --peer 127.0.0.1:24818
bun src/main.ts --real --alias laptop2 --port 24818 --peer 127.0.0.1:24816
```

A second instance on the default port exits with a clear message instead of
an `EADDRINUSE` stack trace.

## Firewall / network behavior

- **Inbound TCP 24816** (or your `--port`) must be reachable from peers.
  On Fedora: `sudo firewall-cmd --add-port=24816/tcp` (adjust for `--port`).
- **Inbound UDP 24817** must be reachable for discovery; without it, use
  `--peer`.
- **Client isolation** (guest Wi-Fi, AP isolation): blocks both planes —
  use `--peer` with the peer's IP if L3 routing exists, otherwise transfers
  cannot work by design (no relay).
- **VPNs:** the listener binds all interfaces, so a peer on the VPN
  interface can connect if routing/firewall allow; multicast discovery
  typically does not cross VPN tunnels — use `--peer`.

## Unverified (needs Nick's hardware/network)

- Real two-host LAN transfer end-to-end.
- Packet captures (handshake, discovery).
- Multicast behavior across his router/AP (IGMP snooping, isolation).
- Throughput / memory / CPU under load.
- Termux (Android) send/receive.
- Behavior on interface change, sleep/wake, address change.
