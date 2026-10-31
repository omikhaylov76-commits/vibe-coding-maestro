# vibe-maestro

A short name for the `vibe-maestro` command of [Vibe Coding Maestro](https://github.com/omikhaylov76-commits/vibe-coding-maestro).

The product is published as [`create-vibe-maestro`](https://www.npmjs.com/package/create-vibe-maestro); `vibe-maestro` is one of its commands. This package only runs that command, so both forms below do the same thing:

```bash
npx --package create-vibe-maestro@latest vibe-maestro doctor --path .
npx vibe-maestro doctor --path .
```

Prefer the first form: it is what generated projects use, and `@latest` always fetches the newest release. `npx` may keep an earlier copy of this package together with the `create-vibe-maestro` version it installed then.

This package is published by the maintainer of `create-vibe-maestro` so that the name cannot be taken by someone else and `npx vibe-maestro` never runs foreign code.

To create a project, use `npx create-vibe-maestro@latest`. Documentation, changelog and issues live in the [main repository](https://github.com/omikhaylov76-commits/vibe-coding-maestro).
