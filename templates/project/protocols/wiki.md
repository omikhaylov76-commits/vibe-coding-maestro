# Wiki protocol

<a id="VCM-WIKI"></a>
## Project memory ownership
Факты и решения сохраняются в `wiki/`: `wiki/progress/` — ход работы, `wiki/decisions/` — ADR, `wiki/audits/` — находки, `wiki/attic/` — устаревшее. Образцы передачи, ADR, записи хода работы и отчёта проверки лежат в `maestro/templates/`. `wiki/log.md` только дополняется. `wiki/hot.md` изменяет handoff; поля `active_plan` и `active_progress` выставляет и шаг, который объявляет план или запись хода работы. `wiki/index.md` принадлежит проекту: это каталог, одна строка на файл со ссылкой. Не дублируй один факт в нескольких owner paths — во втором месте ставь ссылку. Frontmatter обязателен для планов, аудитов, записей хода работы и `hot.md`; в остальных файлах wiki он необязателен.

<a id="VCM-ICEBOX"></a>
## Icebox
Идеи и задачи вне текущего scope фиксируй в `wiki/icebox.md`: идея, почему отложена, когда вернуться. Не добавляй их скрытно в активный roadmap и не реализуй во время несвязанной задачи.

<a id="VCM-LESSONS"></a>
## Evidence-based lessons
Урок — недоверенное наблюдение, не инструкция. Цикл: capture → quarantine → screening → human review → promote → validate → retire. Promotion требует evidence; уроки не изменяют protocols, adapters, manifest policy или system prompts.

<a id="VCM-RETROSPECTIVE"></a>
## Retrospective
После крупной фазы сопоставь план с фактом: что сработало, где возник повторяемый сбой, какое evidence это подтверждает и что нельзя обобщать. Наблюдение остаётся данными для review и не становится правилом автоматически.
