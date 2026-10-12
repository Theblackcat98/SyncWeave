# SyncWeave

A keyboard-first, animated terminal UI for reviewing and staging file transfers — a TUI take on LocalSend for the local network. The app runs in two modes: **mock** (the original deterministic simulation: no real files, no network) and **real** (actual transfers). The real mode implements the Phase 2 network stack: `Noise_XX_25519_AESGCM_SHA256` over TCP (verified against the official Noise test vector), UDP-multicast peer discovery with manual `IP:port` fallback, session-ephemeral Ed25519 Peer IDs verified before any metadata flows, per-transfer receiver consent, 64 KiB chunked streaming, SHA-256 integrity, automatic rename on collision, and restart-from-zero recovery. See [docs/decisions.md](docs/decisions.md) for the recorded decisions and [phase2.md](phase2.md) for the specification.

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

## Real mode

Real transfers run with `--real`. Two machines on the same LAN discover each
other automatically over UDP multicast:

```sh
# machine A
bun src/main.ts --real --alias laptop1
# machine B
bun src/main.ts --real --alias laptop2
```

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--real` | off | Real mode: live identity, TCP listener, discovery, real filesystem. |
| `--alias <name>` | `$USER` | Display name announced to peers. |
| `--port <n>` | 24816 | TCP port for the Noise listener. |
| `--peer <host:port>` | — | Manual peer (repeatable). Fallback when multicast discovery is unavailable; IPv6 as `--peer [::1]:24816`. |

Two instances on the **same machine** need distinct ports, pointed at each
other:

```sh
bun src/main.ts --real --alias laptop1 --port 24816 --peer 127.0.0.1:24818
bun src/main.ts --real --alias laptop2 --port 24818 --peer 127.0.0.1:24816
```

Workflow: browse your real files, `Space` to stage, `Tab` to the Receiver
pane, `↑/↓` to pick a peer, `Tab` back, `s` then `Enter` to send. The
receiver gets a consent screen — keyboard `a` accepts all, `Enter` accepts
the selection, `x` declines. Accepted files land in `~/Downloads` with
automatic rename on collision. Network details, firewall notes, and what is
still unverified live in [docs/networking.md](docs/networking.md).

## Workflow

(mock mode)

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
