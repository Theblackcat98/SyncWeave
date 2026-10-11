# SyncWeave — Phase 2: Direct Local-LAN Transfer

**Status:** Proposed acceptance specification; this change contains no Phase 2 networking or filesystem implementation.

**Baseline:** current `main` at `2f100a00873068192f46812b211856f5844983d7` (October 11, 2026).

## Goal and accepted scope

Replace the Phase 1 simulation with a safe, testable **direct local-network send/receive flow** for user-selected files. The sender and receiver communicate directly on the local network; file bytes are not routed through a cloud service or unrelated relay. The receiver must make an explicit decision for every incoming transfer before any file contents are transmitted. Transfers must use safe destination writes, verify integrity, and recover clearly from cancellation, network failure, and process restart.

This follows Auri's current direction. LocalSend is a source of protocol and UX examples, **not a requirement to copy its wire protocol, stack, ports, concurrency limits, or identity model**.

### Explicit non-goals

- Ongoing two-way folder synchronization, deletion propagation, or automatic conflict resolution.
- Persistent pairing, durable peer trust, or auto-accept. A remembered destination or identity display is not authorization.
- Cloud relay or browser-link sharing.
- Treating a QR illustration, IP address, device alias, Favorite, or encrypted channel by itself as proof of peer identity.
- Declaring real transfer, filesystem safety, or recovery complete based on the existing mock TUI or its tests.

## Current baseline — not Phase 2 completion

The application is a deterministic in-memory simulation. Filesystem, peer, and transfer services are mocks; Favorites and transfer records reset with the process. The code has no real local-file access, LAN discovery/listener, byte streaming, authenticated peer transport, integrity verification, or durable recovery. Existing tests establish mock-UI behavior only.

Verified for this reconciliation on Bun 1.4.3 at the baseline commit: frozen-lockfile install, TypeScript typecheck, 16 automated tests, and the 9-test headless smoke script all pass. The working-tree source code was not changed. These checks are necessary but do not prove LAN or production readiness.

## Decisions required before corresponding implementation

Record and review these decisions before starting the related network or filesystem implementation. Do not silently inherit LocalSend defaults.

| Decision | Required resolution |
|---|---|
| Supported platforms and roles | Name supported OS/runtime versions and which platforms send, receive, or both. Decide whether Termux/Android is supported; physical-device tests not run remain unverified. |
| Network behavior | Select transport/protocol; define discovery plus manual-address fallback, IPv4/IPv6 claims, port behavior, interface binding, listener lifetime, firewall requirements, and behavior under client isolation, VPNs, multiple interfaces, sleep, and address changes. |
| First-contact identity | Choose a documented, session-scoped peer-authentication method. Encrypt the channel and authenticate the intended peer before metadata or bytes. Do not accept any certificate merely because the channel is encrypted; do not persist a trusted peer or let one transfer authorize another. A fingerprint/SAS/QR check must say what it proves, bind to the exact session, and fail closed on mismatch. |
| Resource and performance budgets | Set limits for file/session sizes, file count, metadata, queue, connections/files in flight, temporary disk, timeouts, retry count, throughput, memory, and responsiveness. Derive values from SyncWeave's goals rather than copying another product's defaults. |
| Destination and recovery | Choose collision handling and retention/cleanup for temporary files and local transfer records. Specify restart-from-zero versus verified-offset resume; do not claim resumability unless offsets are authenticated and content-verified. |

These are **gates**, not assumptions filled in by this document. Until a platform or protocol choice is recorded, dependent tests must be marked blocked or unverified rather than passed.

No transport, protocol, or cryptographic composition—including TLS, Noise, PAKE, or a custom composition—is selected or approved by this specification. The protocol choice remains **unresolved/proposed** pending review of a vetted profile and supporting evidence. Recommendations in the research report remain provisional candidates, not accepted decisions; passing the protocol-agnostic gates below does not select or approve a protocol. Until the profile is reviewed, dependent implementation and tests remain blocked or unverified.
An isolated two-peer spike may evaluate candidate transport and authentication approaches against the protocol-agnostic gates (including matching session-bound confirmations, no peer/file metadata before bilateral confirmation, rejection of mismatches and redirects, and strict endpoint verification). **libp2p may be evaluated as a stronger spike candidate only; neither libp2p nor its default discovery behavior is an approved product profile.** Spike results and research recommendations remain provisional evidence, not a protocol selection; the profile and protocol choice remain unresolved pending separate acceptance review.

## Acceptance criteria

### 1. Direct transfer flow and consent

1. A user can choose one or more source files and send them to a reachable peer on the same local network. File bytes travel directly between the two devices; no cloud upload or relay carries them.
2. A receiver can explicitly start and stop availability. The UI shows whether its receive service is running and on which intended local interface(s); it does not start a hidden always-on listener.
3. Discovery and manual-address fallback are documented and tested. Before bilateral identity confirmation, discovery may expose only the minimum discovery/control fields permitted by **Gate A** below; any peer/session identifier must be ephemeral and unlinkable. A discovery failure does not silently prevent use of the approved fallback.
4. Only after both endpoints independently confirm the matching session-bound identity under **Gate B** does the receiver see a transfer request. The request identifies the peer using the strongest **verified** identity available and shows requested names and sizes. The receiver can accept or decline each transfer; any multi-file subset acceptance is explicit and never authorizes unselected files.
5. **Gate C is separate:** no file bytes are sent until the receiver explicitly accepts the exact pending session and selected file set. Discovery, peer selection, identity confirmation, a prior transfer, a saved destination, a fingerprint display, or peer presence never substitutes for current per-transfer consent.
6. Each accepted transfer has an unpredictable, short-lived session identifier and authorization scoped to the expected peer, session, and file. Wrong, expired, replayed, duplicate, or cross-session authorization is rejected.
7. Each file has legible states for queued, awaiting consent, transferring, verifying/finalizing, complete, skipped/rejected, cancelled, failed, and interrupted. Progress and byte counts reflect observed work; completion requires both integrity verification and finalization.

### 2. Transport, identity, and listener security

- Production transfer traffic is encrypted by default using a maintained security implementation. The sender verifies the intended receiver before sending metadata or bytes; encryption to an unauthenticated endpoint is insufficient.
- The first-contact identity method is session-only and documented before implementation. A mismatch, expired session, or failed verification fails closed. Plaintext downgrade and permissive certificate bypass are not production defaults.

#### Gate A — Pre-confirmation discovery disclosure

Discovery is not identity confirmation and does not authorize peer/file metadata or a transfer. Before both endpoint users independently confirm the matching session-bound identity, only the minimum LAN discovery/control fields strictly needed to locate and open a candidate session may be visible: for example, the current local endpoint address/port when required, a generic service type/version identifier, and (only if needed) a random, short-lived rendezvous token. Any peer/session identifier exposed before confirmation must be random, session-scoped, and unlinkable across sessions; persistent or stable peer identities are not permitted in discovery.

Before bilateral identity confirmation, discovery and session setup must not expose filenames, file counts or sizes, previews, content hashes, transfer requests, transfer identifiers or other transfer details, stable peer IDs, persistent keys/fingerprints, device labels, usernames, or account identities. This limit applies to mDNS and every alternative discovery mechanism; transport defaults are not an exception. If a chosen mechanism cannot suppress fields outside this minimum, disable or replace that discovery mode and use the approved manual fallback, or do not select that mechanism.

**Test:** Capture LAN discovery/control traffic when neither endpoint has confirmed, when only one endpoint has confirmed, and after both have confirmed. In the first two states, verify that discovery contains only the permitted minimal fields, no prohibited file/transfer/persistent-identity data, and no linkable peer identifier; verify that discovery failure still permits the approved manual fallback.

#### Protocol-agnostic session authorization gates

These gates are mandatory regardless of the eventual reviewed profile; they do not select a transport, protocol, or cryptographic composition.

1. **Transcript-bound identity confirmation:** Both endpoints display the same session-bound confirmation derived from the same authenticated session transcript for the intended peer and transfer. An identity or transcript mismatch, expired confirmation, or confirmation from another session fails closed. **Test:** verify matching confirmations for the intended session; force an identity/transcript mismatch and assert rejection before any peer/file metadata or bytes are sent.
2. **Role, version, and session binding:** The confirmation and all subsequent authorization are bound to the sender/receiver roles, the profile and version specified by the eventually reviewed profile, and a unique transfer session. **Test:** swap roles, alter the profile/version, or change the session identifier; each case must invalidate the confirmation/authorization and fail closed. Until a profile is reviewed, profile-dependent tests remain blocked or unverified.
3. **Gate B — Two independent identity confirmations before peer/file metadata:** Each endpoint's user must independently confirm the matching session-bound value; one user's action cannot stand in for the other's. Before both confirmations succeed, neither endpoint sends or accepts peer/file application metadata (including peer/device identity claims, filenames, file counts/sizes, previews, or a transfer request), except for the minimum discovery/control fields expressly allowed by Gate A and data strictly required to establish the session transcript. After matching confirmations, peer/file metadata may be presented for review. **Test:** capture both directions with zero, one, and two confirmations; assert that zero or one permits only Gate A's fields and required transcript data, and that a mismatch aborts before peer/file metadata or bytes.
4. **Gate C — Separate receiver acceptance before bytes:** Only after both identity confirmations and presentation of the transfer request may the receiver explicitly accept the exact pending session and selected file set in a distinct action. Discovery, peer selection, and identity confirmation are not transfer consent. **Test:** assert that no file-content bytes are sent before this separate acceptance, including after an earlier transfer; decline, timeout, or acceptance for a different session/file set sends no bytes.
5. **Replay, downgrade, and stale-peer rejection:** Reject replayed, duplicated, expired, or cross-session confirmations, authorizations, and transfer messages; reject fallback to an unapproved version or plaintext; invalidate discovered peers after a network, interface, or local-address change until rediscovered. **Test:** exercise each case and assert fail-closed behavior with no further peer/file metadata or file bytes; stale peers cannot initiate a transfer.
6. **Redirect and 0-RTT fail-closed:** Any redirect during session establishment terminates the session; do not automatically follow or retry at a different endpoint. Reject 0-RTT or other replayable early application data; do not send or accept peer/file metadata or file bytes through it. **Test:** inject a redirect and an early-data attempt and assert session failure with no peer/file metadata or bytes sent to or accepted from the redirected endpoint or as early data.

- Peer announcements, names, addresses, metadata, and request bodies are untrusted. Requests have bounded sizes and timeouts, rate/connection limits, and deterministic cleanup after rejection, cancellation, disconnect, or malformed input.
- Listener bind scope and lifetime are deliberate, visible, and stoppable. Tests from another host confirm the service is not unintentionally exposed beyond intended local-network interfaces.
- A threat model covers hostile peers on shared Wi-Fi, spoofed discovery, wrong first-contact identity, replay, malicious metadata/names, resource exhaustion, and local privilege boundaries. Logs contain no file contents, tokens, or unnecessary private paths.

### 3. Safe writes and integrity

- Peer-supplied names and metadata cannot select paths outside the user-selected destination. Validate separators, absolute/traversal paths, reserved or incompatible names, invalid Unicode, hidden-name cases, and length limits. Collision handling is predictable and visible; symlinks and races cannot redirect a write outside the destination.
- Stream with backpressure; do not load whole files into memory. Enforce agreed file/session/request/connection/temp-storage limits and fail clearly on insufficient space or permissions.
- Receive each file into a temporary file on the destination filesystem. Verify expected byte count and a cryptographic content hash, then finalize with a platform-safe atomic rename or equivalent. A partial or mismatched file is never marked complete or left under its requested final name. **A content hash detects corruption; it does not authenticate the peer.**
- On failure or cancellation, remove temporary content safely or retain it only as a clearly identified recoverable partial. Never execute or auto-open received content. Arbitrary extensions remain transferable; safety comes from inert storage, path validation, resource limits, and explicit user action.

### 4. Cancellation, retry, and recovery

- Test cancellation before metadata, while consent is pending, during each file, after the last byte but before verification/finalization, and after one file completes in a multi-file request. Both peers converge on a clear status and release listeners, slots, streams, timers, and temporary files.
- Retry is bounded and user-visible. The selected retry/resume policy prevents duplicate final files and never trusts an unverified client-reported offset. If Phase 2 restarts a file from byte zero, the UI says so; resumability is not implied.
- Wi-Fi/address change, sleep/resume, listener failure, sender/receiver termination, and restart produce a deterministic outcome. On restart, completed and incomplete files are distinct; abandoned temporary files are safely cleaned or labelled; no partial transfer is reported as successful.
- Persist only the local transaction information required by the approved recovery policy. Persistent peer pairing, durable peer authorization, and implicit future acceptance remain out of scope. Define history retention and privacy before persisting records.

### 5. Verification and shipping gates

| Gate | Evidence required |
|---|---|
| Automated protocol tests | Cover the pre-confirmation discovery-disclosure whitelist; no peer/file metadata before bilateral identity confirmation; separate identity and transfer-consent gates; accept/decline/subset; wrong/expired/replayed tokens; identity mismatch; malformed/oversized metadata; checksum mismatch; path/name attacks; collisions; timeout; disk full; cancellation at each boundary; disconnect; retry; and restart recovery. |
| Real-network integration | Use at least two distinct devices on the same LAN; verify exact output bytes and hashes. Capture the selected discovery mechanism's pre-confirmation traffic and verify only permitted minimal fields are visible. Exercise claimed IPv4/IPv6, working and blocked discovery, manual address, firewall denial, client isolation, VPN/multiple interfaces, and cold start/sleep-resume as applicable. Loopback alone is not LAN evidence. |
| Filesystem matrix | Cover zero-byte, small, large, many-file, Unicode/long/reserved names, existing files, permissions, symlink/path traversal, and near-full storage on each claimed OS. Physical-device cases not run are unverified. |
| Performance | Report throughput, peak memory, CPU, first-byte latency, and UI responsiveness on representative hardware/Wi-Fi. Set numeric pass thresholds from project goals before release. |
| Release | CI passes on the release commit; threat-model review and dependency/security scans are recorded; clean-install and upgrade behavior are verified on each claimed platform; package permissions are minimal; install, firewall, privacy, support, and known-limitations guidance is present. No production-ready claim while required platform/network evidence is missing or a critical/high security issue remains. |

## Phase 2 exit definition

Phase 2 is complete only when the decisions above are recorded, every applicable criterion has reproducible evidence, real two-device LAN transfers pass the supported platform matrix, and incomplete/failed transfers cannot be mistaken for completed files. A mock-only test, green CI run, loopback transfer, or one-device demo is insufficient on its own.

## Phase 1 reconciliation and issue mapping

### Disposition rules

**Done** means the issue's complete Phase 1 acceptance is met by evidence. **Still in scope** means the requirement carries into the accepted direct-transfer product or a supported-platform release gate. **Intentionally deferred** means the remaining work is mock-only polish or belongs to synchronization/pairing outside the accepted scope. A deferred issue is **not closed** and a mock is not evidence of real transfer. Only issue #2 is complete enough to close; issues #3–#8 remain open.

### Issues #2–#8 on the baseline

All seven issues were open at the inventory snapshot; there were no open pull requests. After reconciliation, only #2 is closed. The status here records the accepted scope, not an assertion that deferred work is complete.

| Issue | Disposition | GitHub state after reconciliation | Mapping and evidence |
|---|---|---|---|
| [#2 — State, mock services, validation foundation](https://github.com/Theblackcat98/SyncWeave/issues/2) | **Done** | Closed | `src/state/app-state.ts`, `src/domain.ts`, `src/services/`, `src/ui/`, `package.json`, CI, and smoke/tests satisfy the issue's architecture and mock-validation definition. This does not claim real transfer. |
| [#3 — Visual system and layout primitives](https://github.com/Theblackcat98/SyncWeave/issues/3) | **Still in scope** | Open | Tokens, reusable components, ASCII fallback, and responsive headless layouts exist; Termux/Android and full terminal-glyph compatibility remain unverified. Resolve the platform matrix and test every claimed target. |
| [#4 — Mock filesystem workspace and selection](https://github.com/Theblackcat98/SyncWeave/issues/4) | **Intentionally deferred** | Open | The browse/stage/review/consent flow is mostly present. Remaining rich mock metadata, configurable sync scenarios, and conflict-state display are not required for file transfer. Real source selection and a receiver destination remain Phase 2 acceptance criteria; they are not satisfied by the mock filesystem. |
| [#5 — Modal infrastructure and mock peer/QR pairing](https://github.com/Theblackcat98/SyncWeave/issues/5) | **Intentionally deferred** | Open | Page-based screens, timeout/retry, and consent exist; reusable overlay modals and a scannable mock-pair QR are not required. Persistent pairing is excluded. Phase 2 still requires a separately specified, session-only authenticated peer identity and per-transfer consent. |
| [#6 — Visual diff and hunk staging](https://github.com/Theblackcat98/SyncWeave/issues/6) | **Intentionally deferred** | Open | Diff/synchronization and hunk-based transfer are outside the accepted one-way file-transfer scope. The current screen is a unified mock list; it is not a side-by-side or real file diff. |
| [#7 — Mock transfer engine, queue, progress, animation](https://github.com/Theblackcat98/SyncWeave/issues/7) | **Still in scope** | Open | The mock demonstrates consent, progress, cancel/fail/retry, and completion. Phase 2 carries the actual per-file lifecycle, safe cancellation, integrity, and recovery into a real transfer path. Do not add more mock concurrency/animation as a substitute. |
| [#8 — Responsive/mobile UX and end-to-end polish](https://github.com/Theblackcat98/SyncWeave/issues/8) | **Still in scope** | Open | Responsive headless layouts, help, and mouse/keyboard flows exist; platform support, Termux/physical touch validation, and some wide-layout/onboarding polish remain unresolved. Device checks are conditional on the supported-platform decision. |

### Unchecked Phase 1 TODO crosswalk

The original baseline reported 26 unchecked items. The code audit found two items marked checked that are not implemented: the diff is not side-by-side, and Enter stages a file rather than an individual hunk. Those boxes have been corrected to unchecked. The Phase 1 checklist therefore now has **28 unresolved entries**, not 26. No missing behavior was marked done to preserve the old count. The original Phase 1 line numbers below refer to `phase1.md` at the baseline commit; the new 258 and 264 entries were previously checked and are now unchecked.

| Original line | Remaining TODO | Disposition | Issue | Rationale / carrying location |
|---:|---|---|---:|---|
| 103 | Verify Termux rendering | **Still in scope** | #3, #8 | Release gate if Termux is supported; resolve platform matrix and do real-device verification. |
| 104 | Audit Android glyph compatibility | **Still in scope** | #3, #8 | Conditional on Android/Termux support; selected ASCII fallback tests are not a font audit. |
| 163 | Rich mock metadata | **Intentionally deferred** | #4 | Timestamps/file counts are not required for direct file transfer; request names and sizes are required in Phase 2. |
| 164 | Configurable mock scenarios | **Intentionally deferred** | #4, #7 | Demo-only variation is superseded by real files and real transfer outcomes. |
| 185 | Conflict state | **Intentionally deferred** | #4 | Conflict display belongs to two-way synchronization, which is out of scope. |
| 187 | State-transition animation | **Intentionally deferred** | #7 | Animation polish is not a Phase 2 safety or transfer gate; real status transitions remain required. |
| 225 | Persistent transfer queue | **Still in scope** | #7 | Phase 2 recovery must preserve enough local transaction status to distinguish interrupted and completed files. This is not persistent peer pairing; retention/privacy is a design gate. |
| 237 | Simulated connection establishment/failure | **Intentionally deferred** | #5 | Do not invest in a mock connection; Phase 2 implements and tests real connection success/failure states. |
| 253 | Persistent-pairing exchange, confirmation, storage, revocation, and consent semantics | **Intentionally deferred** | #5 | The Phase 2 scope decision excludes persistent pairing. Any future pairing proposal needs a separate reviewed protocol/security design before implementation. |
| 258* | Side-by-side mock diff content | **Intentionally deferred** | #6 | Corrected to unchecked: current `src/ui/render.ts` renders one linear list, not local/remote columns. Diff UX is out of scope. |
| 264* | Mock hunk staging with Enter | **Intentionally deferred** | #6 | Corrected to unchecked: Enter stages the whole file, not a selected hunk. Hunk-level sync is out of scope. |
| 266 | Real diff engine integration | **Intentionally deferred** | #6 | Real comparison is not needed for direct file send/receive. |
| 267 | Syntax highlighting | **Intentionally deferred** | #6 | Diff presentation is outside the accepted Phase 2 scope. |
| 268 | Synchronized scrolling | **Intentionally deferred** | #6 | No two-pane diff is required for direct transfer. |
| 269 | Multiple-hunk selection model | **Intentionally deferred** | #6 | Phase 2 sends selected files, not selected synchronization hunks. |
| 276 | Full wide-layout metadata/breadcrumb treatment | **Intentionally deferred** | #8 | Phase 2 requires clear peer, file name/size, destination, and progress; full breadcrumb polish is not a release gate. |
| 300 | Validate Termux touch behavior | **Still in scope** | #5, #8 | Conditional release gate if Termux/Android is supported; headless mouse tests do not prove physical touch. |
| 313 | Success/failure transition animations | **Intentionally deferred** | #7 | Correct status and recovery matter; animated transitions do not. |
| 314 | Validate idle CPU behavior | **Still in scope** | #7 | Carry into Phase 2 performance evidence for idle and active behavior on supported targets. |
| 321 | Help modal | **Intentionally deferred** | #5, #8 | A help screen already exists; Phase 2 does not require overlay-modal architecture. |
| 322 | Confirmation modal | **Intentionally deferred** | #5 | Per-transfer consent is mandatory, but it may use the existing page/screen model rather than an overlay. |
| 323 | Error modal | **Intentionally deferred** | #5 | Clear error states/actions are required; a reusable modal is not. |
| 324 | Peer-selection modal | **Intentionally deferred** | #5 | Discovery/manual address and visible peer selection are Phase 2 requirements; a modal is not. |
| 325 | Shared modal sizing/borders/focus | **Intentionally deferred** | #5 | No shared modal system is needed for the accepted page-based flows. |
| 327 | Mouse/touch dismissal of modals | **Intentionally deferred** | #5, #8 | Modal dismissal is irrelevant without modal overlays; supported input modes remain part of platform validation. |
| 338 | First-launch onboarding | **Intentionally deferred** | #8 | Useful polish, but not a direct-transfer acceptance or safety gate. |
| 409 | Test Termux | **Still in scope** | #3, #8 | Conditional on Termux being a supported target; report as unverified until tested. |
| 411 | Test light/dark terminal backgrounds | **Intentionally deferred** | #8 | Optional visual-environment polish; not a Phase 2 transfer gate. |

**Resolved scope decision:** Phase 2 excludes persistent pairing and durable peer trust; every incoming transfer still requires its own consent. Session-level peer authentication remains a Phase 2 design gate. The edited `phase1.md` marks both audited diff items as unchecked.

### Conflicts and documentation corrections

1. `phase1.md` had marked side-by-side diff content and Enter-to-stage-a-hunk complete, but the code is single-column and stages the whole file. Both are now unchecked and intentionally deferred.
2. Page-based peer/diff/consent/help screens were sometimes grouped under “modal” language. The code and checklist now distinguish existing screens from missing reusable modal overlays; Phase 2 does not require overlays.
3. “Connected”/“pairing” language describes only the mock visual journey. It does not create a connection, authenticated identity, trust, or permission to accept future transfers. Phase 2 requires session-only identity verification and fresh consent.
4. A checked mock mouse/touch workflow and headless viewport tests do not establish Termux/physical-device behavior. Termux, Android glyph, and touch checks remain conditional release evidence, not passed results.
5. Historical Phase 1 roadmap text included real synchronization and unspecified pairing/transport decisions. It is replaced with the narrow direct-transfer scope in this document; no QUIC, LocalSend API, or persistent-pairing choice is implied.

## LocalSend and security references

LocalSend's published v2.2 protocol describes metadata preparation followed by a receiver decision, direct uploads using session/file tokens, optional SHA-256 verification, and cancellation. Its current v2 server code provides examples of session checks and cleanup. These behaviors inform but do not dictate SyncWeave's design.

- [LocalSend Protocol v2.2](https://github.com/localsend/protocol) — discovery, metadata-only preparation, receiver acceptance/rejection, file upload, cancellation, and optional checksum.
- [LocalSend v2 receiver implementation at inspected commit `14f3a87`](https://github.com/localsend/localsend/blob/14f3a87426eedffaa9d87d011132eca5501abeb8/packages/core/src/http/server/v2.rs) — session/file-token validation, sender binding, checksum handling, cancellation, and cleanup patterns.
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) — untrusted filenames, length/upload limits, storage, and safe handling. This is adapted for arbitrary-file transfer without an extension allowlist.
- [OWASP Transport Layer Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html) — transport confidentiality/integrity and the need to authenticate the intended peer.
- [OWASP Pinning Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Pinning_Cheat_Sheet.html) — pinning is threat-model dependent and requires a tested key-rotation/recovery path.

**Reference caveat:** LocalSend's port, multicast group, API, concurrency model, optional PIN, browser route, and trust details are not SyncWeave requirements. Any selected SyncWeave defaults require their own decision and evidence.
