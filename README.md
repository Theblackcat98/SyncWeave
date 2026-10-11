# SyncWeave

A keyboard-first, animated terminal UI for reviewing and staging file transfers. The current **Phase 1 build is a deterministic simulation**: it does not access real files, discover peers on a network, send bytes, synchronize directories, persist transfers to disk, or establish a pairing/trust relationship. The receiver-consent UX is informed by LocalSend's documented v2 flow, but no network protocol or transport is implemented. The proposed Phase 2 scope in [phase2.md](phase2.md) is direct local-LAN send/receive with per-transfer consent, safe writes, integrity, and recovery; it is a specification only, not implemented.

## Run

Requires [Bun](https://bun.sh/) and a Unicode-capable terminal. In a checkout:

```sh
bun install
bun run dev
```

For terminals without Nerd Fonts, use the built-in ASCII icon fallback:

```sh
SYNCWEAVE_ASCII=1 bun run start
```

Reduce decorative motion while keeping transfer simulation usable:

```sh
SYNCWEAVE_REDUCED_MOTION=1 bun run start
```

## Workflow

- Browse either mock workspace with **↑/↓**; use **Tab**, **1**, or **2** to change panes. Press **Enter** on a directory to open it and **Backspace** to go up. The **Stage** toolbar action works with a mouse or touch terminal as well as **Space**.
- Press **Space** to stage a file, **a** to stage all files in the active folder, or **Shift+A** to clear that folder's staging. Use **d** to inspect the mock diff.
- Press **s** to review outgoing items. Continue to a clearly labeled mock receiver-consent step; accept all, include/skip individual files, rename an item, choose a destination, or decline. Progress only starts after an explicit acceptance choice.
- Press **i** to simulate an incoming request and apply the same per-transfer consent choices. Press **e** during progress to simulate a failure; use **r** to retry. **Esc** cancels an active mock transfer.
- Press **q** to browse mock peers, **e** to simulate a discovery timeout, **r** to retry the mock preview, **v** to display a fingerprint for manual comparison, **f** to save/remove a local Favorite, **p** to view Favorites, **t** for this-session transfer history, or **?** for help. Mouse clicks and wheel scrolling are supported where the terminal reports mouse input.

A fingerprint comparison is not stored as verification. A Favorite is a local destination shortcut, not pairing, trust, or permission to auto-accept. Every transfer request requires its own consent decision. Decorative identity art is not a scannable code or protocol invitation.

## Project layout

- `src/domain.ts` — typed state and transfer contracts
- `src/state/` — application state modules
- `src/services/` — isolated mock filesystem, peer-discovery, and transfer services
- `src/ui/` — OpenTUI theme primitives and responsive views
- `src/ui/animation-clock.ts` — active-only animation ticks with pause/resume/disposal
- `src/app.ts` — keyboard/mouse event routing and mock workflow state machine
- `phase1.md` — Phase 1 scope, reference findings, checklist, and reconciliation status
- `phase2.md` — proposed direct-LAN transfer acceptance criteria, Phase 1 TODO crosswalk, and issue dispositions

## Checks

```sh
bun run typecheck
bun test
bun run smoke
```

The headless OpenTUI tests cover the wide and narrow layouts, keyboard navigation, mouse actions, consent-before-progress, successful completion, reduced-motion progress, failure/retry, peer timeout/retry, Favorites, and manual fingerprint comparison. Termux and real-device touch behavior still require testing on an Android terminal.
