# Vibe Coding Maestro

Vibe Coding Maestro создаёт безопасные «рельсы» для AI-разработки: понятную структуру проекта, файловую память, Git bootstrap, Cowork runbooks, Claude-команды и механический doctor без расхода LLM-токенов.

> Текущий статус: prerelease/alpha. Пакет ещё не опубликован в npm. Команды с `@latest` ниже показывают запланированный публичный интерфейс и заработают после публикации. Для разработки клонируйте репозиторий, выполните `npm ci && npm run build` и запускайте файлы из `dist/bin/`.

## Самый простой старт

Одна команда:

```bash
npx create-vibe-maestro@latest
```

Интерактивный мастер проведёт новичка через три шага:

1. выбрать действие: создать новый проект, подключить существующий или проверить его;
2. указать папку и понятное имя;
3. выбрать starting point, после чего Maestro создаст структуру и проверит результат.

CLI не требует от вас заранее разбираться в manifest, checksums или Git bootstrap.

## Автоматический/noninteractive запуск

Для CI или скрипта явно передайте все решения:

```bash
npx create-vibe-maestro@latest --yes --target "./My Project" --name "My Project" --start idea
```

Проверка готового проекта:

```bash
npx --package create-vibe-maestro@latest vibe-maestro doctor --path "./My Project"
```

## Выберите starting point

- `idea` — есть только идея. Следующий шаг: заполнить discovery, assumptions и границы MVP.
- `materials` — есть заметки/файлы. Следующий шаг: положить ссылки на материалы в inbox и провести discovery без изменения источников.
- `spec` — требования уже сформулированы. Следующий шаг: сверить roadmap, non-goals и открытые вопросы перед реализацией.
- `code` — код существует. Следующий шаг: сначала audit и карта текущей системы, затем отдельный план изменений.

## Работа после init

Начинайте с `wiki/hot.md`: это краткий текущий контекст. Постоянные знания переносите в wiki, а входящие материалы регистрируйте через `maestro/inbox/`.

### Cowork runbooks

- `maestro/runbooks/cowork-discovery.md` — копируемый prompt для исследования sources, assumptions, MVP, non-goals и open questions; Cowork не пишет код.
- `maestro/runbooks/cowork-audit.md` — проверка существующего проекта и структурированные findings.

### Claude commands

В Claude Code доступны проектные команды:

- `/build` — реализация согласованного шага;
- `/status` — механический статус и блокеры;
- `/wiki` — обновление файловой памяти;
- `/handoff` — передача контекста следующей сессии.

Точные инструкции находятся в `.claude/commands/`. Перед работой Claude читает `CLAUDE.md`, `AGENTS.md`, `wiki/hot.md`, discovery и открытые audits.

### Skills inventory

Maestro только инвентаризирует локальные `SKILL.md` и выдаёт рекомендации:

```bash
npx --package create-vibe-maestro@latest vibe-maestro skills --path "./My Project"
```

Skills не устанавливаются автоматически, а init/doctor/inventory сами не обращаются к сети. Решение об установке и запуске всегда остаётся у человека.

## Что проверяет doctor

- UTF-8 и frontmatter wiki Markdown;
- containment локальных ссылок;
- manifest, checksums, trusted inventory и managed-файлы;
- Git-инварианты, dirty managed docs и tracked `.env`;
- согласованность `hot.md` с active progress;
- audits и блокирующие open high/critical findings;
- source hashes, если отдельный versioned metadata-файл существует.

Существующие пользовательские файлы не перезаписываются молча; `.gitignore` дополняется, а существующий Git-репозиторий не получает автоматический commit чужого WIP. Новый проект получает ветку `main`, стартовый commit и чистое дерево.

## Безопасность и миграция

Maestro не является sandbox. Честные границы описаны в `docs/THREAT_MODEL.md`. Переход существующего проекта на v1 — только read-only анализ и ручная миграция по `docs/MIGRATION_V1.md`; автоматической перезаписи нет.

Runtime: Node.js `>=20.10.0`. Правила разработки и обязательные gates: `CONTRIBUTING.md`.
