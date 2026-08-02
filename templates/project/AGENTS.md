# {{PROJECT_NAME}}

Инструкции для агентов и CLI-ассистентов, поддерживающих формат `AGENTS.md`.
Содержание сознательно совпадает с `CLAUDE.md`: правьте оба файла вместе.

## Порядок работы в начале сессии

1. `wiki/hot.md` — горячий контекст.
2. `wiki/concepts/discovery.md` — подтверждённые рамки продукта.
3. Все `wiki/audits/*.md` со `status: open` — действующие ограничения.
4. `wiki/roadmap.md` и `wiki/index.md` — этап и карта памяти.

## Ownership

- Maestro владеет `.maestro/`, `maestro/runbooks/`, `.claude/commands/` и `.claude/agents/`; они проверяются checksums.
- Cowork возвращает только Markdown-текст для `wiki/concepts/discovery.md` или `wiki/audits/<audit-id>.md`; Cowork не изменяет файлы проекта.
- Человек просматривает diff и импортирует одобренный результат Cowork в указанный путь.
- Claude Code читает discovery и audits, но не переписывает их; Claude Code владеет `wiki/progress/` и техническими решениями в `wiki/decisions/`.
- `wiki/hot.md` обновляет только контролируемая команда `handoff`.
- `wiki/log.md` — append-only: существующие записи не переписываются и не удаляются.

## Правила ведения памяти

- Решения и факты живут в `wiki/`.
- Завершённый шаг — новая append-only запись в `wiki/log.md`.
- Значимое техническое решение — файл в `wiki/decisions/`.
- Устаревшее переносится в `wiki/attic/`, а не удаляется.
- Замечания аудита закрываются по стабильному ID: допустимо обновить только `status` и `resolution` соответствующей находки после проверки человеком; текст и ID не переписываются.

## Границы

- Файлы пользователя не перезаписываются без явной просьбы.
- `.maestro/` принадлежит инструменту {{PRODUCT_NAME}}.
- Исходное состояние проекта: `{{STARTING_POINT}}`.

## Проверка

Рабочие команды: `build`, `status`, `wiki`, `handoff`. Инструкции находятся в `.claude/commands/`.

```
npx --package create-vibe-maestro@latest vibe-maestro doctor --path .
```
