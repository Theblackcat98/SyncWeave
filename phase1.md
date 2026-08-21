# SyncWeave — Phase 1: TUI & UX Foundation

> **Phase 1 objective:** Build and refine the complete SyncWeave visual system and user workflow before implementing real networking or filesystem synchronization.

All networking, peer discovery, authentication, file comparison, and transfers are mocked/faked during Phase 1. The goal is to make the product experience correct before connecting real infrastructure.

## 0. Locked Architecture Decision

**OpenTUI + TypeScript is the sole UI foundation for SyncWeave.**

OpenTUI provides the terminal rendering, component/layout primitives, input handling, and UI runtime. SyncWeave must not introduce Bubble Tea, Lip Gloss, Ratatui, or another TUI framework.

OpenTUI is a native Zig core with TypeScript bindings and provides a component-oriented architecture suitable for the visual, interactive TUI we are building. The upstream project also provides a dedicated agent skill/documentation source that should be consulted when implementing unfamiliar OpenTUI APIs. urlOpenTUI repositoryhttps://github.com/anomalyco/opentui

### Phase 1 stack

- **OpenTUI** — rendering, layout, components, keyboard/mouse input, scrolling, and animation.
- **TypeScript** — application and UI implementation.
- **Bun** — development/runtime/package management.
- **Mock domain/services** — fake filesystem, peers, pairing, diffs, and transfers.
- **Real networking/filesystem** — explicitly deferred until the UX is approved.

### Explicitly excluded

- [x] Bubble Tea — not used.
- [x] Lip Gloss — not used.
- [x] Ratatui — not used.
- [x] Real networking — deferred.
- [x] Real filesystem synchronization — deferred.

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

The UI should consume application state rather than reaching directly into future network/filesystem implementations. The current prototype keeps mock data local to the application while we establish the visual model; extraction into dedicated domain/service modules is an upcoming task.

---

# 1. Technology & Project Foundation

- [x] Lock OpenTUI as the sole TUI framework.
- [x] Lock TypeScript as the UI/application implementation language.
- [x] Establish initial project structure.
- [x] Add `package.json` with OpenTUI dependency.
- [x] Add TypeScript configuration.
- [x] Add Bun development/start scripts.
- [x] Establish an initial OpenTUI entry point at `src/main.ts`.
- [ ] Establish dedicated modules for UI components.
- [ ] Establish dedicated application-state module.
- [ ] Establish dedicated mock-service modules.
- [ ] Establish interfaces separating UI/domain state from future real services.
- [ ] Add a formal typecheck/CI validation step.
- [ ] Add a minimal automated startup/smoke test.

---

# 2. Visual Design System

## Color & Theme

- [x] Establish initial SyncWeave semantic color tokens in the prototype.
- [x] Implement background color.
- [x] Implement elevated surface color.
- [x] Implement Electric Cyan focus accent.
- [x] Implement Violet remote-peer accent.
- [x] Implement success/mint state.
- [x] Implement warning/modified state.
- [x] Implement error/deleted state.
- [x] Implement muted/synchronized state.
- [x] Implement focused-row state.
- [ ] Extract design tokens into a dedicated theme module.
- [ ] Define typography hierarchy.
- [ ] Define consistent spacing/padding tokens.
- [ ] Define reusable border styles.
- [ ] Define disabled/loading/inactive states.

## Terminal Rendering

- [x] Use Unicode state glyphs.
- [x] Use Nerd Font file icons in the prototype.
- [ ] Add ASCII icon fallback.
- [ ] Verify rendering across common desktop terminals.
- [ ] Verify rendering in Termux.
- [ ] Verify narrow terminal rendering.
- [ ] Audit glyph compatibility with Android terminal fonts.

---

# 3. Main Application Shell

- [x] Build the main SyncWeave application frame.
- [x] Build the top status/header bar.
- [x] Build the central workspace.
- [x] Build the activity/transfer status area.
- [x] Build the bottom action rail.
- [x] Display SyncWeave version.
- [x] Display mock mDNS status.
- [x] Display mock peer count.
- [ ] Add animated mDNS heartbeat.
- [ ] Add dynamic contextual footer actions.
- [ ] Add responsive resizing behavior.

---

# 4. Dual-Pane Workspace

## Local Pane

- [x] Display local workspace path.
- [x] Display local files.
- [x] Display file icons.
- [x] Display file sizes.
- [x] Display synchronization state.
- [x] Display selection state.
- [x] Implement keyboard navigation.
- [ ] Implement directory navigation.
- [ ] Implement scrolling for larger datasets.
- [ ] Implement mouse/touch selection.

## Remote Pane

- [x] Display remote peer name.
- [x] Display remote path.
- [x] Display remote mock filesystem.
- [x] Display remote metadata.
- [x] Visually distinguish remote state.
- [x] Implement independent cursor state.

## Pane Interaction

- [x] Implement pane focus.
- [x] Implement `Tab` pane switching.
- [x] Visually highlight focused pane.
- [x] Implement synchronized UI state updates after navigation.
- [x] Implement independent selection per pane.
- [ ] Add animated focus transition.
- [ ] Add mouse/touch pane switching.

---

# 5. Mock Filesystem

The Phase 1 filesystem is deterministic and entirely fake.

- [x] Create mock local files.
- [x] Create mock remote files.
- [x] Include realistic filenames and paths.
- [x] Include file sizes.
- [x] Include synchronization states.
- [x] Support multiple selectable files.
- [ ] Add explicit directory nodes.
- [ ] Add directory traversal.
- [ ] Add richer metadata.
- [ ] Add configurable mock scenarios.

Current scenario includes:

```text
~/projects/notes/

├── architecture-diagram.md
├── daily-todo.txt
├── configs/
└── build-artifact.tar.gz
```

---

# 6. Synchronization State Visualization

- [x] Synced/identical state.
- [x] Added/new state.
- [x] Modified/diverged state.
- [x] Deleted/missing state type defined.
- [x] State glyphs.
- [x] Semantic state colors.
- [x] State visible directly in file rows.
- [ ] Add conflict state.
- [ ] Ensure states remain understandable without color.
- [ ] Add state legend/help.
- [ ] Implement state transition animations.

---

# 7. File Selection & Staging Workflow

- [x] `Space` selects/deselects the focused file.
- [x] Multi-file selection.
- [x] Visual selection checkmark.
- [x] Staged/unstaged status feedback.
- [x] Aggregate selected-file count for mock sync action.
- [x] Prevent sync action when nothing is staged.
- [ ] Select all.
- [ ] Deselect all.
- [ ] Show aggregate transfer size.
- [ ] Add staged-transfer review UI.
- [ ] Add explicit confirmation flow.

---

# 8. Mock Transfer Experience

**No real network transfer is implemented yet.**

- [ ] Create a dedicated mock transfer service.
- [ ] Create transfer jobs.
- [ ] Simulate initialization.
- [ ] Simulate chunk progression.
- [ ] Simulate speed.
- [ ] Simulate ETA.
- [ ] Simulate multiple files.
- [ ] Simulate completion.
- [ ] Simulate failure.
- [ ] Simulate cancellation.
- [ ] Simulate retry.
- [ ] Implement animated transfer activity.
- [ ] Implement Braille progress gauge.
- [ ] Implement transfer queue.

Current `s` behavior is deliberately only a **mock queue/status placeholder**. It does not transfer data.

---

# 9. Mock Peer Discovery

**No actual mDNS or rendezvous networking yet.**

- [ ] Create mock peer model.
- [ ] Simulate peer discovery.
- [ ] Simulate peer appearance.
- [ ] Simulate peer disappearance.
- [ ] Simulate connection establishment.
- [ ] Simulate connection failure.
- [ ] Simulate reconnecting.
- [ ] Display peer capabilities.
- [ ] Support multiple peer selection.
- [ ] Add peer status animations.

Current header displays a static mock peer state only.

---

# 10. QR Pairing Workflow

- [ ] Create pairing modal.
- [ ] Integrate OpenTUI QR support.
- [ ] Render terminal QR code.
- [ ] Display pairing code.
- [ ] Display connection method.
- [ ] Display authentication state.
- [ ] Display waiting-for-peer state.
- [ ] Simulate successful pairing.
- [ ] Simulate failure.
- [ ] Simulate timeout.
- [ ] Implement retry.
- [ ] Implement cancellation.

Current `q` action is only a placeholder indicating that the mock pairing UI is next.

---

# 11. Diff Inspector

- [ ] Implement `d` action as an actual modal.
- [ ] Build fullscreen/split diff view.
- [ ] Implement mock side-by-side content.
- [ ] Implement line numbers.
- [ ] Implement added lines.
- [ ] Implement removed lines.
- [ ] Implement modified sections.
- [ ] Implement syntax highlighting.
- [ ] Implement synchronized scrolling.
- [ ] Implement hunk navigation.
- [ ] Implement hunk selection.
- [ ] Implement mock hunk staging.
- [ ] Implement `Esc` dismissal.

Current `d` action only updates the activity status as a workflow placeholder.

---

# 12. Responsive / Mobile UX

## Wide — ≥90 columns

- [x] Establish dual-pane layout as the desktop target.
- [ ] Add full metadata/breadcrumb treatment.
- [ ] Add responsive sizing rules.

## Narrow — <90 columns

- [ ] Collapse to single active pane.
- [ ] Add `[Local] | [Remote]` tabs.
- [ ] Preserve file state indicators.
- [ ] Preserve selection and primary actions.
- [ ] Reduce metadata density.

## Very Narrow / Soft Keyboard

- [ ] Detect reduced viewport dimensions.
- [ ] Collapse unnecessary headers.
- [ ] Collapse breadcrumbs.
- [ ] Preserve file-list height.
- [ ] Preserve essential actions.

---

# 13. Touch & Mouse Interaction

- [ ] Implement OpenTUI mouse handling.
- [ ] Normalize primary click behavior.
- [ ] Click file rows to focus/select.
- [ ] Click action controls.
- [ ] Click pane tabs.
- [ ] Click modal controls.
- [ ] Validate terminal touch behavior in Termux.
- [ ] Keep keyboard controls fully functional as the fallback.

---

# 14. Animation System

Animations must be event-driven and should not create unnecessary CPU/battery load while idle.

- [ ] Establish reusable OpenTUI animation/tick primitives.
- [ ] Pause unnecessary animation while idle.
- [ ] Transfer pulse.
- [ ] Braille progress animation.
- [ ] mDNS heartbeat.
- [ ] Pane focus transition.
- [ ] Modal reveal.
- [ ] Success transition.
- [ ] Failure transition.
- [ ] Validate idle CPU behavior.

---

# 15. Modal System

- [ ] Pairing modal.
- [ ] Diff modal.
- [ ] Help modal.
- [ ] Transfer details modal.
- [ ] Confirmation modal.
- [ ] Error modal.
- [ ] Peer selection modal.
- [ ] Shared modal sizing/borders/focus behavior.
- [ ] Keyboard dismissal.
- [ ] Mouse/touch dismissal.

---

# 16. Help & Discoverability

- [ ] Implement `?` help screen.
- [x] Basic shortcut guidance exists in the footer.
- [ ] Context-sensitive shortcuts.
- [ ] File-state legend.
- [ ] Peer-state legend.
- [ ] Transfer-state legend.
- [ ] Mobile interaction guidance.
- [ ] First-launch guidance.

---

# 17. Complete Mock User Journey

The final Phase 1 workflow is:

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

### Current progress

- [x] Launch application shell.
- [x] Show mock peer/discovery status.
- [x] Show local and remote workspaces.
- [x] Navigate both panes.
- [x] Switch panes with `Tab`.
- [x] Select files with `Space`.
- [x] Show synchronization states.
- [x] Trigger mock sync action.
- [x] Trigger mock diff workflow status.
- [x] Trigger mock pairing workflow status.
- [ ] Complete actual mock pairing UI.
- [ ] Complete actual mock diff UI.
- [ ] Complete actual mock transfer simulation.
- [ ] Complete responsive mobile layout.
- [ ] Complete mouse/touch workflow.
- [ ] Complete animation system.

---

# 18. UX Polish Pass

After the complete mock workflow exists:

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
- [ ] Reduce visual noise.
- [ ] Ensure important information has visual priority.
- [ ] Test without documentation.
- [ ] Test desktop terminal.
- [ ] Test Termux.
- [ ] Test narrow portrait layouts.
- [ ] Test light/dark terminal backgrounds where practical.

---

# 19. Phase 1 Definition of Done

Phase 1 is complete when a user can experience the entire SyncWeave workflow with **zero real networking or synchronization** and the UI is considered polished enough to serve as the product's visual contract.

Only after Phase 1 is approved should we begin replacing mocks with:

1. Real filesystem access.
2. Real file comparison.
3. Real mDNS discovery.
4. Real peer identity/authentication.
5. Real QUIC transport.
6. Real chunked transfers.
7. Real synchronization semantics.
8. Real persistence/recovery.

**Principle:** build the experience first; connect the machinery second.
