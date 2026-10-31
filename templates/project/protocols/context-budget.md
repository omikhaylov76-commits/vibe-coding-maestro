# Context budget

<a id="VCM-TASK-CAPSULE"></a>
## Task Context Capsule
Капсула содержит цель, acceptance criteria, ограничения, owner paths, затрагиваемые файлы, команды проверки, открытые вопросы и запрещённые действия.

<a id="VCM-CONTEXT-BUDGET"></a>
## Deterministic context pipeline
Собирай контекст в порядке: `wiki/hot.md` → capsule → active spec/plan → открытые audits → только нужные source-фрагменты. Зафиксируй лимит строк/байтов, стабильную сортировку и список пропусков; не обрезай молча. Держи `wiki/hot.md` в пределах экрана (ориентир — до 60 строк): справочные сведения выноси в отдельные файлы и ставь на них ссылку из `wiki/index.md`. Большой файл или широкий поиск поручай разведчику `.claude/agents/explorer.md`: он вернёт выжимку с путями, а не весь текст.
