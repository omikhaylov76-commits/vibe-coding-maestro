# Build protocol — router

Канонический маршрут разработки. Адаптеры только направляют сюда.

1. Всегда: [правила и human gates](build/step-1-rules.md).
2. Всегда: [спецификация и Constitution Check](build/step-2-spec.md).
3. Standard/Advanced: [архитектура и сложность](build/step-3-architecture.md).
4. Всегда: [Task Context Capsule и бюджет](context-budget.md).
5. Всегда: [TDD feature loop и live evidence](build/step-5-feature-loop.md).
6. Standard/Advanced: [аудит плана](build/audit-plan.md) и [независимое ревью](audit.md).
7. Advanced: [seams](seams.md), [council reconciliation](build/audit-phase.md), [lessons](lessons.md).
8. Завершение: [wiki](wiki.md), [status](status.md), [handoff](handoff.md).
9. До кода при неизвестных: [discovery](discovery.md), затем [planning gate и утверждение человеком](plan.md).
10. Утверждённый активный план задаёт ровно одну текущую разрешённую порцию и её стоп-гейт.
11. До первой строки кода: `npx --package create-vibe-maestro@latest vibe-maestro preflight --path .`. Гейт механический: он читает `active_plan` в `wiki/hot.md`, статус плана, след утверждения человеком и поля `blocking_questions`, `spec_delta`, `current_slice`, а для программы — `current_phase_approved`. Блокировка означает возврат в [plan](plan.md), а не обход проверки.
