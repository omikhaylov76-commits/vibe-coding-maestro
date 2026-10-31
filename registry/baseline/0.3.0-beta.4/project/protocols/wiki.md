# Wiki protocol

<a id="VCM-WIKI"></a>
## Project memory ownership
Факты и решения сохраняются в `wiki/`: `wiki/progress/` — ход работы, `wiki/decisions/` — ADR, `wiki/audits/` — находки, `wiki/attic/` — устаревшее. `wiki/log.md` только дополняется. `wiki/hot.md` изменяет только handoff. Не дублируй один факт в нескольких owner paths.

<a id="VCM-ICEBOX"></a>
## Icebox
Идеи и задачи вне текущего scope фиксируй в Icebox с причиной откладывания и условием возврата. Не добавляй их скрытно в активный roadmap и не реализуй во время несвязанной задачи.
