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

- **Открытый вопрос** — что за продукт и для кого. Ответ сохраните в
  [concepts/discovery.md](../concepts/discovery.md).

## Как проверим

Назовите проверку, которую можно запустить и увидеть результат.

## Порядок работ

1. Заполнить этот план и обсудить его с человеком.

## Риски и откат

Пока не оценены.

## Утверждение

Когда план готов, человек переводит его в `approved` и проставляет
`approved_by` и `approved_at`. После этого план можно сделать `active` и
объявить в `active_plan` в [hot.md](../hot.md).

Пока открыт вопрос из раздела «Что известно», `blocking_questions: 1` держит
build gate закрытым, а `current_slice: null` означает, что разрешённой порции
ещё нет. Оба поля обновляет человек вместе с утверждением плана.
