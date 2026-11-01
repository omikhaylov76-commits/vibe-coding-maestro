# Feature loop

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
