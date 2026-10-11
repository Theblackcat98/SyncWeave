# SyncWeave — Phase 1: TUI & UX Foundation

> **Goal:** make SyncWeave feel like a polished product before implementing real networking or synchronization. Everything in this phase is mocked.

## Locked architecture

**OpenTUI + TypeScript is the sole UI stack.** Do not introduce Bubble Tea, Lip Gloss, Ratatui, or another TUI framework. OpenTUI is the native Zig terminal UI core with TypeScript bindings and component/layout primitives. The upstream project also provides its own documentation/agent skill and should be consulted when an unfamiliar API is needed. urlOpenTUI repositoryhttps://github.com/anomalyco/opentui

### Phase 1 stack

- **OpenTUI** — rendering, layout, components, keyboard/mouse input, and animation.
- **TypeScript** — application and UI implementation.
- **Bun** — runtime/package management.
- **Mock services** — fake filesystem, peer discovery, identity/verification, remembered destinations, transfer requests/consent, diffs, and transfers.
- **Real networking/filesystem and any real pairing protocol** — deferred until the Phase 1 UX is approved and the security model is specified.

```text
                    SyncWeave
                       │
              ┌────────┴────────┐
              │ Application Core │
              │                 │
              │ State Machine   │
              │ Mock Filesystem │
              │ Mock Peers      │
              │ Mock Transfers  │
              └────────┬────────┘
                       │
                 UI View Model
                       │
                 ┌─────┴─────┐
                 │  OpenTUI  │
                 │ Layout    │
                 │ Rendering │
                 │ Input     │
                 │ Animation │
                 └───────────┘
```

## LocalSend reference — protocol and UX, not a Phase 1 implementation requirement

Checked October 10, 2026 against the [LocalSend v2.2 protocol](https://github.com/localsend/protocol) and app source at [commit `14f3a87`](https://github.com/localsend/localsend/commit/14f3a87426eedffaa9d87d011132eca5501abeb8).

- **Normal app-to-app transfer:** direct over the local network; UDP multicast discovery defaults to `224.0.0.167:53317`, with HTTP/TCP subnet scanning as a fallback. The receiver hosts the HTTP API (default TCP port `53317`, configurable). The sender first submits file metadata; the receiver can accept everything, accept a subset, or decline. Only after acceptance does the sender stream accepted file bytes to the receiver. This is a receiver-hosted upload flow, not a cloud relay or a QUIC protocol.
- **Receiver role and request UI:** the receiver’s local server owns request admission and session state; the app asks the user to accept or decline, choose a destination, and apply per-file options such as skipping or renaming. Progress, cancellation, and history are separate UI states.
- **Security:** HTTPS with self-signed certificates and SHA-256 certificate fingerprints is the default identity/pinning model, but LocalSend also offers HTTP-only mode. Do not describe encryption as an invariant unless SyncWeave’s own implementation requires it.
- **Verification, Favorites, and consent are different:** LocalSend’s Verify screen supports a manual fingerprint comparison and does not save a persistent “verified” state. A Favorite is a local saved record (fingerprint, IP, port, alias), not a negotiated or mutual pairing. Optional Quick Save can automatically accept transfers from Favorites, but ordinary transfer acceptance remains a separate receiver decision.
- **Screens and alternate paths:** Receive, Send, and Settings are distinct areas. Browser “share via link” uses a separate HTTP download path with a QR code; it is not the normal encrypted app-to-app upload path or a pairing handshake.
- **Version caveat:** the protocol repository includes v3 diagrams proposing signed-key pairing, but the inspected app’s normal route is v2 and its v3 handler is not wired. WebRTC code is present but explicitly disabled in the app. Do not treat the v3 diagrams or WebRTC code as shipped behavior.

**Phase 1 consequence:** the current QR/pairing-like interaction may remain a mock UI, but it must not claim that scanning a QR, comparing a fingerprint, or saving a Favorite establishes cryptographic trust. Keep any future SyncWeave pairing protocol as a separate design decision (key exchange, user confirmation, persistence, revocation, and whether it changes per-transfer consent). LocalSend is a UX/protocol reference, not a mandate to copy its transport.

Primary source links: [v2 receiving routes](https://github.com/localsend/localsend/blob/14f3a87426eedffaa9d87d011132eca5501abeb8/packages/core/src/http/server/v2.rs), [manual Verify screen](https://github.com/localsend/localsend/blob/14f3a87426eedffaa9d87d011132eca5501abeb8/app/lib/pages/verify_page.dart), [Favorite data model](https://github.com/localsend/localsend/blob/14f3a87426eedffaa9d87d011132eca5501abeb8/app/lib/model/persistence/favorite_device.dart), [v3 flow diagram](https://github.com/localsend/protocol/blob/main/v3/http-diagram.mermaid), [WebRTC provider and disabled flag](https://github.com/localsend/localsend/blob/14f3a87426eedffaa9d87d011132eca5501abeb8/app/lib/provider/network/webrtc/signaling_provider.dart).

## 1. Technology & Project Foundation

- [x] Lock OpenTUI as the sole TUI framework.
- [x] Lock TypeScript as the UI/application language.
- [x] Establish project structure.
- [x] Add `package.json` with OpenTUI.
- [x] Add TypeScript configuration.
- [x] Add Bun development/start scripts.
- [x] Establish `src/main.ts` OpenTUI entry point.
- [x] Extract dedicated UI component modules.
- [x] Extract dedicated application-state module.
- [x] Extract dedicated mock-service modules.
- [x] Define interfaces separating UI/domain state from future real services.
- [x] Add automated typecheck/CI validation.
- [x] Add automated startup/smoke test.

Explicitly excluded:

- [x] Bubble Tea — not used.
- [x] Lip Gloss — not used.
- [x] Ratatui — not used.
- [x] Real networking — deferred.
- [x] Real synchronization — deferred.

## 2. Visual Design System

### Theme

- [x] Deep Charcoal background `#12131C`.
- [x] Elevated Slate surface `#1E1E2E`.
- [x] Electric Cyan focus `#38BDF8`.
- [x] Violet remote accent `#A855F7`.
- [x] Mint success `#4ADE80`.
- [x] Amber modified `#FBBF24`.
- [x] Coral deleted/error `#F87171`.
- [x] Muted synchronized state `#64748B` / `#94A3B8`.
- [x] Focused-row treatment.
- [x] Extract design tokens into a dedicated theme module.
- [x] Define typography hierarchy and spacing tokens.
- [x] Define reusable border/component styles.
- [x] Define disabled/loading/inactive states.

### Terminal rendering

- [x] Unicode synchronization-state glyphs.
- [x] Nerd Font file icons.
- [x] ASCII icon fallback.
- [x] Verify desktop terminal rendering.
- [ ] Verify Termux rendering.
- [ ] Audit Android glyph compatibility.

## 3. Main Application Shell

- [x] Main SyncWeave application frame.
- [x] Header/status bar.
- [x] Central workspace.
- [x] Activity/transfer status area.
- [x] Footer action rail.
- [x] Version display.
- [x] Mock discovery status.
- [x] Mock peer count.
- [x] Animated discovery heartbeat.
- [x] Dynamic contextual footer actions.
- [x] Responsive resizing.

## 4. Dual-Pane Workspace

### Local

- [x] Local workspace path.
- [x] Local mock files.
- [x] File icons.
- [x] File sizes.
- [x] Synchronization state.
- [x] Selection state.
- [x] Keyboard navigation.
- [x] Directory navigation.
- [x] Scrolling for larger datasets.
- [x] Mouse/touch selection.

### Remote

- [x] Remote peer name.
- [x] Remote path.
- [x] Remote mock filesystem.
- [x] Remote metadata.
- [x] Remote visual distinction.
- [x] Independent cursor state.

### Pane interaction

- [x] Pane focus.
- [x] `Tab` pane switching.
- [x] Focused-pane border treatment.
- [x] Independent pane selection.
- [x] Animated focus transition.
- [x] Mouse/touch pane switching.

## 5. Mock Filesystem

- [x] Deterministic local files.
- [x] Deterministic remote files.
- [x] Realistic filenames/paths.
- [x] File sizes and byte counts.
- [x] Synced/added/modified/deleted state model.
- [x] Multiple selectable files.
- [x] Explicit directory nodes.
- [x] Directory traversal.
- [ ] Rich metadata.
- [ ] Configurable mock scenarios.

Current scenario:

```text
~/projects/notes/
├── architecture-diagram.md
├── daily-todo.txt
├── configs/
└── build-artifact.tar.gz
```

## 6. Synchronization State Visualization

- [x] Synced state.
- [x] Added state.
- [x] Modified/diverged state.
- [x] Deleted state type.
- [x] State glyphs.
- [x] Semantic state colors.
- [x] State displayed directly in rows.
- [ ] Conflict state.
- [x] State legend/help.
- [ ] State transition animations.

## 7. File Selection & Staging

- [x] `Space` selects/deselects focused file.
- [x] Multi-file selection.
- [x] Selection checkmark.
- [x] Staged/unstaged feedback.
- [x] Aggregate selected-file count.
- [x] Prevent sync when nothing is staged.
- [x] Show aggregate selected size in transfer UI.
- [x] Select all.
- [x] Deselect all.
- [x] Staged-transfer workflow UI.
- [x] Explicit pre-transfer confirmation.

## 8. Mock Transfer Experience

**No real network transfer is implemented.**

- [x] Mock transfer state machine: idle → transferring → complete.
- [x] Transfer screen/modal.
- [x] Simulated progress.
- [x] Simulated chunk progression display.
- [x] Simulated speed.
- [x] Simulated ETA.
- [x] Multiple selected files represented in transfer summary.
- [x] Completion state.
- [x] Workspace state updated after completion.
- [x] Animated/progressive transfer gauge.
- [x] Mock incoming request with sender and file summary.
- [x] Mock accept-all, accept-subset, and decline choices before progress starts.
- [x] Mock destination selection and per-file skip/rename options.
- [x] Keep per-transfer consent visibly separate from identity verification and Favorites.
- [x] Dedicated mock transfer service module.
- [x] Failure simulation.
- [x] Cancellation simulation.
- [x] Retry simulation.
- [ ] Persistent transfer queue.

## 9. Mock Peer Discovery

**No actual LAN discovery or rendezvous networking.**

For a future real discovery phase, LocalSend provides an example of UDP multicast discovery plus a TCP/HTTP register step and a subnet-scan/manual-address fallback. Discovery is not device pairing or transfer consent, and LocalSend’s defaults are a reference rather than a locked SyncWeave choice.

- [x] Mock online peer state displayed.
- [x] Mock peer count displayed.
- [x] Dedicated peer model/service.
- [x] Simulated peer appearance/disappearance.
- [ ] Simulated connection establishment/failure.
- [x] Multiple-peer selection.
- [x] Peer status animation.

## 10. Mock Peer Setup & Identity UX — no pairing protocol

The existing QR/pairing-like experience is entirely simulated: its QR is not an encoded invitation, and its code, authentication, and success states do not create a connection or trusted-peer record. LocalSend’s manual fingerprint Verify flow and local Favorites are not a pairing handshake; transfer acceptance remains a separate receiver decision (see the reference findings above).

- [x] Existing peer-setup/pairing-like screen and `Esc` cancellation (visual mock only).
- [x] Mock QR-like visual and code display (not scannable or a cryptographic identity proof).
- [x] Mock connection-method and authentication-state labels (no authentication is performed).
- [x] Simulated waiting/discovery progression without real networking.
- [x] Reword the mock success state so it does not claim that a cryptographic pair or trusted relationship was created.
- [x] Mock identity verification as a manual comparison, without persisting a “verified” state.
- [x] If Favorites are shown, present them as locally remembered destinations, distinct from verified or paired trust.
- [x] Simulate timeout/failure and retry states.
- [ ] Decide whether SyncWeave needs persistent pairing only in a later protocol/security design; define exchange, confirmation, storage, revocation, and consent semantics before implementing it.

## 11. Diff Inspector

- [x] `d` opens an actual diff screen for modified files.
- [x] Side-by-side mock diff content.
- [x] Line numbers/change markers.
- [x] Added lines.
- [x] Removed lines.
- [x] Modified sections.
- [x] Hunk navigation placeholder with `Tab`.
- [x] Mock hunk staging with `Enter`.
- [x] `Esc` dismissal.
- [ ] Real diff engine integration.
- [ ] Syntax highlighting.
- [ ] Synchronized scrolling.
- [ ] Multiple-hunk selection model.

## 12. Responsive / Mobile UX

### Wide — ≥90 columns

- [x] Dual-pane desktop target.
- [ ] Full metadata/breadcrumb treatment.
- [x] Responsive sizing rules.

### Narrow — <90 columns

- [x] Collapse to single active pane.
- [x] `[Local] | [Remote]` tabs.
- [x] Preserve state/selection/actions.
- [x] Reduce metadata density.

### Very narrow / soft keyboard

- [x] Detect reduced viewport.
- [x] Collapse unnecessary headers/breadcrumbs.
- [x] Preserve file-list height and essential actions.

## 13. Touch & Mouse Interaction

- [x] OpenTUI mouse handling.
- [x] Primary-click normalization.
- [x] Click file rows.
- [x] Click action controls.
- [x] Click pane tabs.
- [x] Click modal controls.
- [ ] Validate Termux touch behavior.
- [x] Keyboard workflow remains fully available.

## 14. Animation System

- [x] Progressive mock-transfer animation.
- [x] Reusable OpenTUI animation/tick primitives.
- [x] Pause unnecessary animation while idle.
- [x] Transfer pulse.
- [x] Braille sub-cell progress gauge.
- [x] Mock discovery heartbeat animation (no multicast or networking).
- [x] Pane focus transition.
- [x] Modal reveal.
- [ ] Success/failure transitions.
- [ ] Validate idle CPU behavior.

## 15. Modal System

- [x] Mock peer-setup/pairing-like modal/screen (visual only; no trust handshake).
- [x] Diff modal/screen.
- [x] Transfer details modal/screen.
- [ ] Help modal.
- [ ] Confirmation modal.
- [ ] Error modal.
- [ ] Peer selection modal.
- [ ] Shared modal sizing/borders/focus behavior.
- [x] Keyboard dismissal for implemented screens.
- [ ] Mouse/touch dismissal.

## 16. Help & Discoverability

- [x] Footer shortcut guidance.
- [x] Basic `?` contextual status guidance.
- [x] Dedicated help screen.
- [x] File-state legend.
- [x] Peer-state legend.
- [x] Transfer-state legend.
- [x] Mobile interaction guidance.
- [ ] First-launch onboarding.

## 17. Complete Mock User Journey

```text
  Launch
  ↓
Discover Mock Peer
  ↓
View Mock Peer Setup / Identity UX (no real handshake)
  ↓
Connected Workspace
  ↓
Browse Local / Remote Files
  ↓
Inspect Differences
  ↓
Select Files / Hunks
  ↓
  Stage Changes
  ↓
Review Transfer
  ↓
Mock Receiver Accepts All / Subset / Declines
  ↓
Start Mock Sync
  ↓
Watch Animated Transfer
  ↓
Transfer Completes
  ↓
Workspace Updates
  ↓
Files Become "Synced"
```

### Progress

- [x] Launch application shell.
- [x] Show mock peer/discovery status.
- [x] Show local and remote workspaces.
- [x] Navigate both panes.
- [x] Switch panes with `Tab`.
- [x] Select files with `Space`.
- [x] Show synchronization states.
- [x] Open mock peer-setup/identity experience (simulated only; no trusted pair).
- [x] Open mock diff experience.
- [x] Stage a mock diff hunk.
- [x] Start mock transfer.
- [x] Show transfer progress/speed/ETA.
- [x] Complete transfer and mark staged files synced.
- [x] Label peer setup/identity flows unambiguously as mocked; do not imply a trusted pair.
- [x] Complete mock incoming-transfer review and accept-all/subset/decline flow.
- [x] Complete responsive mobile layout.
- [x] Complete mouse/touch workflow.
- [x] Complete reusable animation system.

## 18. UX Polish Pass

- [x] Normalize spacing.
- [x] Normalize borders.
- [x] Normalize icons/fallbacks.
- [x] Normalize state colors.
- [x] Review keyboard navigation.
- [x] Review touch interaction.
- [x] Review responsive layouts.
- [x] Review empty/loading/error states.
- [x] Review transitions and animation timing.
- [x] Reduce visual noise.
- [x] Ensure visual hierarchy is obvious without documentation.
- [x] Test desktop terminal.
- [ ] Test Termux.
- [x] Test narrow portrait layouts.
- [ ] Test light/dark terminal backgrounds.

## 19. Phase 1 Definition of Done

Phase 1 is complete when a user can experience the entire SyncWeave workflow with **zero real networking or synchronization** and the UI is polished enough to become the product's visual contract.

Only after Phase 1 approval should mocks be replaced with:

1. Real filesystem access.
2. Real file comparison.
3. Choose and document LAN discovery (LocalSend’s UDP multicast + HTTP register is one reference, not a pairing flow).
4. Define peer identity, authentication, and any persistent pairing/trust semantics separately.
5. Measure transport options; LocalSend’s normal app-to-app path streams directly over HTTP(S)/TCP, so QUIC is not assumed.
6. Real chunked transfers.
7. Real synchronization semantics.
8. Real persistence/recovery.

**Principle:** build the experience first; connect the machinery second.

## Implementation and validation status

The Phase 1 workflow is implemented as a **deterministic, in-memory simulation** using page-based screens rather than modal overlays. The screens model request review, receiver consent, subset/rename/destination options, and accepted-transfer progress; help, confirmation, error, and peer-selection overlay dialogs are not implemented. These screens do not implement LocalSend v2 or any other network transport. No UDP multicast, receiver HTTP(S)/TCP listener, real file access or byte streaming, QUIC, pairing protocol, trust persistence, synchronization, or cross-session transfer history is present. Local Favorites and queue records reset with the process.

Validation performed with Bun 1.4.3: frozen-lockfile install, TypeScript typecheck, 16 automated tests (keyboard, mouse, wide/narrow/portrait UI, consent, completion, failure/retry, identity/Favorites, animation clock, and ASCII icons), dedicated headless smoke script, and a live terminal launch/clean Ctrl+C exit. Headless layouts were inspected at 120x36, 72x24, 48x24, and 44x32.

Manual validation still needed on Termux/physical Android touch input and broader Android font coverage. Light-terminal themes and idle CPU measurements were not validated. Intentionally deferred checklist items—including real discovery/transport, pairing/security design, rich metadata, conflict detection, real diffing, onboarding, and cross-session persistence—remain unchecked.
