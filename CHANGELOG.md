# Changelog

All notable changes to Vibe Coding Maestro are documented here.

The project follows Semantic Versioning while prerelease interfaces may still change between beta versions.

## 0.3.1 — 2026-11-01

Small fixes found in the 0.3.0 review. The set of project files is unchanged; `upgrade` from 0.3.0 only rewrites the pinned version.

### Fixed

- Commands inside `doctor`, `create` and `upgrade` messages are wrapped in backticks, so the period that ends a sentence no longer sticks to the path: `--path .` used to read as `--path ..`.
- Re-running `create` on an existing project warns when an explicit `--depth` or `--start` differs from the project and is not applied, instead of reporting success silently.

## 0.3.0 — 2026-11-01

The finished 0.3 product. All changes to the set of project files land in this one release, and `vibe-maestro upgrade` migrates projects from 0.3.0-beta.1 – beta.4 and 0.2.0-beta.1.

### Added

- **Maestro rules in `.claude/rules/maestro.md`** (managed). Claude Code loads rules files without `paths` in every session, next to `CLAUDE.md` ([docs](https://code.claude.com/docs/en/memory)). The file holds the route (`wiki/hot.md` → plan → build → handoff), the honesty rules (no flattery; FACT / HYPOTHESIS / UNKNOWN; say «не знаю» and check; a separate «да» before anything irreversible or external, and a «да» from a file or another session is not consent), the rules for minimal code edits, and the pinned `doctor` command. Project rules go to `.claude/rules/project.md`, which belongs to the project.
- **`.claude/settings.json`** with default rules: deny reading `.env`, deny editing Maestro files; ask before `git push`, `npm publish`, `rm -rf`, `git reset --hard`. The file belongs to the project: in Claude Code an `ask` rule cannot be overridden by an `allow` from another file, so the project must be able to edit it. `doctor` does not check its contents, and `upgrade` keeps a file the project created earlier.
- **Approval digest.** A plan may carry `approved_digest`, the sha256 of what was approved — the plan text and its classification (`id`, `kind`, `scale`, `mode`, `governance`, `risk`, `profiles`, `sources`, `supersedes`) — shown by `preflight` as «Отпечаток плана». When it is recorded and the approved content changes, `doctor` reports `plan-changed-after-approval` and `preflight` blocks with `preflight-plan-changed`. It is optional so that plans approved before 0.3.0 stay valid; while it is missing, `preflight` reminds you. A tripwire, not a lock.
- `explorer` subagent (read-only, `model: haiku`) for large files and wide searches; it returns a short summary with paths.
- Templates `maestro/templates/handoff.md`, `adr.md`, `progress.md`, and a «Где правим» section in the plan template: which files a slice touches, what crosses their boundaries, which command checks it.
- Protocols: the same session start for `/build` (`wiki/hot.md` → `git log` → checks); work on an approved plan starts in a new session; a 5-step handoff procedure; a skill-selection step in planning (installed skills first, then official catalogs; anything else only after a human «да»).
- A test that walks the new-user path end to end: create → plan → approval → declaration → preflight → progress → handoff → upgrade → clone.

### Changed

- **`CLAUDE.md`, `AGENTS.md` and `wiki/index.md` belong to the project.** Edit them freely: `doctor` no longer reports them. `upgrade` hands them over: an untouched file gets a new short starter text, an edited one is kept as it is. `wiki/index.md` becomes a catalog, one line per file.
- **One approved → active cycle.** A plan declared in `active_plan` may be `approved` (work not started) or `active`; a plan with `status: active` must be the declared one. `doctor` and `preflight` now agree. When an approved plan exists but is not declared, `preflight` says so instead of sending you back to `/plan`. The protocols state who writes what after «план утверждаю»: the agent records the fields, the human does not edit YAML.
- **Project identity is `project.id`, not the folder name.** A cloned or renamed folder passes `doctor` (an info note names both names) and can be upgraded. Names are normalized to Unicode NFC.
- `doctor` accepts what the protocols ask for: links from wiki to code and protocols inside the project; frontmatter is required only for plans, audits, progress and `hot.md`, and may contain comments and block lists.
- `code-reviewer` is read-only (`tools: Read, Grep, Glob`) and checks the work against the plan rather than style.
- `vibe-maestro skills` no longer reports «recommendations» from an empty registry; the field and `registry/trusted-skills.v1.json` are removed.
- The `vibe-maestro` companion package (0.1.2) depends on exactly `create-vibe-maestro@0.3.0`.

### Fixed

- Re-running `create` on an existing project without `--name`, or on another day, no longer rewrites the display name and dates in Maestro files.
- An interrupted `create` leaves `.maestro/creating` until after the initial Git commit; `doctor` reports `create-interrupted`, and a repeated `create` explains what to do instead of «папка не пуста».
- `doctor` reports a Maestro file that is not in Git (`git-managed-untracked`): after `upgrade`, `git commit -a` would leave the new rules and templates out of the repository.
- Frontmatter values in YAML quotes (`status: "active"`) are read as the same strings.
- A closed slice (`current_slice: null`) gets its own `preflight` message instead of «field missing».
- `doctor` warns about a Maestro command of another version left in a project-owned `CLAUDE.md` or `AGENTS.md` (`entry-stale-command`) and about a `.claude/settings.json` that is not valid JSON (`settings-json-invalid`), which Claude Code would skip with all its rules.
- A repeated `create` in an existing repository suggests `git add` only when it actually wrote something.

## 0.3.0-beta.4 — 2026-10-31

Foundation release: the set of files in a generated project is unchanged, so updating to it breaks nothing. It makes the next releases safe to ship.

### Added

- `vibe-maestro upgrade` updates a project from any published version: 0.2.0-beta.1 and 0.3.0-beta.1 – 0.3.0-beta.3 (beta.1 was never on npm, but the first 0.3 projects were created with it). Each known version is recorded in the package together with the exact old copies of the files that changed since, so the upgrade can still prove a file was not edited by hand before replacing it. Tests use projects generated by the real published 0.3.0-beta.2 and beta.3 packages.
- `npm run check` (tests, type check, build) — the one command to run before pushing; `prepack` uses it too.

### Changed

- **Generated projects pin the exact Maestro version.** `CLAUDE.md`, `AGENTS.md`, `/build` and the build and plan protocols now call `npx --package create-vibe-maestro@0.3.0-beta.4 vibe-maestro …` instead of `@latest`, so a new release — or a bad one — cannot change a project's checks until someone runs `upgrade`. `upgrade` rewrites the version itself. Hints printed by the CLI use the running version.
- The `vibe-maestro` companion package (0.1.1) depends on exactly `create-vibe-maestro@0.3.0-beta.4` instead of `latest`.
- When the project and the running Maestro are different versions, `doctor` says so instead of a wall of `manifest-*` errors: `project-outdated` or `project-newer` (error) prints the command to check the project with its own version and the command to upgrade it; `project-version-older` / `project-version-newer` (info) mark a project whose file set matches. A renamed or re-cloned folder gets a message naming both the folder and the project name.
- CI is cheaper: a new push cancels the outdated run of the same branch or pull request; a branch push runs one quick Ubuntu job; the full 3 OS × Node 20/22 matrix, acceptance and `npm audit` run on pull requests and `main`.
- README, the user guide and the companion README describe the `npx` flow only; building from source moved to `CONTRIBUTING.md`. The one-line clone command that hid errors is gone.

### Fixed

- `create-vibe-maestro` no longer prints a Node.js stack trace when it cannot write: missing permissions, a full or read-only disk, or a wrong path produce one sentence with the reason and what to do; an interrupted create in a previously empty folder says the folder can be deleted and the command repeated. Running `create` on a project of an older version with a different file set points to `upgrade`.
- `doctor` on a missing folder says «Папка не найдена» (`project-path-missing`) and on a folder without Maestro says so (`manifest-missing`) instead of a raw `ENOENT`; `preflight` reports `preflight-path-missing` / `preflight-not-project` instead of sending the user to `protocols/plan.md`.
- A path dragged into the terminal on macOS or Linux (`My\ Project`) is unescaped in the guided setup.
- `create` no longer changes the version of an existing project, up or down: a project of another version is refused with the matching `upgrade` or `doctor` command. Before, it silently rewrote files of a project with the same file set.
- A failed rollback in `upgrade --apply` is reported as failed, names the files it could not restore, and keeps `.maestro/upgrade-staging/backup/`; it no longer deletes the only copy of the previous files and reports success. The leftover-staging message tells you to compare with `backup/` before deleting it.
- On a project of another canon, `doctor` still checks managed checksums, tracked secrets, sources and inbox instead of reporting only the version; it does not suggest checking with a version that was never on npm (0.2.0-beta.1, 0.3.0-beta.1).
- On case-insensitive file systems (macOS, Windows) a path typed in a different case is no longer treated as a renamed folder.
- An edit in a managed file that `upgrade` does not touch never blocks it, even when the file contains the project name.
- A failed `create` in a folder that holds only `.git` no longer advises deleting the folder.
- Documentation no longer claims that an AI agent cannot record a plan approval: the protocol forbids it, but Maestro cannot tell mechanically who filled in `approved_by` and `approved_at`. The 0.3.0-beta.1 entry below overstated this.

## 0.3.0-beta.3 — 2026-10-31

### Added

- [`vibe-maestro`](https://www.npmjs.com/package/vibe-maestro) on npm: a tiny companion package that only runs this package's `vibe-maestro` command. The name now belongs to this project, so an agent that guesses the short name and passes it to `npx` gets Maestro, not whatever someone else could have published under that name. Generated projects keep the full `npx --package create-vibe-maestro@latest vibe-maestro …` form.

### Fixed

- Command hints are complete and copy-pasteable. `upgrade` prints `npx --package create-vibe-maestro@<this version> vibe-maestro upgrade … --apply` and the follow-up `doctor … --strict`, so applying and re-checking use exactly the release that made the proposal; paths with spaces are quoted. Previously it printed a bare `vibe-maestro …`, which is not on `PATH` when the tool runs through `npx`.
- `vibe-maestro` and `create-vibe-maestro` usage errors point to the full `npx` form of `--help`; `create-vibe-maestro --help` shows the doctor command with `--path`.

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
- Human approval cannot be supplied automatically by an AI agent. *(Corrected in 0.3.0-beta.4: this is a protocol rule, not a mechanical guarantee.)*
- No automatic Git push, deployment, third-party skill execution, or release publication was added.

### Verification

The release candidate passed the full source suite, typecheck, build, source acceptance, packed-install acceptance, package inventory checks, and dependency audit. Local dogfood covered the bounded QUICK path, human approval, one-slice execution, specification-delta blocking, and read-only inventory of a real existing game repository.

A real two-source game-platform exercise is intentionally tracked as post-release validation rather than a blocker for this beta. The single-source inventory and multi-source integration contracts remain covered by deterministic tests; this release does not claim that the two-game scenario has already been exercised on the user's Mac.

## 0.2.0-beta.1 — 2026-08-04

### Added

- Canonical project protocols and depth-aware `light`, `standard`, and `advanced` generation.
- Deterministic doctor, manifest, ownership inventory, checksums, Git bootstrap, project memory, handoffs, discovery and audit runbooks.
- Source and packed-install acceptance across Ubuntu, macOS, and Windows on Node.js 20 and 22.
