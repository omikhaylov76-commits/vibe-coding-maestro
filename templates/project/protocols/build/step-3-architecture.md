# Architecture and complexity

<a id="VCM-DESIGN-BEFORE-CODE"></a>
## Design before code
До production code опиши пользовательский сценарий, границы системы, данные, failure modes и проверяемый план. Если решение меняет согласованную архитектуру, остановись для человеческого review.

<a id="VCM-COMPLEXITY"></a>
## Complexity Tracking
Перед кодом перечисли компоненты, владельцев данных, стыки, failure modes и отложенный scope. Новая подсистема требует доказательства, что существующий canonical owner не подходит. Для Advanced следуй [seams protocol](../seams.md).
