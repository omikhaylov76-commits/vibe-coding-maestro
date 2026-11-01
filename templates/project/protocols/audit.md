# Audit protocol

<a id="VCM-INDEPENDENT-REVIEW"></a>
## Independent review
Отдельный контекст сначала проверяет spec compliance, затем code quality/security. Каждая находка имеет стабильный ID, severity, target, evidence, status и resolution. Автор реализации не подменяет независимого reviewer.

<a id="VCM-PLAN-AUDIT"></a>
## Independent plan audit
До реализации проверь соответствие спецификации, порядок зависимостей, ownership, rollback/no-loss, тесты и осознанно отложенный scope. Блокеры исправляются в плане до кода.

<a id="VCM-SEAMS"></a>
## Seam analysis
Для каждого стыка укажи producer, consumer, формат, owner, trust boundary, идемпотентность, отказ, восстановление и тест. Shared-write seam без арбитра блокирует план.

<a id="VCM-ADVANCED-COUNCIL"></a>
## Council reconciliation
Для Advanced собери независимые роли spec, architecture, security и operations. Устрани противоречия evidence-first и выпусти один список: blockers, required fixes, accepted risks, verdict. Голосование не заменяет доказательство.
