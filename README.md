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
- doctor проверяет manifest, checksums, managed-файлы, wiki-ссылки и отслеживаемые `.env`;
- тексты нормализуются для переносимости Windows/macOS/Linux.

Интерактивное меню, Cowork discovery/audit и Skill Curator будут добавляться следующими инкрементами после стабилизации ядра.
