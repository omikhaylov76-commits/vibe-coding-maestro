---
audit_id: AUD-YYYY-MM-DD-slug
status: open
---

<!-- Образец отчёта проверки Maestro. Скопируй в wiki/audits/<audit_id>.md и заполни по protocols/audit.md. Находки — слова, ID и evidence проверяющего, без правок. ID отчёта и находок — латиницей, цифрами, «.», «-», «_» (например, AUD-2026-11-01-login-F001): находку с другим ID doctor не увидит. Каждое поле — одной строкой. Не разобранная ещё находка — status: open, resolution: не исправлено. Проверка исправления — в resolution той же находки; новая находка проверки исправлений — новый ## Finding с новым ID. После последней находки ничего не пиши. Отчёт status: resolved — только когда все находки resolved. -->

# Проверка: что проверяли

Что смотрели: план `wiki/plans/<файл>.md`, порция `<current_slice>`, файлы из «Где правим».

## Finding AUD-YYYY-MM-DD-slug-F001
- severity: high
- target: src/файл.ts:42
- evidence: что воспроизведено — команда, строка или наблюдение
- status: resolved
- resolution: исправлено в <коммит>; проверка исправления: <команда или тест> — находка не воспроизводится

## Finding AUD-YYYY-MM-DD-slug-F002
- severity: medium
- target: src/другой.ts:10
- evidence: что воспроизведено
- status: open
- resolution: не исправляем — причина; где записано (следующая порция или wiki/icebox.md)

## Finding AUD-YYYY-MM-DD-slug-F003
- severity: low
- target: src/файл.ts:44
- evidence: найдено проверкой исправления F001 — что воспроизведено
- status: resolved
- resolution: исправлено в <коммит>
