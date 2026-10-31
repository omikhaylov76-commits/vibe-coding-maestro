# Contributing

Изменения принимаются через небольшие reviewable pull request. Не коммитьте секреты, generated tarballs и чужой WIP.

## Сборка из исходников

Пользователям Maestro исходники не нужны: проект создаётся командой `npx create-vibe-maestro@latest`. Для разработки самого Maestro:

```bash
git clone https://github.com/omikhaylov76-commits/vibe-coding-maestro.git
cd vibe-coding-maestro
npm ci
npm run build
node dist/bin/create-vibe-maestro.js --help
```

Требования: Node.js 20.10 или новее, npm и Git.

## TDD

Для исправления или контракта сначала добавьте тест и зафиксируйте ожидаемый RED, затем минимальную реализацию и GREEN. Cross-platform поведение не реализуйте платформенными shell-трюками, если достаточно Node API.

## Перед пушем

```bash
npm run check
```

`check` — это `npm test`, `npm run typecheck` и `npm run build`. CI на ветке делает ровно это на Ubuntu с Node 22; полная матрица идёт только на pull request и `main`, поэтому лучше поймать ошибку локально.

## Обязательные gates перед релизом

Запускайте из корня на поддерживаемой версии Node.js:

```bash
npm ci
npm audit --audit-level=low
npm run check
npm pack --dry-run --json
npm run acceptance
```

Acceptance (`scripts/ci-acceptance.mjs`) требует доступный `git`, создаёт временный проект с пробелом в пути и удаляет его. Проверьте также содержимое pack JSON: runtime tarball должен включать `dist`, `templates`, `schemas`, `registry`, `docs` (руководство пользователя, на которое ссылается README), README и LICENSE, но не тесты и не служебные файлы разработки.

## Новая версия

- Шаблоны и состав файлов не менялись — допишите версию в `versions` последней записи `src/core/upgrade/releases.ts`.
- Менялись — заведите новую запись, а в прошлую положите копии изменённых шаблонов в `registry/baseline/<id>/project/`. Тест `tests/upgrade-releases.test.ts` подскажет, чего не хватает.
- Обёртка `packages/vibe-maestro` зависит от точной версии `create-vibe-maestro`: поднимите обе. Публикуется сначала `create-vibe-maestro`, потом обёртка.
