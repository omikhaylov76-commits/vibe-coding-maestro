# {{PROJECT_NAME}}

Тонкий адаптер Claude Code к канону Vibe Coding Maestro.

- Сначала прочитай `wiki/hot.md`.
- План до кода: `protocols/plan.md`; команда `/plan` только направляет туда.
- Основной маршрут: `protocols/build.md`.
- Команды в `.claude/commands/` только направляют к canonical protocols.
- Не редактируй managed `protocols/`; живые факты сохраняй по `protocols/wiki.md`.
- Проверка: `npx --package create-vibe-maestro@latest vibe-maestro doctor --path .`
