# Build protocol — router

Канонический маршрут разработки. Адаптеры только направляют сюда.

Каждая сессия начинается одинаково: `wiki/hot.md` → `git log --oneline -10` и `git status` → прогон проверок проекта (тесты и `doctor`) до новой работы. Красное на старте чинится или фиксируется до порции, а не смешивается с ней.

1. Всегда: [правила и human gates](#VCM-HUMAN-AUTHORITY).
2. Всегда: [спецификация и Constitution Check](#VCM-CONSTITUTION).
3. Standard/Advanced: [архитектура и сложность](#VCM-DESIGN-BEFORE-CODE).
4. Всегда: [Task Context Capsule и бюджет](#VCM-TASK-CAPSULE).
5. Всегда: [TDD feature loop и live evidence](#VCM-TDD-LOOP).
6. Standard/Advanced: после порции и зелёных тестов — [независимое ревью](audit.md#VCM-INDEPENDENT-REVIEW), затем исправления и проверка только исправлений. [Аудит плана](audit.md#VCM-PLAN-AUDIT) идёт раньше — до утверждения плана (`plan.md`, Stage E).
7. Advanced: [seams](audit.md#VCM-SEAMS), [council reconciliation](audit.md#VCM-ADVANCED-COUNCIL), [lessons](wiki.md#VCM-LESSONS).
8. Конец порции: [wiki](wiki.md), [status](status.md), [handoff](handoff.md). Закрыл порцию — передача дел и предложение начать новую сессию; вторую крупную порцию в той же сессии без согласия человека не начинать.
9. До кода при неизвестных: [старт](start.md), затем [planning gate и утверждение человеком](plan.md).
10. Утверждённый активный план задаёт ровно одну текущую разрешённую порцию и её стоп-гейт.
11. До первой строки кода: `npx --package create-vibe-maestro@{{MAESTRO_VERSION}} vibe-maestro preflight --path .`. Гейт механический: он читает `active_plan` в `wiki/hot.md`, статус плана, след утверждения человеком и поля `blocking_questions`, `spec_delta`, `current_slice`, а для программы — `current_phase_approved`. Блокировка означает возврат в [plan](plan.md), а не обход проверки.
12. Последняя порция сделана — [завершение проекта](completion.md): сдача заказчику или закрытие внутреннего проекта.

Порядок одной порции: порция → тесты → ревью → исправления → проверка исправлений → передача. Строгость — строже из двух: классификация плана или depth проекта; когда что проверять, шкала и отчёт — [проверки](audit.md).

<a id="VCM-HUMAN-AUTHORITY"></a>
## Human authority
Человек утверждает цель, границы и необратимые решения. Разрушительное действие требует описания последствий, preview и явного подтверждения. При STOP действие прекращается; молчание не считается согласием.

<a id="VCM-DESTRUCTIVE-CONFIRMATION"></a>
## Destructive confirmation
До удаления, перезаписи, миграции, публикации или изменения внешней системы покажи точный scope и последствия. Выполняй действие только после отдельного явного подтверждения человека; общее разрешение на разработку не считается таким подтверждением.

<a id="VCM-ROLE-CAPABILITIES"></a>
## Role capability declaration
Перед работой зафиксируй роль исполнителя, разрешённые действия, запрещённые действия и требуемое evidence. Исследователь не пишет production code, reviewer не исправляет собственные находки, а исполнитель не подменяет независимый review.

<a id="VCM-CLARIFICATION"></a>
## Clarification gate
Если неизвестное меняет архитектуру, безопасность или данные, зафиксируй `NEEDS CLARIFICATION`, перечисли недостающие факты и не пиши production code до решения.

<a id="VCM-CONSTITUTION"></a>
## Constitution Check
До реализации проверь цель, canonical-only границу, human authority, ownership, no-silent-overwrite, тестируемость и release gates. Несоответствие блокирует работу.

<a id="VCM-SPEC-DELTA"></a>
## Spec delta
Любое изменение требований фиксирует: было, стало, причина, затронутые контракты, новые тесты и решение человека, если меняется продуктовая граница.

<a id="VCM-DESIGN-BEFORE-CODE"></a>
## Design before code
До production code опиши пользовательский сценарий, границы системы, данные, failure modes и проверяемый план. Если решение меняет согласованную архитектуру, остановись для человеческого review.

<a id="VCM-COMPLEXITY"></a>
## Complexity Tracking
Перед кодом перечисли компоненты, владельцев данных, стыки, failure modes и отложенный scope. Новая подсистема требует доказательства, что существующий canonical owner не подходит. Для Advanced следуй [seams protocol](audit.md#VCM-SEAMS).

<a id="VCM-TASK-CAPSULE"></a>
## Task Context Capsule
Капсула содержит цель, acceptance criteria, ограничения, owner paths, затрагиваемые файлы, команды проверки, открытые вопросы и запрещённые действия.

<a id="VCM-CONTEXT-BUDGET"></a>
## Deterministic context pipeline
Собирай контекст в порядке: `wiki/hot.md` → capsule → active spec/plan → открытые audits → только нужные source-фрагменты. Зафиксируй лимит строк/байтов, стабильную сортировку и список пропусков; не обрезай молча. Держи `wiki/hot.md` в пределах экрана (ориентир — до 60 строк): справочные сведения выноси в отдельные файлы и ставь на них ссылку из `wiki/index.md`. Большой файл или широкий поиск поручай разведчику `.claude/agents/explorer.md`: он вернёт выжимку с путями, а не весь текст.

<a id="VCM-TDD-LOOP"></a>
## TDD loop
Один контракт за цикл: failing test → подтверждённый RED → минимальный GREEN → refactor при зелёных тестах → полный regression run. Тест проверяет наблюдаемое поведение.

<a id="VCM-LIVE-EVIDENCE"></a>
## Live evidence
Не заявляй готовность по ожидаемому результату. Запиши выполненные команды, exit code, число тестов и известные ограничения; устаревший вывод не является evidence.

<a id="VCM-DETERMINISTIC-VERIFICATION"></a>
## Deterministic verification
Механические проверки должны давать одинаковый результат на неизменном дереве независимо от локали и порядка обхода. Для сериализованного вывода используй стабильные версии схемы и явную сортировку.

<a id="VCM-QUALITY-GATE"></a>
## Quality gate
Перед завершением пройди применимые targeted tests, полный regression suite, typecheck, build, doctor и artifact/packaging checks. Любой блокирующий результат возвращает работу в цикл исправления; пропущенная проверка явно записывается как ограничение.
