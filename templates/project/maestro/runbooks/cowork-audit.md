# Cowork Audit

Это копируемый prompt. Cowork не изменяет файлы проекта.

Скопируйте в Cowork:

Проведи аудит предоставленных материалов и верни один Markdown-документ. Frontmatter обязан содержать `audit_id` и `status` (`open`, `resolved` или `waived`). Каждая находка начинается с `## Finding <стабильный-ID>` и содержит поля `severity` (`critical|high|medium|low`), `target`, `status` (`open|resolved|waived`) и `resolution`. Не меняй ID при последующих проверках. Не пиши код и не исправляй файлы.

## Контролируемый импорт результата

Cowork не изменяет файлы проекта. Человек сохраняет результат в `wiki/audits/<audit-id>.md`, просматривает diff и принимает файл. Claude Code читает audit; после исправления разрешено менять только `status` и `resolution` находки по стабильному ID, затем человек проверяет diff. Исходный текст и ID не переписываются.
