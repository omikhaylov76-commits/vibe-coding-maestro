# Contributing

Изменения принимаются через небольшие reviewable pull request. Не коммитьте секреты, generated tarballs и чужой WIP.

## TDD

Для исправления или контракта сначала добавьте тест и зафиксируйте ожидаемый RED, затем минимальную реализацию и GREEN. Cross-platform поведение не реализуйте платформенными shell-трюками, если достаточно Node API.

## Обязательные gates

Запускайте из корня на поддерживаемой версии Node.js:

```bash
npm ci
npm audit --audit-level=low
npm test
npm run typecheck
npm run build
npm pack --dry-run --json
node scripts/ci-acceptance.mjs
```

Acceptance требует доступный `git`, создаёт временный проект с пробелом в пути и удаляет его. Проверьте также содержимое pack JSON: runtime tarball должен включать `dist`, `templates`, `schemas`, `registry`, README и LICENSE, но не tests/docs без runtime-причины.
