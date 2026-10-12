# Known limitations

What does not work yet, or is not verified, as of the 0.1.0 remediation round
(2026-10-12). Each item says what to expect. Items marked *open* are tracked in
[remediation-verification.md](remediation-verification.md) or in
[decisions.md](decisions.md). Nothing here is hidden behind a feature flag.

## Transfers

- **No retry and no resume.** A failed or cancelled transfer is not retried.
  Send it again from the beginning. The UI says so. The 2026-10-11 record planned up to
  3 retries; that is deferred ([decisions.md](decisions.md) section 3). *Deferred.*
- **Name collision during a transfer.** A collision is renamed when the transfer
  starts. If another file takes the chosen name while the transfer is in progress,
  the transfer fails. It is not retried with a new name. *Open* (decisions.md section 4).
- **Sender concurrency is not capped.** The receiver handles one session at a time.
  A sender can start several sessions at once. *Deviation*, recorded in
  decisions.md section 3.
- **Startup cleanup covers only some folders.** The startup sweep looks at the
  folders SyncWeave knows about. A partial left in another folder (for example, one
  you chose before a crash and then removed from the list) stays until you delete it.
  *Open* (R10).
- **Destination folders are checked when chosen.** The picker refuses unsafe folders
  at selection time. A folder that changes after it was chosen (for example, it is
  removed or replaced by a symlink) can still make a transfer fail after acceptance.
  *Open.*
- **Peer selection is by address, not name.** Two peers with the same alias are both
  listed. Choose by the entry you see. *Expected behaviour, not a bug.*
- **No interface selection.** The listener is on `::` (or `0.0.0.0`) and is reachable
  on every interface. You cannot choose one interface. *Deferred.*
- **Address and power changes.** Behaviour on Wi-Fi change, address change,
  sleep and wake is not verified. Restart SyncWeave after a change. *Unverified.*

## Identity and trust

- **Discovery names are not authenticated.** Anyone can announce any alias. Compare the
  security code for every transfer. There is no pairing and no TOFU pinning, so a
  known name is not trusted.
- **Peer ID display is weak.** The short Peer ID shown on screen has only six random
  characters, so do not compare Peer IDs. Compare the security code. *Open* (P1-35).
- **Pre-consent memory is loosely bounded.** A peer that completes the handshake can
  make the receiver buffer data before consent. The per-connection cap before consent
  is not yet tight enough. *Open* (R14).

## Platforms and verification

- **No two-host LAN run.** The [real-mode checklist](real-mode-checklist.md) has not
  been run on two physical hosts. Multicast discovery across real routers and access
  points has not been tested. *Unverified.*
- **macOS.** A macOS CI job exists. It has not run yet, so macOS is not a verified
  platform. *Unverified.*
- **Termux and Android.** Not verified on a device. Touch input and glyph rendering are
  untested. *Unverified.*
- **Performance.** No measurements exist for throughput, memory or CPU under load.
  *Unverified.*
- **Filesystem matrix.** Tests write to the local filesystem of the machine that runs
  them. FAT, exFAT, network filesystems and near-full storage have not been tested.
  *Unverified.*
- **No packet captures.** The handshake and discovery traffic has not been captured
  and decoded. *Unverified.*
- **Install.** The package has not been published to npm. Install from a checkout with
  `bun install`. Release binaries are built by CI on a `v*` tag, but no tag has been
  made. A binary is about 99 MB because it embeds the Bun runtime. *Unverified* for
  installing the `bin` entry.

## Tests and CI

- **A cancel test is flaky.** `e2e: abort signal cancels an in-flight send` times
  out in most full runs (R7). When it fails, `bun run check`, `bun test` and the
  coverage step exit non-zero. CI can be red for reasons that are not in the product.
  *Open.*
- **Coverage is below the goal in the real paths.** `app.ts` is about 45% line
  coverage overall, and its real-mode paths are lower. The goal is 80% for the real
  paths. Floors are enforced by `scripts/check-coverage.ts`: global lines 89% and
  functions 85%, and per file for `app.ts`, `transport.ts` and `transfer-protocol.ts`.
  The 80% goal for the real-mode paths of `app.ts` is not enforced. *Open.*
- **`main.ts` is not loaded by any test.** Startup wiring is covered only by
  reading the code and by manual runs. *Open.*
- **Some tests pass silently when a scenario cannot run.** The read-only destination
  test is skipped when run as root. The live multicast discovery test passes when
  multicast is not available. *Open* (N7, P2-21).
- **Two-process loopback e2e is not in CI.** The loopback tests run in-process inside
  `bun test`. A job that runs two real processes is not yet in CI. *Open* (P1-50).
- **Lint is partial.** Biome runs in lint-only mode. Rules that flag the existing style
  are off. `noUnsafeFinally` is off until R8 is fixed. Biome reports 11 warnings for
  unused imports, variables and parameters in `src/`. *Open.*
- **Strict unused-declaration checks are off.** `noUnusedLocals` and `noUnusedParameters`
  would report 11 errors in `src/`, including an unused `fileIndex` in `app.ts`.
  *Deferred* until that cleanup (P2-23).

## Display

- **Narrow terminals.** Layouts are tested at many widths. The real-mode header has been
  seen garbled at about 90 to 112 columns. Use a wider terminal. *Open* (R13).
- **Icons.** Without a Nerd Font, set `SYNCWEAVE_ASCII=1`. Some glyphs in mock mode still
  have no ASCII fallback. *Open* (P2-16).

## Data and logging

- **The diagnostic log grows without limit.** `syncweave.log` is not rotated. Delete it
  when it gets large. It records aliases, paths and Peer ID prefixes. See
  [privacy.md](privacy.md). *Open.*

## Mock mode

- Mock mode is a simulator. It reads no real files and sends nothing. Its consent,
  progress and retry screens are demonstrations and do not reflect the real protocol.
