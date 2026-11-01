# Changelog

All notable changes to Vibe Coding Maestro are documented here.

The project follows Semantic Versioning while prerelease interfaces may still change between beta versions.

## 0.4.2 — 2026-11-01

The third part of 0.4: starting a project. One first step everywhere — create → `/start` → `/plan`; materials in one place, kept byte for byte; a private copy in the cloud from day one. The set of project files changes; `vibe-maestro upgrade` migrates projects from 0.4.1, 0.4.0, 0.3.1, 0.3.0, 0.3.0-beta.1 – beta.4 and 0.2.0-beta.1.

### Added

- **`/start` with its own protocol `protocols/start.md`** (managed, command `.claude/commands/start.md`). The first session reads what already exists — the starting point from `create --start`, materials in `maestro/inbox/` (large files through the `explorer` subagent), what the human said, code in another folder only read-only through `sources`, asking for the path. Then it asks one question at a time, in plain words: seven about the task (what we make; for whom; who gets the result — kept or handed to a customer, team, employer; what «done» means; what else exists; what we do not do; constraints — laws, platform rules, other people's personal data) and six about how we work (who decides and on whose behalf the agent may write; what only after a separate «да»; code right after plan approval or on «начинай»; how to talk; how to hand over keys; where the copy lives and how to restore), each with the agent's proposal as the default. Deadlines and budget are not asked; if named, they are written down. Found answers are shown with their source and a «верно?»; «не знаю» is recorded as UNKNOWN. A draft is kept in the project, so the human can stop and continue; `/start` can be run again to revise one agreement. A one-screen summary with the rhythm of slices, then writing only after «да»: the task to `wiki/concepts/discovery.md`, how we work to the «Как работаем» section of `.claude/rules/project.md` (other sections untouched), the copy and restore to `wiki/restore.md`, the cloud address to the passport. Protections in `settings.json` change only on a separate «да». `protocols/discovery.md` now points to the start; the capabilities `discovery-before-code` and new `project-start` live in `start.md`.
- **Start flag** `start:` in the `wiki/concepts/discovery.md` header: `not_started` → `in_progress` → `done`; `skipped` when the human declines. `protocols/plan.md` Stage A reads the start answers and does not ask again; if the start is not done it offers it once, and after a refusal asks only what the plan needs.
- **`wiki/restore.md`** (belongs to the project): what is in the cloud (address in the passport), what is not (`.env`, key values, personal settings), what to install, how to get the project, how to check it.
- **`README.md`** for a new project, only when the folder has no README of any name; it says the file is read first, also by the recipient, and asks to rewrite it. It is not in the inventory `doctor` checks and may be deleted.
- **A copy in the cloud from day one.** The wizard offers «Создать новый проект и закрытую копию на GitHub» as the last option of its first question, only when the GitHub CLI `gh` is installed and logged in (checked while the welcome is shown, 3 s timeout); still three decisions. For scripts: `create --github`. After the first commit: `gh repo create <name> --private --source <folder> --remote origin --push`; the name is Latin from the folder name (Cyrillic transliterated, empty → `project-YYYYMMDD`). Any `gh` failure is a warning with the command for later; the project stays and the exit code is 0. `--github` with `--no-git` is an error before writing.
- **`create --push-without-asking`** for new projects: `settings.json` gets the guide recipe — plain `git push` allowed; force pushes (`--force`, `-f`, `+branch`) and deleting in the cloud (`--delete`, `-d`, `--mirror`, `--prune`) still ask; one `ask` key. `.claude/rules/maestro.md` names this exception to «push only after a separate „да“».
- `doctor` `info` findings from local Git data only, no network: `git-no-remote`, `git-no-upstream`, `git-unpushed`. They do not fail `--strict` or `preflight`.
- `maestro/inbox/.gitattributes` (managed, `* -text`, written by code like the root `.gitattributes`): Git keeps materials byte for byte, a fresh clone returns the original bytes on any `core.autocrlf`.
- Rules for everyone in `.claude/rules/maestro.md`: check a person's proposal against what already exists and say so if it is not needed or done; plain words, a technical term only with its meaning. «Выбор навыков» in `protocols/plan.md`: installed, GitHub and official Anthropic catalogs; compare several, check `SKILL.md`, `allowed-tools`, hooks; pick the best; install only after «да». Maestro installs nothing itself.

### Changed

- One first step in five places — the create screen, `wiki/hot.md`, `wiki/plans/0001-starter.md`, `.claude/rules/maestro.md`, the README — and in the user guide: create → `/start` → `/plan`. Section names of `wiki/hot.md` are unchanged.
- **Materials without a red check.** `inbox-not-empty` is removed: files in `maestro/inbox/` are not a finding, even with `--strict`. `source-hashes-missing` (still critical) now says that `maestro/sources/` holds only `sources --write` snapshots and points to `maestro/inbox/`. The create screen, `maestro/inbox/README.md` and `protocols/plan.md` say the same.
- `maestro/runbooks/cowork-discovery.md` no longer says Claude Code does not rewrite discovery: Cowork prepares material for `maestro/inbox/`, `/start` writes the answers.
- The passport template says it goes to the recipient in `HANDOVER.md` and should be written for them.
- The `vibe-maestro` companion package (0.1.6) depends on exactly `create-vibe-maestro@0.4.2`.
- Upgrade tests use projects generated by the real published 0.4.1 package.

### For those who create projects with their own scripts

- **Place for materials** — `maestro/inbox/`. Files there no longer give `inbox-not-empty` (it is gone). `maestro/sources/` is only for `vibe-maestro sources --write` snapshots; your own files there are still critical (`source-hashes-missing`).
- **The `-text` rule.** `create` and `upgrade` write `maestro/inbox/.gitattributes` with `* -text`: Git does not change line endings, a fresh clone returns the original bytes. Your own folder for other people's files — put the same `.gitattributes` there. Materials that were committed before the rule are not re-read by Git on their own: run `git add --renormalize maestro/inbox` and commit (checked on Git 2.54: a file Git has already seen is not shown as modified after the rule appears). If a file was already normalized (for example, taken from a fresh clone on another computer), the original bytes exist only in its source.
- **The start flag** — `start: done` in the `wiki/concepts/discovery.md` header. Set it right after `create`, and `/plan` will not offer the start. Values: `not_started`, `in_progress`, `done`, `skipped`. No field = not done.
- **Section names of `wiki/hot.md` do not change:** «Сейчас в работе», «Открытые вопросы», «Следующий шаг». Only the text inside changes for new projects.
- **`create --yes` creates no repository.** A private GitHub repository only with `--github`; push without asking only with `--push-without-asking`. Neither flag acts on a repeated `create` of an existing project.
- **New project files:** `protocols/start.md`, `.claude/commands/start.md`, `maestro/inbox/.gitattributes` (Maestro); `wiki/restore.md` (project). `README.md` only when the root has no README; `doctor` does not require it.
- **`doctor`:** new findings `git-no-remote`, `git-no-upstream`, `git-unpushed` are `info` and block neither `--strict` nor `preflight`.
- **Your own `.claude/commands/start.md`** stops `upgrade` with a clear message: rename it (for example, to `my-start.md`) and run again.
- **Projects before 0.4.2:** `.claude/settings.json` belongs to the project and `upgrade` does not change it — add `Edit(/.claude/commands/start.md)` and `Edit(/maestro/inbox/.gitattributes)` to `deny` if you want the same protection.

## 0.4.1 — 2026-10-31

The second part of 0.4: packing a project for the customer and measuring the session. The set of project files is unchanged; `upgrade` from 0.4.0 rewrites the pinned version, `.claude/rules/maestro.md`, `protocols/handoff.md` and `protocols/completion.md`.

### Added

- **`vibe-maestro pack --tag <tag>`** — a deterministic zip of the delivery tag, with no dependencies. Everything comes from the tag (`git archive`), not from the working folder, so the same tag always gives the same bytes; the command prints the sha256. Maestro and agent files at the root (`wiki/`, `maestro/`, `.claude/`, `protocols/`, `.maestro/`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`) are left out; `HANDOVER.md` is added with «смените все пароли и ключи» and the project passport from the tag. It refuses on likely secrets — `.env`/`.envrc`/`secrets.*`/key and keystore files/SQLite databases by name; private keys, OpenAI, Anthropic, GitHub, AWS, Telegram bot, Supabase service_role, Stripe, npm and Slack tokens, passwords in database URLs and in code by content (values are never printed; public Google browser keys, Supabase anon keys, `…EXAMPLE` keys, placeholders and local database URLs pass) — on agent files nested in the product, on symlinks leading outside the project, on an incomplete passport (a section with the «пока нет» placeholder or no entry), and when a different file is already at the output path. `--allow <path>` skips the check for a file the human has looked at. Submodules are reported as not included. Git settings that would change bytes (`core.autocrlf`, `log.showSignature`) are pinned. Files are stored uncompressed with a Unix timestamp field; modes are normalized to 644/755. Default output is the Desktop; `--out` takes a file or a folder.
- **`vibe-maestro context`** — the size of the current Claude Code session from its transcript (`~/.claude/projects/…`, `$CLAUDE_CONFIG_DIR` respected; only usage numbers are read). It picks the session from `$CLAUDE_CODE_SESSION_ID` when Claude Code provides it, otherwise the newest transcript of the folder. When `$CLAUDE_CODE_SESSION_ID` names a transcript that is missing, it refuses instead of measuring another session. It prints the context size as a share of the model window — 200 000 tokens, or 1 000 000 once the session is larger (`--window` to set) — the total input the session has sent, and plain advice: under 40% continue, from 40% start the next slice in a new session, from 70% hand off now. Entries without usage (`<synthetic>`) are skipped. The thresholds are a hypothesis to be checked by measurement.
- `.claude/rules/maestro.md` and `protocols/handoff.md`: after the handoff of a closed slice the agent runs `context` and tells the human in plain words whether to start a new session. `protocols/completion.md` names the `pack` command.

### Changed

- The `vibe-maestro` companion package (0.1.5) depends on exactly `create-vibe-maestro@0.4.1`.
- Upgrade tests use projects generated by the real published 0.4.0 package.

## 0.4.0 — 2026-10-31

The first part of 0.4: finishing a project and keeping sessions short. The set of project files changes; `vibe-maestro upgrade` migrates projects from 0.3.1, 0.3.0, 0.3.0-beta.1 – beta.4 and 0.2.0-beta.1.

### Added

- **Project passport `wiki/passport.md`** (belongs to the project): repository and delivery tag, where the project runs, domain and DNS, data and backups, external services and whose account they are on, **names** of environment variables and where they are set (never values), schedules, how to run, update and roll back. Kept from day one; an unused section says «не применимо». Works for projects without code too.
- **Completion protocol `protocols/completion.md`** (managed) — the missing last stage of the lifecycle: criteria checked, tests green, delivery tag, complete passport, customer documents with «change all passwords and keys», final handoff, plan closed (`status: completed`, `active_plan: none`), lessons recorded. A separate short path closes an internal project without delivery. Packaging for the customer is named as the step that arrives in 0.4.1. Linked from `protocols/build.md` and `.claude/rules/maestro.md`.
- **New session after a closed slice.** `.claude/rules/maestro.md`, `protocols/build.md` and `protocols/handoff.md` say: a closed slice ends with a handoff and an offer to start a new session; a second large slice is not started in the same session without the human's consent. A long session resends its whole history on every step.
- **API keys without hunting for files.** `.claude/rules/maestro.md` describes two ways: the human pastes the key into the chat and the agent writes it to `.env` without repeating it, or the human asks to «открой окно для ключа» and the agent adds the variable name (`NAME=`) and opens `.env` in an editor (`touch .env && open -e .env` on macOS) for the human to paste the value. It states honestly that a key typed into the chat — or read from `.env` by the agent — stays in the session history, so the agent does not open `.env` without need. The `explorer` and `code-reviewer` subagents do not open `.env` and never quote secret values.
- User guide: «Как подстроить защиты под проект» — the four levels (Maestro template → project `settings.json` and `rules/project.md` → personal `settings.local.json` → session permission mode), the deny → ask → allow order, typical settings in plain words, and that permissions change only on the human's «да». Linked from the README.

### Changed

- The default `.claude/settings.json` no longer denies reading `.env` and `.env.*`. Protection against committing `.env` stays: `.gitignore` and `doctor` (`git-env-tracked`). **Projects created before 0.4.0** keep their `settings.json` (it belongs to the project); to let the agent write keys itself, delete `"Read(.env)"` and `"Read(.env.*)"` from `deny` — the new rules tell the agent to offer this and to change the file only after a «да».
- `.gitignore` of new projects also lists `.claude/worktrees/` (temporary working copies) and `.claude/settings.local.json` (personal settings). `upgrade` appends only the missing lines to an existing `.gitignore`, names them in the proposal, and leaves the project's own lines and line endings as they are.
- The `vibe-maestro` companion package (0.1.4) depends on exactly `create-vibe-maestro@0.4.0`.
- Upgrade tests use projects generated by the real published 0.3.0 and 0.3.1 packages.

## 0.3.1 — 2026-10-31

Small fixes found in the 0.3.0 review and on a live project. The set of project files is unchanged; `upgrade` from 0.3.0 rewrites the pinned version and `.claude/rules/maestro.md`.

### Fixed

- The default `.claude/settings.json` denied editing the whole `.claude/commands/`, `.claude/agents/`, `maestro/runbooks/` and `maestro/templates/` folders, so the agent could not create or edit the project's own commands. Now only Maestro's managed files are denied, by name; whole folders are denied only for `protocols/` and `.maestro/`. `.claude/rules/maestro.md` names the managed commands and agents and says the project adds its own next to them. **Projects created with 0.3.0** keep their `settings.json` (it belongs to the project): replace the folder rules `Edit(/.claude/commands/**)`, `Edit(/.claude/agents/**)`, `Edit(/maestro/runbooks/**)`, `Edit(/maestro/templates/**)` with the per-file list from the new template, or simply delete them.
- Commands inside `doctor`, `create` and `upgrade` messages are wrapped in backticks, so the period that ends a sentence no longer sticks to the path: `--path .` used to read as `--path ..`.
- Re-running `create` on an existing project warns when an explicit `--depth` or `--start` differs from the project and is not applied, instead of reporting success silently.

## 0.3.0 — 2026-10-31

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
