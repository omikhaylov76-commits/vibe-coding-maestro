// Поддельный GitHub CLI для тестов: в сеть не ходит.
// FAKE_GH_MODE: ok — вход есть, repo create заводит «облако» локальным bare-репозиторием;
//               noauth — входа нет; fail — repo create отказывает; hang — не отвечает.
// FAKE_GH_LOG — файл, куда дописывается JSON-строка с аргументами каждого вызова.
// FAKE_GH_REMOTES — папка для bare-репозиториев.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const mode = process.env.FAKE_GH_MODE ?? 'ok';
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`);

if (mode === 'hang') setInterval(() => {}, 1_000);
else if (args[0] === 'auth' && args[1] === 'status') {
  if (mode === 'noauth') {
    process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\n');
    process.exit(1);
  }
  process.stdout.write('github.com\n  ✓ Logged in to github.com account tester\n');
} else if (args[0] === 'repo' && args[1] === 'create') {
  if (mode === 'fail') {
    process.stderr.write('GraphQL: Name already exists on this account (createRepository)\n');
    process.exit(1);
  }
  const name = args[2];
  const source = args[args.indexOf('--source') + 1];
  const remotes = process.env.FAKE_GH_REMOTES;
  mkdirSync(remotes, { recursive: true });
  const bare = join(remotes, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['-C', source, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', source, 'push', '-q', '-u', 'origin', 'HEAD'], { stdio: 'ignore' });
  process.stdout.write(`https://github.com/tester/${name}\n`);
} else {
  process.stderr.write(`fake gh: unknown command ${args.join(' ')}\n`);
  process.exit(2);
}
