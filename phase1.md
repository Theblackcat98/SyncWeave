# SyncWeave — Phase 1: TUI & UX Foundation

> **Phase 1 objective:** Build and refine the complete SyncWeave visual system and user workflow before implementing real networking or filesystem synchronization.

For this phase, all networking, peer discovery, authentication, file comparison, and transfers are mocked/faked. The goal is to make the application feel correct before connecting it to real infrastructure.

## 0. Locked Architecture Decision

**OpenTUI + TypeScript is the sole UI foundation for SyncWeave.**

Do not introduce Bubble Tea, Lip Gloss, Ratatui, or another TUI framework into the SyncWeave UI implementation. The application and mock-service architecture must remain renderer-independent enough that real filesystem/network implementations can replace the mocks later without requiring a UI rewrite.

### Phase 1 stack

- **OpenTUI** — terminal rendering, layout, components, input, scrolling, and UI interaction.
- **TypeScript** — application and UI implementation.
- **Mock domain/services** — fake filesystem, peers, pairing, diffs, and transfers.
- **Real networking/filesystem** — explicitly deferred until the Phase 1 UX is approved.

### Architectural boundary

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
                 │           │
                 │ Layout    │
                 │ Rendering │
                 │ Input     │
                 │ Animation │
                 └───────────┘
```

The UI should consume application state rather than reaching directly into mock services. Later, real filesystem and networking implementations can satisfy the same domain/service interfaces.

---

## 1. Technology & UI Foundation

- [x] Lock OpenTUI as the sole TUI framework.
- [x] Lock TypeScript as the UI/application implementation language.
- [ ] Establish the initial OpenTUI project structure.
- [ ] Define a clean separation between:
  - UI components
  - Application state
  - User interactions
  - Mock services
  - Future filesystem/network services
- [ ] Establish a central application state model that can eventually accommodate real peers, files, transfers, and synchronization state.
- [ ] Ensure the UI architecture does not require rewriting the interface when mocked services are replaced with real implementations.
- [ ] Establish initial development/build/run commands.
- [ ] Add a minimal smoke test or startup validation.

### Explicitly excluded

- [x] Bubble Tea — **not used**.
- [x] Lip Gloss — **not used**.
- [x] Ratatui — **not used**.
- [x] Real networking — **deferred**.
- [x] Real filesystem synchronization — **deferred**.

---

## 2. Visual Design System

### Color & Theme

- [ ] Implement the SyncWeave color palette.
- [ ] Define semantic colors rather than hard-coding colors throughout components.
- [ ] Implement:
  - [ ] Background
  - [ ] Elevated surfaces
  - [ ] Primary accent
  - [ ] Remote/peer accent
  - [ ] Success
  - [ ] Warning / modified
  - [ ] Error / deleted
  - [ ] Muted / synchronized
  - [ ] Focused state
- [ ] Define typography hierarchy.
- [ ] Define consistent spacing/padding rules.
- [ ] Define border styles and panel treatments.
- [ ] Define selected, focused, disabled, loading, and inactive states.
- [ ] Create a reusable component/style vocabulary.

### Terminal Rendering

- [ ] Implement rounded SyncWeave panel borders.
- [ ] Implement Unicode glyph support.
- [ ] Implement Nerd Font icons where available.
- [ ] Implement ASCII fallback icons.
- [ ] Verify rendering in standard terminal environments.
- [ ] Test rendering in Termux.
- [ ] Test rendering at different terminal widths.
- [ ] Avoid relying on glyphs that render incorrectly on common Android fonts.

---

## 3. Main Application Shell

- [ ] Build the main SyncWeave application frame.
- [ ] Implement the top status/header bar.
- [ ] Implement the central workspace.
- [ ] Implement the bottom action rail.
- [ ] Implement responsive resizing.
- [ ] Ensure the entire interface can be navigated without a mouse.
- [ ] Ensure important actions can also be triggered through touch/click interaction where supported.

### Header

- [ ] Display SyncWeave version.
- [ ] Display local connection/discovery status.
- [ ] Display peer count.
- [ ] Display connection/activity indicator.
- [ ] Implement the mDNS heartbeat visual as a **mock status indicator**.
- [ ] Make connection status visually understandable without relying exclusively on text.

### Footer

- [ ] Implement contextual keyboard shortcuts.
- [ ] Display available actions based on current application state.
- [ ] Make action labels visually distinct.
- [ ] Ensure footer actions correspond to actual interactive handlers.
- [ ] Support:
  - [ ] Select
  - [ ] Sync
  - [ ] Diff
  - [ ] QR / Pair
  - [ ] Help
  - [ ] Cancel / Back where appropriate

---

## 4. Dual-Pane Workspace

Build the primary SyncWeave experience around the dual-pane filesystem interface.

### Local Pane

- [ ] Display local workspace name/path.
- [ ] Display files and directories.
- [ ] Display file icons.
- [ ] Display file sizes.
- [ ] Display synchronization state.
- [ ] Display selection state.
- [ ] Implement keyboard navigation.
- [ ] Implement mouse/touch selection where supported.
- [ ] Implement scrolling.
- [ ] Implement directory navigation.

### Remote Pane

- [ ] Display remote peer name.
- [ ] Display remote path.
- [ ] Display remote filesystem.
- [ ] Display remote file metadata.
- [ ] Implement the same navigation model as the local pane.
- [ ] Visually distinguish remote state from local state.

### Pane Interaction

- [ ] Implement pane focus.
- [ ] Implement `Tab` pane switching.
- [ ] Implement focused border animation.
- [ ] Implement synchronized navigation where appropriate.
- [ ] Make the currently active pane unmistakable.
- [ ] Implement selection independent of focus.
- [ ] Test keyboard navigation thoroughly.

---

## 5. Mock Filesystem

Before implementing real filesystem/network functionality, create a deterministic fake filesystem.

- [ ] Create mock local files.
- [ ] Create mock remote files.
- [ ] Support directories.
- [ ] Support file metadata.
- [ ] Support different file sizes.
- [ ] Support file states:
  - [ ] Identical
  - [ ] Added
  - [ ] Modified
  - [ ] Deleted
  - [ ] Conflict
- [ ] Allow navigation through the mock filesystem.
- [ ] Allow selection of files.
- [ ] Allow multiple files to be staged.
- [ ] Make the mock data sufficiently realistic to exercise the UI.

Example mock workspace:

```text
~/projects/notes/

├── architecture-diagram.md
├── daily-todo.txt
├── README.md
├── configs/
│   ├── termux.properties
│   └── shell.conf
└── build-artifact.tar.gz
```

---

## 6. Synchronization State Visualization

Build the visual language for synchronization before implementing synchronization itself.

- [ ] Implement identical/synced state.
- [ ] Implement added state.
- [ ] Implement modified state.
- [ ] Implement deleted state.
- [ ] Implement conflict state.
- [ ] Define consistent icons for each state.
- [ ] Define consistent colors for each state.
- [ ] Define state transitions.
- [ ] Ensure states remain understandable without color.
- [ ] Add contextual explanations through help/tooltips where appropriate.

---

## 7. File Selection & Staging Workflow

Build the complete staging experience using mock data.

- [ ] Implement `Space` to select/deselect files.
- [ ] Implement multi-file selection.
- [ ] Implement select all.
- [ ] Implement deselect all.
- [ ] Visually distinguish:
  - Focused
  - Selected
  - Modified
  - Staged
- [ ] Create a staged-transfer summary.
- [ ] Show the number of files selected.
- [ ] Show aggregate transfer size.
- [ ] Prevent accidental synchronization when nothing is selected.
- [ ] Create confirmation UX where appropriate.

---

## 8. Mock Transfer Experience

**No real network transfer yet.**

Create a convincing simulated transfer engine.

- [ ] Create fake transfer jobs.
- [ ] Simulate transfer initialization.
- [ ] Simulate chunk progression.
- [ ] Simulate transfer speed.
- [ ] Simulate ETA.
- [ ] Simulate multiple files transferring.
- [ ] Simulate completion.
- [ ] Simulate failure.
- [ ] Simulate cancellation.
- [ ] Simulate retry.
- [ ] Simulate concurrent transfers.
- [ ] Keep the simulation deterministic enough for UI testing.

### Transfer Visualization

- [ ] Implement progress percentage.
- [ ] Implement Braille progress visualization.
- [ ] Implement transfer speed.
- [ ] Implement ETA.
- [ ] Display active filename.
- [ ] Display chunk information.
- [ ] Implement transfer activity animation.
- [ ] Implement completed-transfer state.
- [ ] Implement failed-transfer state.
- [ ] Implement cancellation state.

---

## 9. Transfer Queue

Create a dedicated conceptual model for transfers.

- [ ] Implement queued state.
- [ ] Implement active state.
- [ ] Implement completed state.
- [ ] Implement failed state.
- [ ] Implement cancelled state.
- [ ] Display multiple queued transfers.
- [ ] Allow users to inspect the queue.
- [ ] Allow cancellation of active transfers.
- [ ] Allow retrying failed transfers.
- [ ] Show aggregate progress.

---

## 10. Mock Peer Discovery

**No actual mDNS or rendezvous networking yet.**

Create simulated peers.

- [ ] Create mock peer objects.
- [ ] Simulate peer discovery.
- [ ] Simulate peer appearing.
- [ ] Simulate peer disappearing.
- [ ] Simulate connection establishment.
- [ ] Simulate connection failure.
- [ ] Simulate reconnecting.
- [ ] Display peer status.
- [ ] Display peer capabilities.
- [ ] Display peer name and platform.
- [ ] Test multiple peers.

Example:

```text
Peers

● MacBook-M3       Online
● Pixel-10-Pro     Online
○ Home-Server      Offline
```

---

## 11. QR Pairing Workflow

Build the entire pairing UX using mocked authentication.

- [ ] Implement pairing modal.
- [ ] Implement terminal QR rendering.
- [ ] Implement QR half-block rendering.
- [ ] Implement pairing code display.
- [ ] Display connection method.
- [ ] Display authentication state.
- [ ] Display waiting for peer.
- [ ] Simulate successful pairing.
- [ ] Simulate pairing failure.
- [ ] Simulate cancellation.
- [ ] Implement `Esc` to cancel.
- [ ] Create success transition.
- [ ] Create failure/retry transition.

### Pairing States

```text
IDLE
  ↓
PAIRING_MODAL
  ↓
WAITING_FOR_PEER
  ↓
AUTHENTICATING
  ↓
CONNECTED
```

Failure paths should also be represented in the UI:

```text
WAITING_FOR_PEER
       ↓
    TIMEOUT
       ↓
   RETRY / CANCEL
```

---

## 12. Diff Inspector

Build the complete diff experience using mock files.

- [ ] Implement `d` keyboard shortcut.
- [ ] Create fullscreen diff modal.
- [ ] Implement side-by-side diff.
- [ ] Implement line numbers.
- [ ] Implement added lines.
- [ ] Implement removed lines.
- [ ] Implement modified sections.
- [ ] Implement syntax highlighting.
- [ ] Implement synchronized scrolling.
- [ ] Implement change-hunk navigation.
- [ ] Implement `Tab` between hunks.
- [ ] Implement selected-hunk state.
- [ ] Mock hunk staging.
- [ ] Implement `Enter` to stage a hunk.
- [ ] Implement `Esc` to close the diff.

The real diff engine can replace the mock diff provider later.

---

## 13. Responsive / Mobile UX

Treat narrow terminals as a first-class interface rather than a broken desktop layout.

### Wide Layout — ≥90 Columns

- [ ] Dual-pane workspace.
- [ ] Full metadata.
- [ ] Full breadcrumbs.
- [ ] Transfer information.
- [ ] Full footer action rail.

### Narrow Layout — <90 Columns

- [ ] Collapse into a single active pane.
- [ ] Implement `[Local] | [Remote]` tabs.
- [ ] Display active peer in the tab.
- [ ] Preserve file state indicators.
- [ ] Preserve selection.
- [ ] Preserve primary actions.
- [ ] Reduce metadata density.

### Very Narrow / Soft Keyboard

- [ ] Detect available viewport height.
- [ ] Collapse unnecessary headers.
- [ ] Collapse breadcrumbs when necessary.
- [ ] Preserve maximum file-list height.
- [ ] Ensure footer remains accessible.
- [ ] Ensure essential actions remain reachable.

---

## 14. Touch & Mouse Interaction

- [ ] Implement mouse support through OpenTUI input handling.
- [ ] Normalize primary click behavior.
- [ ] Allow clicking file rows.
- [ ] Allow clicking action buttons.
- [ ] Allow clicking pane tabs.
- [ ] Allow clicking modal controls.
- [ ] Ensure touch targets have adequate terminal-cell size.
- [ ] Test interaction under Termux.
- [ ] Ensure keyboard interaction remains the primary fallback.

---

## 15. Animation System

Implement animations as reusable UI primitives rather than one-off effects.

- [ ] Create an event-driven animation/tick system appropriate to OpenTUI.
- [ ] Avoid continuously rendering when the application is idle.
- [ ] Pause unnecessary animation when inactive.
- [ ] Implement transfer pulse.
- [ ] Implement Braille progress animation.
- [ ] Implement peer heartbeat.
- [ ] Implement focused-pane transition.
- [ ] Implement modal reveal.
- [ ] Implement success transition.
- [ ] Implement failure transition.
- [ ] Ensure animations never interfere with navigation.
- [ ] Test CPU usage during idle periods.

---

## 16. Modal System

Create reusable modal infrastructure.

- [ ] Pairing modal.
- [ ] Diff modal.
- [ ] Help modal.
- [ ] Transfer details modal.
- [ ] Confirmation modal.
- [ ] Error modal.
- [ ] Peer-selection modal.
- [ ] Establish consistent modal sizing.
- [ ] Establish consistent modal borders.
- [ ] Establish modal focus behavior.
- [ ] Implement keyboard dismissal.
- [ ] Implement mouse/touch dismissal where appropriate.

---

## 17. Help & Discoverability

The application should teach itself.

- [ ] Implement `?` help screen.
- [ ] Display context-sensitive shortcuts.
- [ ] Explain file-state symbols.
- [ ] Explain peer-state indicators.
- [ ] Explain transfer states.
- [ ] Explain selection behavior.
- [ ] Explain mobile interactions.
- [ ] Ensure first-time users can understand the workflow without documentation.

---

## 18. Complete Mock User Journey

Once the individual components exist, connect them into one coherent workflow.

### First Launch

- [ ] Launch SyncWeave.
- [ ] Show application shell.
- [ ] Simulate peer discovery.
- [ ] Show available peer.
- [ ] Allow peer selection.
- [ ] Open workspace.

### Pairing

- [ ] Open QR pairing.
- [ ] Show QR.
- [ ] Show pairing code.
- [ ] Simulate scanning.
- [ ] Simulate authentication.
- [ ] Transition into connected state.

### Browse

- [ ] Browse local files.
- [ ] Browse remote files.
- [ ] Switch panes.
- [ ] Navigate directories.

### Inspect

- [ ] Select modified file.
- [ ] Open diff.
- [ ] Navigate changes.
- [ ] Stage a hunk.
- [ ] Return to workspace.

### Stage

- [ ] Select multiple files.
- [ ] Show staged count.
- [ ] Show total size.
- [ ] Review staged changes.

### Sync

- [ ] Press `s`.
- [ ] Show transfer confirmation if appropriate.
- [ ] Begin simulated transfer.
- [ ] Show transfer animation.
- [ ] Show progress.
- [ ] Show speed.
- [ ] Show ETA.
- [ ] Complete transfer.

### Finish

- [ ] Update mock filesystem state.
- [ ] Mark transferred files as synchronized.
- [ ] Show success state.
- [ ] Return to normal workspace.
- [ ] Ensure the user understands what changed.

---

## 19. UX Polish Pass

After the complete workflow works:

- [ ] Remove visual inconsistencies.
- [ ] Normalize spacing.
- [ ] Normalize borders.
- [ ] Normalize icons.
- [ ] Normalize state colors.
- [ ] Review keyboard navigation.
- [ ] Review touch interaction.
- [ ] Review responsive layouts.
- [ ] Review empty states.
- [ ] Review loading states.
- [ ] Review errors.
- [ ] Review transitions.
- [ ] Review animation timing.
- [ ] Reduce unnecessary visual noise.
- [ ] Ensure important information has visual priority.
- [ ] Test the interface without reading documentation.
- [ ] Test the interface on a desktop terminal.
- [ ] Test the interface in Termux.
- [ ] Test narrow portrait layouts.
- [ ] Test light and dark terminal backgrounds where possible.

---

## 20. Phase 1 Definition of Done

Phase 1 is complete when a user can experience the entire SyncWeave workflow without any real networking implementation:

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

The application should feel like a real, polished synchronization tool despite the networking and filesystem layers being entirely simulated.

Only after this workflow and visual system are satisfactory should we begin replacing the mock implementations with:

1. Real filesystem access
2. Real file comparison
3. Real mDNS discovery
4. Real peer identity/authentication
5. Real QUIC transport
6. Real chunked transfers
7. Real synchronization semantics
8. Real persistence/recovery
