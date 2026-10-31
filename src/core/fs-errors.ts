/**
 * Ошибки файловой системы человеческими словами.
 *
 * Пользователь Maestro не обязан знать, что такое EACCES: ему нужна причина и
 * следующее действие. Код ошибки остаётся в скобках — по нему легко искать помощь.
 */
export function describeFsError(cause: unknown, fallbackPath: string): string {
  const errno = cause as NodeJS.ErrnoException | undefined;
  const code = typeof errno?.code === 'string' ? errno.code : undefined;
  const path = typeof errno?.path === 'string' ? errno.path : fallbackPath;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return `Нет прав на запись: ${path}. Выберите папку внутри своей домашней папки или проверьте права доступа (${code}).`;
    case 'ENOSPC':
    case 'EDQUOT':
      return `На диске закончилось место при записи ${path}. Освободите место и повторите (${code}).`;
    case 'EROFS':
      return `Диск доступен только для чтения: ${path}. Выберите другую папку (${code}).`;
    case 'ENOENT':
      return `Путь не найден: ${path}. Проверьте, что папка существует и путь набран верно (${code}).`;
    case 'ENOTDIR':
      return `Часть пути — файл, а не папка: ${path} (${code}).`;
    case 'ENAMETOOLONG':
      return `Слишком длинный путь: ${path}. Выберите папку ближе к корню диска (${code}).`;
    case 'EMFILE':
    case 'ENFILE':
      return `Система не даёт открыть столько файлов сразу. Закройте лишние программы и повторите (${code}).`;
    default:
      return `Не удалось подготовить проект: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}
