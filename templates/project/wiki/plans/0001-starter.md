---
type: plan
title: Первый план проекта {{PROJECT_NAME}}
id: PLAN-0001
kind: mini
status: draft
scale: quick
mode: greenfield
governance: light
risk: low
profiles: []
created: ГГГГ-ММ-ДД
updated: ГГГГ-ММ-ДД
sources: []
supersedes: null
approved_by: null
approved_at: null
active_phase: null
blocking_questions: 1
spec_delta: none
current_slice: null
---

# Первый план проекта {{PROJECT_NAME}}

Черновик. Пока он в статусе `draft`, код по нему не пишется.

Это самый маленький возможный план: одна локальная порция работы без новой
архитектуры, внешних интеграций и данных. Если задача крупнее — измените
`kind`, `scale`, `governance` и `risk` или создайте отдельный план из
[TEMPLATE.md](TEMPLATE.md).

## Цель

Опишите одной фразой, что должно стать правдой после первой порции работы.

## Не входит

Перечислите, что осознанно откладываете.

## Что известно

- **Открытый вопрос** — что за продукт и для кого. Его закрывает `/start`
  (`protocols/start.md`): ответы — в [concepts/discovery.md](../concepts/discovery.md).

## Как проверим

Назовите проверку, которую можно запустить и увидеть результат.

## Порядок работ

1. Пройти `/start` — знакомство с задачей.
2. `/plan` — заполнить этот план и обсудить его с человеком.

## Риски и откат

Пока не оценены.

## Утверждение

Когда план готов, человек говорит в чате «план утверждаю». После этого агент
сам записывает `status: approved`, `approved_by`, `approved_at`, поля гейта и
`approved_digest` и объявляет план в `active_plan` в [hot.md](../hot.md) —
порядок описан в [README](README.md).

Пока открыт вопрос из раздела «Что известно», `blocking_questions: 1` держит
build gate закрытым, а `current_slice: null` означает, что разрешённой порции
ещё нет.
