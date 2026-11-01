# vibe-maestro

A short name for the `vibe-maestro` command of [Vibe Coding Maestro](https://github.com/omikhaylov76-commits/vibe-coding-maestro).

The product is published as [`create-vibe-maestro`](https://www.npmjs.com/package/create-vibe-maestro); `vibe-maestro` is one of its commands. This package only runs that command, so these two lines do the same thing:

```bash
npx --package create-vibe-maestro@0.4.3 vibe-maestro doctor --path .
npx vibe-maestro@0.1.7 doctor --path .
```

Each release of this package depends on one exact version of `create-vibe-maestro` (0.1.7 → 0.4.3), so the same command always runs the same checks. Generated projects use the first form with the version they were created or last upgraded with; it is written in the project's `.claude/rules/maestro.md`.

This package is published by the maintainer of `create-vibe-maestro` so that the name cannot be taken by someone else and `npx vibe-maestro` never runs foreign code.

To create a project, use `npx create-vibe-maestro@latest`. Documentation, changelog and issues live in the [main repository](https://github.com/omikhaylov76-commits/vibe-coding-maestro).
