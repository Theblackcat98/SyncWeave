# SyncWeave: Product Architecture, Feature Specification & TUI Design Blueprint

---

## 1. Extracted Core Concept & Technical Architecture

### Product Identity & Core Purpose

* **Concept Name**: SyncWeave
* **Category**: Local-First Peer-to-Peer Data Conduit and Staging Engine
* **Target Audience**: Engineers, sysadmins, and writers who regularly transfer code snippets, dotfiles, database dumps, configs, and notes across desktop workstations, remote servers, and mobile terminals (e.g., Android Termux).

### Problem Space & Incumbent Deficiencies

* **Standard Transfer Overhead**: Legacy tools (`scp`, `sftp`, `rsync`) require pre-configured SSH authentication, known target IP addresses, and cumbersome path syntax that is difficult to type on soft keyboards.
* **Security & Privacy Risks**: Ad-hoc transfers often get funneled through public cloud storage or third-party chat clients.
* **Daemon Overhead**: Background synchronization daemons (e.g., Syncthing) consume continuous background battery and memory, lacking an interactive staging workflow to preview changes before syncing.
* **Single-Shot CLI Limitations**: Modern point-to-point tools (`croc`, `magic-wormhole`) operate as single-shot commands lacking an interactive UI, remote directory browsing, inline diff inspection, or selective multi-file batching.

### Functional Specifications

* **Dual-Pane Interface**: Left panel displays local workspace; right panel displays remote staging/peer filesystem.
* **Peer Discovery & Routing**: Automatic local peer discovery via raw UDP multicast announcements plus a two-way HTTPS register handshake (LocalSend-style — no mDNS/zeroconf); wide-area networking (WAN) via end-to-end encrypted rendezvous relays.
* **State Annotation**: Real-time visual indicators marking files/directories as added, modified, deleted, or identical.
* **Inline Syntax Diffing**: Pressing `d` opens an inline side-by-side diff modal highlighting added and deleted lines.
* **Zero-Config Pairing (LocalSend-Style)**: Devices discover each other on the local network via UDP-multicast announcements and pair through a trust handshake — the receiver confirms the sender, the sender's certificate fingerprint gets pinned, and an optional receiver PIN gates transfers — establishing cryptographic connections without typing keys or scanning anything.
* **Selective Batch Transfers**: Multi-file selection via `[Space]` or touch taps, triggering batch transfers via `[s]`.
* **Transport Engine**: Chunked, multiplexed QUIC or TLS-WebSocket transport layer with Braille-based progress gauges and transfer speed metrics.

### Recommended Tech Stack & Cross-Platform Adaptation

* **Core Framework**: Rust (`Ratatui` + `Tokio`).
* **Networking & Diffing**: `quinn` (QUIC implementation) + `similar` (diff engine).
* **Desktop Workstation Role**: Release staging, pulling remote configs, and comparing project directories across development environments.
* **Termux / Mobile Role**: Eliminates manual path typing and key distribution; enables fast phone-to-workstation file syncing.
* **Mobile Runtime Adaptations**: Event-driven rendering to preserve battery, dynamic layout collapsing for narrow portrait viewports (<80 columns) or soft-keyboard activation, primary touch-click normalization (DECSET 1000/1002 with SGR 1006), and atomic state serialization to withstand Android Low Memory Killer (LMK) events.

---

## 2. Advanced TUI Visual Design, Animation & UX System

### Reference TUI Layout

```text
╭─ SyncWeave v1.0.0 ────────────────── [● LAN Scan: Active] ── [Peers: 2 Online] ─╮
│                                                                                 │
│  LOCAL WORKSPACE (~/projects/notes)          REMOTE STAGING (MacBook-M3: ~/notes)│
│  ╭──────────────────────────────────────╮   ╭──────────────────────────────────╮│
│  │ [✓] 󰈙 architecture-diagram.md  12 KB │   │ [ ] 󰈙 architecture-diagram.md 14K││
│  │ [✓] 󰈙 daily-todo.txt            2 KB │   │ [ ] 󰈙 daily-todo.txt          2K ││
│  │ [ ] 󰒓 configs/termux.properties 1 KB │   │ [ ] 󰒓 configs/termux.proper.. 1K ││
│  │ [ ] 󰡨 build-artifact.tar.gz     45 MB│   │ [ ] 󰡨 release-v1.tar.gz      45M ││
│  ╰──────────────────────────────────────╯   ╰──────────────────────────────────╯│
│                                                                                 │
│  Active Stream: architecture-diagram.md [4 chunks remaining]                    │
│  Progress: ⢄⢂⢁⣀⡠⡐⡐ [██████████████████████░░░░░░░░] 68% • 14.2 MB/s • 0.4s ETA     │
│                                                                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [Space] Toggle Select  │ [s] Sync Staged  │ [d] View Diff │ [p] Pair │ [?] Help │
╰─────────────────────────────────────────────────────────────────────────────────╯
```

### A. Color Palette & Typography Hierarchy

* **Color System (24-bit TrueColor)**:
  * **Backgrounds**: Deep Charcoal (`#12131C`) for default viewport; Elevated Slate (`#1E1E2E`) for modals and sidebars.
  * **Accents & Brand**: Electric Cyan (`#38BDF8`) for active focus rings and selection pointers; Violet/Purple (`#A855F7`) for remote peer headers.
  * **File Diff States**:
    * Added / New: Mint Green (`#4ADE80` / `+`)
    * Modified / Diverged: Amber Gold (`#FBBF24` / `~`)
    * Deleted / Missing: Coral Red (`#F87171` / `-`)
    * Synced / Identical: Muted Steel (`#64748B` / `•`)
* **Glyphs & Unicode Primitives**:
  * Utilize smooth rounded corners (`╭`, `╮`, `╯`, `╰`) for window frames.
  * Nerd Font filetype icons (`󰈙` text, `󰒓` config, `󰡨` archive) with automatic ASCII fallback (`[F]`, `[C]`, `[A]`) when Nerd Fonts are disabled.

---

### B. Micro-Animations & Dynamic Visual Indicators

All animations must operate on an event-driven tick loop that pauses completely when the interface is idle to prevent CPU and battery drain.

1. **QUIC Packet Stream Wave**:
   * While transferring, render a 3-frame directional pulse glyph next to the active task (e.g., `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` or `···>···` shifting left to right across the pane divider).
2. **Braille Sub-Cell Progress Gauges**:
   * Instead of standard whole-character jump bars (`[###   ]`), implement high-resolution Braille dot fill (`⣀⣄⣤⣦⣶⣷⣿`) providing 8 vertical subdivisions per character column for smooth sub-percentage rendering.
3. **P2P Heartbeat Radar**:
   * In the top-right peer status bar, display an alternating pulse (`[● LAN]` ➔ `[○ LAN]`) cycling on a slow 2-second interval to visually signal active discovery announcements and peer keepalive checks without cluttering the screen.
4. **Modal Reveal & Focus Transitions**:
   * Fast 2-frame border highlight: When switching panes (`Tab`), flash the focused container's border from dim gray to white before settling on Electric Cyan.

---

### C. Context-Guiding UX & Interactive Workflows

#### 1. Onboarding & Zero-Config Pairing (LocalSend-Style)

Pairing follows LocalSend's open model: devices find each other on the local
network by themselves, then build trust with a short handshake over
certificate fingerprints — no camera, nothing to scan or type.

* **Initial State**: If no paired peers are found, SyncWeave automatically opens the
  **Nearby Devices** overlay: a live list of discovered peers (alias, device model,
  short fingerprint) that fills as announcements arrive, with a scanning indicator
  while the network is probed.

The pairing sequence, step by step:

1. **Identity**: On first launch each device generates a self-signed TLS certificate
   and keeps it for life. The uppercase-hex SHA-256 of that certificate is the device's
   **fingerprint** — its one true identity. Fingerprints, never IP addresses, are what
   is displayed, compared, and trusted.
2. **Discovery**: Each device binds a fixed UDP port, joins a multicast group, and
   announces itself as a small JSON datagram (alias, model, fingerprint, port), sent as
   a rapid burst to survive packet loss — plain UDP multicast, deliberately *not*
   mDNS/zeroconf. A device that hears an announcement answers over HTTPS (not UDP) by
   `POST`-ing its own device info back to the announcer, so discovery is two-way and
   both Nearby lists fill within a second. Networks that block multicast fall back to
   a subnet sweep of direct `POST /register` probes; already-paired peers are probed
   at their remembered address first.
3. **Pick a peer (first contact — trust on first use)**: The sender highlights a device
   in the Nearby list and presses `[Enter]`. During this very first contact the peer's
   certificate is accepted sight-unseen so the handshake can complete — nothing is
   trusted implicitly, because the human is the trust anchor on both sides (step 4).
4. **Confirm on the receiver**: The receiving device pops a modal naming the sender
   ("`MacBook-M3` wants to pair and send files — Accept?"). The session exists only
   after the receiver accepts, and every later incoming transfer meets the same
   accept prompt.
5. **Verify visually (optional)**: On a hostile network — or on first contact, where
   no fingerprint is pinned yet — both screens can display the same short verification
   sequence derived from the two fingerprints (sorted, joined, SHA-256 → a row of
   glyphs or hex groups). Matching screens mean no impostor sits in the middle.
6. **Stay paired (fingerprint pinning)**: An accepted peer is saved as a favorite
   (`fingerprint, ip, port, alias`). Every later session pins the TLS handshake to the
   remembered fingerprint: a mismatched certificate aborts the handshake before any
   metadata or file bytes move, so a previously paired device cannot be impersonated
   even if an attacker takes over its old IP. Hostnames are ignored — peers are
   addressed by IP and identified by fingerprint.
7. **Optional receiver PIN**: The receiver may set a PIN that gates incoming transfer
   sessions. A wrong PIN answers `401`; after three failures from one IP, that IP is
   throttled with `429`. The PIN is a capability gate only and never derives keys —
   confidentiality lives in TLS, identity lives in the pinned fingerprint.

```text
╭─ Nearby Devices ─────────────────────────────────────────────────────╮
│                                                                      │
│   ●  MacBook-M3          a3f2…9c41     ◇ new peer — not paired yet   │
│   ○  Pixel-8-Termux      7b90…e2d3     ♥ paired (fingerprint pinned) │
│   ◌  scanning LAN…                                                   │
│                                                                      │
│   Pairing with MacBook-M3                                            │
│   State : Waiting for receiver confirmation…                         │
│   Verify: ▲ ◆ ● ■ ★ ▲ ◆ ●   ← identical on both screens              │
│   PIN   : ____   (only if the receiver set one)                      │
│                                                                      │
│         [Enter] Pair      [v] Verify      [Esc] Cancel               │
│                                                                      │
╰──────────────────────────────────────────────────────────────────────╯
```

#### 2. Visual Split-Diff Inspector (`[d]`)

* Pressing `d` on any modified file opens a fullscreen or split modal showing syntax-highlighted side-by-side line diffs powered by the `similar` crate.
* **Diff Navigation**: Arrow keys scroll synchronously across both files; pressing `[Tab]` jumps directly between change hunks; `[Enter]` stages only the selected hunk for syncing.

#### 3. Responsive Breakpoint Transitions (Termux & Mobile Portrait)

* **Desktop / Wide Viewport (≥ 90 cols)**: Full dual-pane view (Local on left, Remote on right) with synchronized navigation.
* **Mobile / Split Viewport (< 90 cols)**:
  * Automatically collapses the dual pane into a single pane with top tabs: `[Local (4)] | [Remote (MacBook)]`.
  * Mobile users swipe horizontally or tap tabs to switch contexts.
  * Tapping any file row toggles its selection checkbox (`[✓]`).
  * On-screen keyboard detection immediately collapses metadata headers and breadcrumb bars, preserving the full vertical height for file listings.

#### 4. Friction-Free Actions & Touch Normalization

* **Primary Click Binding**: Mouse and touch taps directly trigger line selection, button presses, and tab switches without requiring arrow key navigation.
* **Footer Action Rail**: Clean, color-coded bottom action tags (`[Space] Mark`, `[s] Sync`, `[d] Diff`, `[?] Help`) provide clear discoverability for desktop keyboard shortcuts while remaining tap-clickable on mobile touchscreens.
