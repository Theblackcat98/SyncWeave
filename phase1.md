# SyncWeave — Phase 1: TUI & UX Foundation

> **Goal:** make SyncWeave feel like a polished product before implementing real networking or synchronization. Everything in this phase is mocked.

## Locked architecture

**OpenTUI + TypeScript is the sole UI stack.** Do not introduce Bubble Tea, Lip Gloss, Ratatui, or another TUI framework. OpenTUI is the native Zig terminal UI core with TypeScript bindings and component/layout primitives. The upstream project also provides its own documentation/agent skill and should be consulted when an unfamiliar API is needed. urlOpenTUI repositoryhttps://github.com/anomalyco/opentui

### Phase 1 stack

- **OpenTUI** — rendering, layout, components, keyboard/mouse input, and animation.
- **TypeScript** — application and UI implementation.
- **Bun** — runtime/package management.
- **Mock services** — fake filesystem, peers, pairing, diffs, and transfers.
- **Real networking/filesystem** — deferred until the UX is approved.

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

## 1. Technology & Project Foundation

- [x] Lock OpenTUI as the sole TUI framework.
- [x] Lock TypeScript as the UI/application language.
- [x] Establish project structure.
- [x] Add `package.json` with OpenTUI.
- [x] Add TypeScript configuration.
- [x] Add Bun development/start scripts.
- [x] Establish `src/main.ts` OpenTUI entry point.
- [ ] Extract dedicated UI component modules.
- [ ] Extract dedicated application-state module.
- [ ] Extract dedicated mock-service modules.
- [ ] Define interfaces separating UI/domain state from future real services.
- [ ] Add automated typecheck/CI validation.
- [ ] Add automated startup/smoke test.

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
- [ ] Extract design tokens into a dedicated theme module.
- [ ] Define typography hierarchy and spacing tokens.
- [ ] Define reusable border/component styles.
- [ ] Define disabled/loading/inactive states.

### Terminal rendering

- [x] Unicode synchronization-state glyphs.
- [x] Nerd Font file icons.
- [ ] ASCII icon fallback.
- [ ] Verify desktop terminal rendering.
- [ ] Verify Termux rendering.
- [ ] Audit Android glyph compatibility.

## 3. Main Application Shell

- [x] Main SyncWeave application frame.
- [x] Header/status bar.
- [x] Central workspace.
- [x] Activity/transfer status area.
- [x] Footer action rail.
- [x] Version display.
- [x] Mock mDNS status.
- [x] Mock peer count.
- [ ] Animated mDNS heartbeat.
- [ ] Dynamic contextual footer actions.
- [ ] Responsive resizing.

## 4. Dual-Pane Workspace

### Local

- [x] Local workspace path.
- [x] Local mock files.
- [x] File icons.
- [x] File sizes.
- [x] Synchronization state.
- [x] Selection state.
- [x] Keyboard navigation.
- [ ] Directory navigation.
- [ ] Scrolling for larger datasets.
- [ ] Mouse/touch selection.

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
- [ ] Animated focus transition.
- [ ] Mouse/touch pane switching.

## 5. Mock Filesystem

- [x] Deterministic local files.
- [x] Deterministic remote files.
- [x] Realistic filenames/paths.
- [x] File sizes and byte counts.
- [x] Synced/added/modified/deleted state model.
- [x] Multiple selectable files.
- [ ] Explicit directory nodes.
- [ ] Directory traversal.
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
- [ ] State legend/help.
- [ ] State transition animations.

## 7. File Selection & Staging

- [x] `Space` selects/deselects focused file.
- [x] Multi-file selection.
- [x] Selection checkmark.
- [x] Staged/unstaged feedback.
- [x] Aggregate selected-file count.
- [x] Prevent sync when nothing is staged.
- [x] Show aggregate selected size in transfer UI.
- [ ] Select all.
- [ ] Deselect all.
- [x] Staged-transfer workflow UI.
- [ ] Explicit pre-transfer confirmation.

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
- [ ] Dedicated mock transfer service module.
- [ ] Failure simulation.
- [ ] Cancellation simulation.
- [ ] Retry simulation.
- [ ] Persistent transfer queue.

## 9. Mock Peer Discovery

**No actual mDNS or rendezvous networking.**

- [x] Mock online peer state displayed.
- [x] Mock peer count displayed.
- [ ] Dedicated peer model/service.
- [ ] Simulated peer appearance/disappearance.
- [ ] Simulated connection establishment/failure.
- [ ] Multiple-peer selection.
- [ ] Peer status animation.

## 10. QR Pairing Workflow

Pairing is still entirely mocked; the current QR is a visual terminal mock rather than a cryptographic QR payload.

- [x] Pairing screen/modal.
- [x] Terminal QR-like visual rendered directly in the TUI.
- [x] Pairing code display.
- [x] Connection method display.
- [x] Authentication-state display.
- [x] Waiting-for-peer state.
- [x] Simulated peer discovery/authentication progression.
- [x] Successful pairing state.
- [x] `Esc` cancellation.
- [ ] Integrate `@opentui/qrcode` for a real encoded QR.
- [ ] Simulate timeout/failure.
- [ ] Simulate retry.
- [ ] Persist paired-peer state.

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
- [ ] Responsive sizing rules.

### Narrow — <90 columns

- [ ] Collapse to single active pane.
- [ ] `[Local] | [Remote]` tabs.
- [ ] Preserve state/selection/actions.
- [ ] Reduce metadata density.

### Very narrow / soft keyboard

- [ ] Detect reduced viewport.
- [ ] Collapse unnecessary headers/breadcrumbs.
- [ ] Preserve file-list height and essential actions.

## 13. Touch & Mouse Interaction

- [ ] OpenTUI mouse handling.
- [ ] Primary-click normalization.
- [ ] Click file rows.
- [ ] Click action controls.
- [ ] Click pane tabs.
- [ ] Click modal controls.
- [ ] Validate Termux touch behavior.
- [x] Keyboard workflow remains fully available.

## 14. Animation System

- [x] Progressive mock-transfer animation.
- [ ] Reusable OpenTUI animation/tick primitives.
- [ ] Pause unnecessary animation while idle.
- [ ] Transfer pulse.
- [ ] Braille sub-cell progress gauge.
- [ ] mDNS heartbeat.
- [ ] Pane focus transition.
- [ ] Modal reveal.
- [ ] Success/failure transitions.
- [ ] Validate idle CPU behavior.

## 15. Modal System

- [x] Pairing modal/screen.
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
- [ ] Dedicated help screen.
- [ ] File-state legend.
- [ ] Peer-state legend.
- [ ] Transfer-state legend.
- [ ] Mobile interaction guidance.
- [ ] First-launch onboarding.

## 17. Complete Mock User Journey

```text
Launch
  ↓
Discover Mock Peer
  ↓
Pair via Mock QR Flow
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
- [x] Open mock pairing experience.
- [x] Open mock diff experience.
- [x] Stage a mock diff hunk.
- [x] Start mock transfer.
- [x] Show transfer progress/speed/ETA.
- [x] Complete transfer and mark staged files synced.
- [ ] Complete real encoded QR rendering.
- [ ] Complete responsive mobile layout.
- [ ] Complete mouse/touch workflow.
- [ ] Complete reusable animation system.

## 18. UX Polish Pass

- [ ] Normalize spacing.
- [ ] Normalize borders.
- [ ] Normalize icons/fallbacks.
- [ ] Normalize state colors.
- [ ] Review keyboard navigation.
- [ ] Review touch interaction.
- [ ] Review responsive layouts.
- [ ] Review empty/loading/error states.
- [ ] Review transitions and animation timing.
- [ ] Reduce visual noise.
- [ ] Ensure visual hierarchy is obvious without documentation.
- [ ] Test desktop terminal.
- [ ] Test Termux.
- [ ] Test narrow portrait layouts.
- [ ] Test light/dark terminal backgrounds.

## 19. Phase 1 Definition of Done

Phase 1 is complete when a user can experience the entire SyncWeave workflow with **zero real networking or synchronization** and the UI is polished enough to become the product's visual contract.

Only after Phase 1 approval should mocks be replaced with:

1. Real filesystem access.
2. Real file comparison.
3. Real mDNS discovery.
4. Real peer identity/authentication.
5. Real QUIC transport.
6. Real chunked transfers.
7. Real synchronization semantics.
8. Real persistence/recovery.

**Principle:** build the experience first; connect the machinery second.