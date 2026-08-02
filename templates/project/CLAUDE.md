# {{PROJECT_NAME}}

Инструкции для Claude Code, работающего с этим проектом.
Файл создан командой `{{CREATE_COMMAND}}` ({{PRODUCT_NAME}}).

## Порядок работы в начале сессии

1. Прочитайте `wiki/hot.md`.
2. Прочитайте `wiki/concepts/discovery.md`.
3. Прочитайте все `wiki/audits/*.md` со `status: open`.
4. Сверьтесь с `wiki/roadmap.md` и `wiki/index.md`.

## Ownership

- Maestro владеет `.maestro/`, `maestro/runbooks/`, `.claude/commands/` и `.claude/agents/`; они проверяются checksums.
- Cowork возвращает только Markdown-текст для `wiki/concepts/discovery.md` или `wiki/audits/<audit-id>.md`; Cowork не изменяет файлы проекта.
- Человек просматривает diff и импортирует одобренный результат Cowork в указанный путь.
- Claude Code читает discovery и audits, но не переписывает их; Claude Code владеет `wiki/progress/` и техническими решениями в `wiki/decisions/`.
- `wiki/hot.md` обновляет только контролируемая команда `handoff`.
- `wiki/log.md` — append-only: существующие записи не переписываются и не удаляются.

## Правила ведения памяти

- Факты и решения фиксируйте в `wiki/`, а не только в переписке.
- Завершили шаг — добавьте новую append-only запись в `wiki/log.md`.
- Техническое решение с последствиями — отдельный файл в `wiki/decisions/`.
- Устаревшее переносите в `wiki/attic/`, не удаляйте.
- Замечания аудита закрывайте по стабильному ID: после проверки человеком изменяйте только `status` и `resolution`, не ID и не исходный текст.

## Границы

- Не переписывайте файлы пользователя без явной просьбы.
- Служебный каталог `.maestro/` принадлежит инструменту: правьте его только через `{{SERVICE_COMMAND}}`.
- Исходное состояние проекта: `{{STARTING_POINT}}`.

## Проверка

Рабочие команды: `build`, `status`, `wiki`, `handoff`. Инструкции находятся в `.claude/commands/`.

```
npx --package create-vibe-maestro@latest vibe-maestro doctor --path .
```
