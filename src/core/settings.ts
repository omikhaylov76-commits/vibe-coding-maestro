/**
 * «Отправка в облако без вопроса» — рецепт из руководства («Как подстроить защиты под проект»)
 * и из `protocols/start.md`: обычный push разрешён, принудительный остаётся с вопросом —
 * «спросить» сильнее «разрешить». Ключ `ask` в файле один.
 */
export const SETTINGS_PATH = '.claude/settings.json';

export const PUSH_ALLOW: readonly string[] = ['Bash(git push *)'];

/** Принудительная отправка, которая может стереть чужую работу: `--force`, `-f`, `+ветка`. */
export const FORCE_PUSH_ASK: readonly string[] = [
  'Bash(git push --force)',
  'Bash(git push -f)',
  'Bash(git push *--force*)',
  'Bash(git push -f*)',
  'Bash(git push * -f*)',
  'Bash(git push * +*)',
];

interface Permissions { deny?: string[]; allow?: string[]; ask?: string[]; [key: string]: unknown }

/** Шаблон settings.json → тот же файл с «отправкой без вопроса»; остальные правила не меняются. */
export function withPushWithoutAsking(settingsJson: string): string {
  const settings = JSON.parse(settingsJson) as { permissions: Permissions; [key: string]: unknown };
  const { deny, allow, ask, ...rest } = settings.permissions;
  const askRules = (ask ?? []).flatMap((rule) => rule === 'Bash(git push *)' ? [...FORCE_PUSH_ASK] : [rule]);
  const permissions: Permissions = {
    ...(deny === undefined ? {} : { deny }),
    allow: [...new Set([...(allow ?? []), ...PUSH_ALLOW])],
    ask: askRules,
    ...rest,
  };
  return `${JSON.stringify({ ...settings, permissions }, null, 2)}\n`;
}
