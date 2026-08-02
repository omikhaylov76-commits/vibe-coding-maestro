# Vibe Coding Maestro

Универсальные «рельсы» для AI-разработки: структура проекта, файловая память, Git bootstrap и механический doctor без расхода LLM-токенов.

## Установка нового проекта

```bash
npx create-vibe-maestro@latest --target ./my-project --name "My Project" --start idea --yes
```

Доступные исходные состояния: `idea`, `materials`, `spec`, `code`.

## Проверка проекта

Пока CLI распространяется одним npm-пакетом, служебную команду запускайте так:

```bash
npx --package create-vibe-maestro@latest vibe-maestro doctor --path ./my-project
```

## Что гарантирует текущий alpha-инкремент

- существующие пользовательские файлы не перезаписываются молча;
- `.gitignore` дополняется построчно;
- новый проект получает ветку `main`, стартовый commit и чистое дерево;
- существующий Git-репозиторий не получает автоматический commit чужого WIP;
- doctor строго проверяет UTF-8/frontmatter всех wiki Markdown, containment локальных ссылок, manifest/checksums/inventory, managed-файлы, Git dirty managed docs, tracked `.env`, contract `hot.md` ↔ active progress и непустой inbox (warning);
- source-файлы проверяются по `.maestro/source-hashes.json` только когда этот отдельный versioned metadata-файл существует; ingestion не выполняется;
- managed `.gitattributes` закрепляет LF, а существующий merged `.gitignore` сохраняет исходный EOL-стиль;
- runtime поддерживает Node.js `>=20.10.0`; test toolchain закреплён на Vitest 2 для того же диапазона.

## Граница доверия checksums

Локальные SHA-256 обнаруживают случайный дрейф, но не могут криптографически
предотвратить совместную подмену файла, manifest и checksums процессом с доступом
на запись. Doctor строго валидирует metadata и сверяет обязательные системные пути
с доверенным inventory текущей установленной версии пакета; цифровых подписей нет.

Интерактивное меню, Cowork discovery/audit и Skill Curator будут добавляться следующими инкрементами после стабилизации ядра.
