# Release gates

Every gate that must pass before SyncWeave can claim a release, with its status and
the evidence for it. A gate is **met** only when the evidence column links to a
reproducible result: a CI run, a run record, or a file in the repository. "Code
exists" is not evidence. Update this file in the same change as the evidence.

Status values: **met**, **partial** (some of the requirement has evidence),
**not met**. Evidence column: a link, or `none`.

Last reviewed: 2026-10-12, on the remediation-round-2 branch. No gate is met for
real-network use yet.

## A. Build, CI and packaging

| # | Gate | Status | Evidence |
|---|---|---|---|
| A1 | `bun run lint`, `bun run typecheck` and `bun run test:coverage` pass on `ubuntu-latest` and `macos-latest` in CI | partial | Ubuntu and macOS jobs are defined in `.github/workflows/ci.yml`. The macOS job has not run. The cancel test is flaky (known-limitations.md). `none` for a green run. |
| A2 | Coverage floors enforced in CI: global, and per file for `app.ts`, `transport.ts`, `transfer-protocol.ts` | partial | `scripts/check-coverage.ts`, run by the `Test with coverage floors` step in `ci.yml`. The step fails while the cancel test (B6) is flaky. |
| A3 | Real-path coverage goal: `app.ts` real-mode paths at 80% or more | not met | Measured on 2026-10-12: `app.ts` about 45% lines overall. The floors are set below measured values, so they do not enforce this goal. |
| A4 | Release binaries for `linux-x64`, `linux-arm64` and `darwin-arm64` built in CI on a `v*` tag | partial | `release` job in `ci.yml`. No tag has been pushed. `none`. |
| A5 | Package contents limited by a `files` allowlist; no planning documents or tests in the package | partial | `package.json` `files`. Confirm with `bun pm pack --dry-run` before a release. `none` for the recorded dry run. |
| A6 | Bun version pinned in one place and used by CI | met | `.bun-version` (1.4.3) read by `setup-bun` in `ci.yml`; `@types/bun` 1.4.3. |
| A7 | Dependency audit clean in CI | met | `bun audit` step in `ci.yml`. Clean on 2026-10-12 (see the QA report). |
| A8 | Actions pinned by SHA; Dependabot covers Actions and Bun | met | `ci.yml`, `.github/dependabot.yml`. |
| A9 | Single-binary build works | met | `bun build --compile src/main.ts` produced a working binary on 2026-10-12 (98.8 MB, Linux). Not run for each release target yet (see A4). |

## B. Tests

| # | Gate | Status | Evidence |
|---|---|---|---|
| B1 | Every P0 fix has a regression test that fails before the fix | not met | Not checked against the pre-fix commit. `none`. |
| B2 | No mock service is constructed or reachable in real mode, and a test asserts it | partial | Real branch of `src/main.ts` builds only the null services. No test asserts it. `none`. |
| B3 | Two-process loopback end-to-end in CI on Linux and macOS: send, accept, decline, cancel, receiver failure, stalled peer | not met | In-process tests exist (`protocol-v2-e2e.test.ts`). No two-process job. `none`. |
| B4 | Real-mode keypress suite (two instances, send, accept, decline, double Enter, rename, staging, cancel) | not met | `none`. |
| B5 | Silent-pass patterns removed: skipped tests fail in CI when their scenario is expected | not met | Multicast and root-only tests still pass silently. `none`. |
| B6 | The full suite passes reliably: `e2e: abort signal cancels an in-flight send` no longer times out | not met | 5 of 6 full runs timed out on 2026-10-12 (R7, `protocol-v2-e2e.test.ts`). `none`. |

## C. Network and platform (manual evidence)

| # | Gate | Status | Evidence |
|---|---|---|---|
| C1 | Real-mode checklist passed on two physical hosts on a real LAN, with a run record | not met | Checklist updated 2026-10-12. Run record in [real-mode-checklist.md](real-mode-checklist.md) is empty. `none`. |
| C2 | Packet capture of the handshake and discovery: no mDNS, no automatic traffic other than the documented multicast; no file metadata before the sender's SAS confirmation | not met | `none`. |
| C3 | Network matrix: wired and Wi-Fi, IPv4 and IPv6, manual address, firewall denied, client isolation, VPN, cold start and sleep-resume | not met | `none`. |
| C4 | Filesystem matrix: zero-byte, large, many-file, Unicode and long names, existing files, permissions, symlink traversal, near-full storage, on each supported OS | not met | Partly covered by unit tests on the local filesystem. `none` for the matrix. |
| C5 | Performance: throughput, peak memory, CPU, first-byte latency and UI responsiveness measured, with numeric thresholds set | not met | Thresholds are not set. `none`. |
| C6 | Termux/Android: rendering and touch verified on a device, or the platform is listed as unsupported | not met | `none`. |
| C7 | macOS: supported platform, verified by a green CI job and a manual run | not met | macOS CI job added 2026-10-12; not run. `none`. |

## D. Documentation and security

| # | Gate | Status | Evidence |
|---|---|---|---|
| D1 | README, networking.md and decisions.md describe the code; every deviation is recorded with a status | partial | Rewritten for the target behaviour on 2026-10-12. Re-check after merge. [decisions.md](decisions.md). |
| D2 | Threat model | met | [SECURITY.md](../SECURITY.md). |
| D3 | Privacy note: what is visible on the LAN, and what is stored | met | [privacy.md](privacy.md). |
| D4 | Install, firewall, troubleshooting and known-limitations guidance | met | [README.md](../README.md), [networking.md](networking.md), [troubleshooting.md](troubleshooting.md), [known-limitations.md](known-limitations.md). |
| D5 | CHANGELOG kept for each release | partial | [CHANGELOG.md](../CHANGELOG.md) has the unreleased entry. |
| D6 | Threat model review and the open high or critical security items closed | not met | Open items in [known-limitations.md](known-limitations.md). `none`. |
| D7 | OpenTUI upgrade policy written | met | [decisions.md](decisions.md) section 6. |
| D8 | Phase documents archived with banners | met | `docs/history/phase1.md`, `docs/history/phase2.md`. |

## E. Overall

No release is ready. Gates B1 to B5, C1 to C7 and D6 are not met. A green CI run,
loopback tests and a one-device demo are not sufficient on their own. The archived
`docs/history/phase2.md` §5 and §"Phase 2 exit definition" set the bar.
