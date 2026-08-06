---
type: index
title: Планы проекта
updated: ГГГГ-ММ-ДД
---

# Планы

Здесь живут планы проекта. План — это документ, который человек утверждает
до написания кода. Один план описывает одну согласованную порцию работы.

- `TEMPLATE.md` — шаблон нового плана: [TEMPLATE.md](TEMPLATE.md).
- `<номер>-<слаг>.md` — сам план, например `0001-starter.md`.

Каталог принадлежит проекту: Maestro создаёт стартовый набор и больше не
переписывает содержимое. Старые планы не удаляются и не затираются — новая
версия ссылается на предыдущую через `supersedes`.

## Frontmatter плана

```yaml
id: PLAN-0001
kind: mini|feature|project|program|phase
status: draft|in_review|approved|active|blocked|completed|rejected|superseded
scale: quick|feature|project|program
mode: greenfield|extension|integration|migration
governance: light|standard|advanced
risk: low|medium|high|critical
profiles: []
created: ГГГГ-ММ-ДД
updated: ГГГГ-ММ-ДД
sources: []
supersedes: null
approved_by: null
approved_at: null
active_phase: null
```

Дополнительно допустимы общие для wiki поля `type` и `title`. Любое другое
поле считается ошибкой: схема закрыта, чтобы опечатка не выглядела как данные.

## Состояния и утверждение

`draft` → `in_review` → `approved` → `active` → `completed`. Из любого состояния
возможны `blocked`, `rejected` и `superseded`.

- `approved` и `active` обязаны нести `approved_by` и `approved_at` — след
  человеческого решения. Агент не утверждает план сам.
- `draft`, `in_review` и `rejected` не имеют права нести approval metadata.
- В проекте одновременно допустим не более одного плана со `status: active`.
- Активный план объявляется в `active_plan` в [hot.md](../hot.md);
  значение `none` означает, что активного плана нет.

## Что проверяется механически

`vibe-maestro doctor` проверяет схему, состояния, наличие approval metadata,
единственность активного плана, разрешение `supersedes` внутри этого каталога
и существование объявленных project-relative `sources`. Внешние ссылки в
`sources` (URI со схемой) остаются provenance-записью и на диске не проверяются.

Doctor не оценивает качество идеи и не заменяет человека.

## Как появляется план

Маршрут планирования один — `protocols/plan.md`: разбор входа, классификация,
план нужного объёма, саморевью, аудит по риску и утверждение человеком. В
Claude Code его вызывает команда `/plan`, в Cowork — runbook
`maestro/runbooks/cowork-plan.md`. Оба только направляют в этот протокол.

## Отложено

Program/phase layout (`wiki/programs/<слаг>/`) создаётся вручную по протоколу
и пока не перечисляется doctor: планы вне этого каталога не проверяются, а
`supersedes` принимает только `PLAN-nnnn` из этого же каталога.
