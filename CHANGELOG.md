# Changelog

All notable changes to Vibe Coding Maestro are documented here.

The project follows Semantic Versioning while prerelease interfaces may still change between beta versions.

## 0.3.0-beta.2 — 2026-10-31

First release published to npm. `npx create-vibe-maestro@latest` and `npx --package create-vibe-maestro@latest vibe-maestro …`, which generated projects already call, now resolve to a real package.

### Removed

- **Breaking:** the `--force` flag of `create-vibe-maestro`. It was parsed and documented but never changed behaviour. Passing it is now a usage error (exit code 2) that writes nothing; drop it from scripts. Behaviour without the flag is unchanged.

### Fixed

- `vibe-maestro --help` told `npx` to download a package called `vibe-maestro`, which does not exist: `vibe-maestro` is only a bin inside `create-vibe-maestro`. It now shows `npx --package create-vibe-maestro@latest vibe-maestro <команда>`, matching the templates, so agents cannot be sent to whoever registers that name first. A contract test rejects any `npx` command that pulls another package.
- Test cleanup retries removal of temporary Git repositories, fixing the intermittent `ENOTEMPTY .git/info` failure on macOS with Node 22.

### Changed

- Development dependencies: vitest 4.1.12 and vite 6.4.5, which clear the current `npm audit` advisories. The published package still has no runtime dependencies.
- README and the user guide describe npm installation instead of an unpublished package.
- `package.json` links to the GitHub repository, issues, and README.

## 0.3.0-beta.1 — 2026-08-07

### Added

- Adaptive Planning Gate with `QUICK`, `FEATURE`, `PROJECT`, and `PROGRAM` scales.
- Planning modes for `GREENFIELD`, `EXTENSION`, `INTEGRATION`, and `MIGRATION` work.
- Canonical `protocols/plan.md` shared by the Claude Code `/plan` command and the Cowork plan runbook.
- Project-owned plan artifacts, lifecycle validation, approval metadata, and `active_plan` tracking.
- Mechanical `vibe-maestro preflight` gate that permits exactly one approved build slice and blocks drafts, unresolved questions, specification deltas, and unapproved program phases.
- Bounded QUICK exception for small local work that satisfies all four explicit safety criteria.
- Safe `vibe-maestro upgrade` path for provably canonical 0.2 projects, with dry-run analysis, managed-file conflict detection, staging, rollback, and fail-closed handling.
- Read-only `vibe-maestro sources` inventory for existing projects, including Git provenance, ecosystem evidence, security-conscious traversal, integration boundaries, and project-owned snapshots.
- Guided README and Russian user guide covering the path from idea through planning, approval, bounded build, verification, and handoff.
- Deterministic documentation, upgrade, preflight, source-inventory, packaging, and acceptance contracts.

### Changed

- Generated projects now include planning protocols, `/plan`, Cowork planning guidance, `wiki/plans/`, and `active_plan: none`.
- `/build` now requires the mechanical planning preflight before code is written.
- Product version advanced to `0.3.0-beta.1`.

### Safety boundaries

- Existing source projects are read-only inputs; source inventory is not an importer or converter.
- Non-canonical projects are not modified by `create` or `upgrade`.
- Human approval cannot be supplied automatically by an AI agent.
- No automatic Git push, deployment, third-party skill execution, or release publication was added.

### Verification

The release candidate passed the full source suite, typecheck, build, source acceptance, packed-install acceptance, package inventory checks, and dependency audit. Local dogfood covered the bounded QUICK path, human approval, one-slice execution, specification-delta blocking, and read-only inventory of a real existing game repository.

A real two-source game-platform exercise is intentionally tracked as post-release validation rather than a blocker for this beta. The single-source inventory and multi-source integration contracts remain covered by deterministic tests; this release does not claim that the two-game scenario has already been exercised on the user's Mac.

## 0.2.0-beta.1 — 2026-08-04

### Added

- Canonical project protocols and depth-aware `light`, `standard`, and `advanced` generation.
- Deterministic doctor, manifest, ownership inventory, checksums, Git bootstrap, project memory, handoffs, discovery and audit runbooks.
- Source and packed-install acceptance across Ubuntu, macOS, and Windows on Node.js 20 and 22.
