# Security policy

## Threat model

SyncWeave moves files between machines on a local network. The assumed
adversary is a **hostile LAN peer**: anyone on the same Wi-Fi, Ethernet, or
VLAN can send UDP multicast, open TCP connections, and announce any alias or
Peer ID they want. We do not defend against nation-state attackers, physical
device access, or a compromised operating system.

What we guarantee against a hostile LAN peer:

- **Confidentiality:** file contents are encrypted with Noise_XX
  (25519 / AES-GCM / SHA-256). A passive eavesdropper learns nothing about
  file contents.
- **Peer authentication:** the receiver's identity is bound to the Noise
  session via an Ed25519 proof, and the sender confirms a short
  authentication string (SAS) with the human on the other side before any
  file metadata is sent. Discovery announcements are *unauthenticated* —
  an alias you see may be claimed by an attacker.
- **Receiver safety:** filenames are sanitized (no traversal, no control or
  bidi characters), files are written to temp files with mode 0600,
  size and SHA-256 are verified before publishing, publishing never
  overwrites an existing file and never follows symlinks.
- **Availability:** handshake and frame timeouts bound a silent peer;
  handshakes run concurrently with a cap; inbound buffering has backpressure
  and a hard cap.

What we do **not** guarantee:

- Discovery tells you who is *claiming* an alias, not who they are.
  Confirm the SAS out of band (in person, over a call) for sensitive files.
- Metadata (file names, sizes, count) is visible to the receiver before
  they accept, and to anyone who can observe that you are running SyncWeave
  (multicast announcements are plaintext by design, like LocalSend).
- A malicious peer can always waste your time (connect and stall until the
  timeout). Timeouts bound the damage; they don't prevent the attempt.

## Reporting a vulnerability

Do not open a public issue for a security bug. Email the maintainer
privately (see the repo owner on GitHub). Include:

1. What you did (steps to reproduce, ideally a script).
2. What you expected vs. what happened.
3. The commit hash and `bun --version`.

We aim to acknowledge within 72 hours and to ship a fix or a mitigation
plan within 14 days. If the bug is in a dependency, we will coordinate
upstream as well.

## Supported versions

Only the latest `main` is supported. There are no stable releases yet.
