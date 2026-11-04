/**
 * Ориентиры длины памяти проекта: одно место для doctor и archive.
 *
 * HYPOTHESIS 0.4.4: числа подобраны по трём живым проектам, а не по замеру
 * токенов, поэтому doctor о них только сообщает (`info`) и ничего не блокирует.
 */

/** `wiki/hot.md` — около экрана, примерно 60 строк. */
export const HOT_LIMIT = 6_000;
/** Активный план: основа плана и текущая правка. */
export const PLAN_LIMIT = 60_000;
/** `wiki/log.md`: больше — старые записи переносит archive. */
export const LOG_LIMIT = 20_000;
/** Сколько знаков последних записей остаётся в `wiki/log.md` после переноса. */
export const LOG_KEEP = 10_000;
/** Передача, с которой начнёт следующая сессия. */
export const HANDOFF_LIMIT = 6_000;

/**
 * Коммиты кода после последней передачи. HYPOTHESIS 0.4.5: числа — из проигрыша
 * истории трёх живых проектов; поэтому doctor только сообщает (`info`).
 */
/** Столько коммитов кода, а `wiki/hot.md` не называет текущую порцию. */
export const HOT_BEHIND_COMMITS = 3;
/** Столько коммитов кода без новой передачи. */
export const HANDOFF_COMMITS_LIMIT = 10;

/**
 * Знаки — кодовые точки Unicode после замены CRLF на LF: так счёт одинаков
 * на любой ОС и не зависит от того, как записан перенос строки.
 */
export function countChars(text: string): number {
  return Array.from(text.replace(/\r\n/g, '\n')).length;
}

/** Тысячи через пробел, без зависимости от локали машины. */
export function formatChars(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
