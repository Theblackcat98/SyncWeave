# Changelog

All notable changes to SyncWeave. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is pre-release
(0.x); no stable release exists yet.

## [Unreleased]

### Added

- Real-mode flags accept `--flag=value`. Usage errors exit with status 2. `--root`
  sets the folder the local file browser opens in.
- Destination picker refuses symlinks, system directories, hidden (dot) directories
  and world-writable directories.
- Receiver acknowledges each file with its SHA-256 and size. The sender checks both
  before it reports success.
- Lint with Biome (`bun run lint`) in lint-only mode, and a coverage step with
  floors (`bun run test:coverage`, enforced by `scripts/check-coverage.ts`).
- CI: a macOS job next to the Ubuntu job, a release job that builds
  `syncweave` for `linux-x64`, `linux-arm64` and `darwin-arm64` on `v*` tags, and
  `permissions`, `timeout-minutes` and `concurrency` settings.
- `.bun-version` (Bun 1.4.3), used by CI.
- Documentation: `docs/privacy.md`, `docs/troubleshooting.md`,
  `docs/known-limitations.md`, `docs/release-gates.md`, and this changelog.

### Changed

- The sender confirms the security code before any file metadata is sent. The
  receiver confirms it on the consent screen.
- Discovery Peer IDs are display hints. They are no longer used as the expected
  identity. Discovered names are shown as "claimed".
- There is no trust-on-first-use pinning of peers.
- The default alias is a random label for each run, not `$USER`.
- The listener binds `::` by default and falls back to `0.0.0.0` with a notice when
  IPv6 is unavailable. An explicit `--bind` never falls back.
- The receiver has 60 seconds to answer a request. The sender waits up to 75 seconds
  for the answer.
- The startup sweep removes only partial files whose owning process is no longer
  running.
- `package.json` is formatted across several lines and has a `files` allowlist.
  `src/main.ts` is executable in git.
- Phase 1 and Phase 2 planning documents moved to `docs/history/` with banners.
- `@types/bun` is 1.4.3, matching the CI Bun version.
- Strict TypeScript adds `noImplicitOverride` and `noFallthroughCasesInSwitch`.

### Fixed

- Transfers to discovered peers no longer fail because of the discovery Peer ID
  check (see `docs/decisions.md`, section 2).
- `SECURITY.md` and the README no longer say the sender confirms the security code
  after metadata is sent, or claim restart-from-zero recovery.
- Remediation-plan IDs in CI and Dependabot comments refer to the canonical plan.

### Known issues

See [docs/known-limitations.md](docs/known-limitations.md). Notably: no retries or
resume, no two-host LAN run, macOS and Termux not yet verified, and a flaky cancel
test.
