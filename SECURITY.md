# Security policy

## Threat model

SyncWeave moves files between machines on a local network. The assumed adversary
is a **hostile LAN peer**: anyone on the same Wi-Fi, Ethernet or VLAN can send UDP
multicast, open TCP connections, and announce any alias or Peer ID they want. We do
not defend against nation-state attackers, physical device access, or a compromised
operating system.

What we guarantee against a hostile LAN peer:

- **Confidentiality.** File contents and metadata sent after the handshake are
  encrypted with Noise_XX (25519 / AES-GCM / SHA-256). A passive eavesdropper on the
  LAN cannot read them.
- **Peer authentication, by people.** Each side derives the same short
  authentication string (SAS) from the handshake. **The sender confirms the SAS
  before any file metadata (names, sizes, count) is sent.** The receiver confirms
  the same SAS on the consent screen before any file bytes flow. The identity proof
  binds each side's Ed25519 key to the Noise session. If the two codes differ, the
  humans must not confirm.
- **No pinning.** SyncWeave stores nothing about peers between runs. Every transfer
  needs its own comparison. A peer that looks familiar is not trusted for that reason.
- **Receiver consent.** No file is written without an explicit accept. The consent
  prompt is withdrawn if the sender disconnects, cancels, or the 60-second window
  passes.
- **Receiver safety.** Filenames are sanitized (no traversal, no control or bidi
  characters, no Windows device names). Files are written to temp files created with
  `O_EXCL` and mode `0600`. Size and SHA-256 are verified before publishing.
  Publishing never overwrites an existing file (`link(2)`). The destination
  picker refuses symlinks, system directories, hidden (dot) directories and
  world-writable directories.
- **Sender check.** The sender reports success only when the receiver acknowledges
  each file, and it compares the acknowledged hash and size with what it sent.
- **Availability.** Handshake, header, body and consent timeouts bound a silent peer.
  Concurrent handshakes are capped (4).

What we do **not** guarantee:

- **Discovery names are claims.** Discovery tells you who is *claiming* an alias, not
  who they are. Anyone can announce any alias and Peer ID. Discovered names are shown
  as "claimed". Compare the security code out of band (in person, over a call) for
  sensitive files.
- **Metadata is visible on the LAN.** Multicast announcements are plaintext by design,
  like LocalSend. They include the alias, the per-run Peer ID, and the TCP port.
  Anyone who can observe your traffic can see that you are running SyncWeave. See
  [docs/privacy.md](docs/privacy.md).
- **Metadata reaches the peer you confirmed.** After the SAS is confirmed, file
  names, sizes and count go to that peer. If the humans do not compare the codes, the
  guarantee above does not hold.
- **Memory before consent is bounded only loosely.** A peer that completes the
  handshake can cause buffering before the receiver answers. Per-connection caps are
  not yet tight enough. See [docs/known-limitations.md](docs/known-limitations.md).
- **Stalls.** A malicious peer can always waste your time (connect and stall until
  a timeout). Timeouts bound the damage; they do not prevent the attempt.
- **Received files are not scanned.** SyncWeave does not check file content. Treat
  received files like any download.

## Reporting a vulnerability

Do not open a public issue for a security bug. Email the maintainer privately (see
the repository owner on GitHub). Include:

1. What you did (steps to reproduce, ideally a script).
2. What you expected and what happened.
3. The commit hash, `bun --version`, and your OS and architecture.

We aim to acknowledge within 72 hours and to ship a fix or a mitigation plan within
14 days. If the bug is in a dependency, we will coordinate upstream as well.

## Supported versions

Only the latest `main` is supported. Version 0.1.0 is a pre-release. No stable
release exists yet, and no release binaries have been published.
