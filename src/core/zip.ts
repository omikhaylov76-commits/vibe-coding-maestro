/**
 * Детерминированный zip без зависимостей.
 *
 * Файлы хранятся без сжатия (method 0): результат зависит только от входа, а не
 * от версии zlib конкретного Node. Время всех записей одно и то же, имена в UTF-8
 * (флаг 0x0800), права Unix — во внешних атрибутах. Zip64 не поддерживается:
 * слишком большой вход отвергается, а не пишется битым архивом.
 */

export interface ZipEntry {
  /** Путь внутри архива, через `/`. */
  path: string;
  data: Buffer;
  /** Права Unix вместе с типом файла, например 0o100644 или 0o120777 для ссылки. */
  mode: number;
}

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Время и дата MS-DOS из секунд Unix (UTC, шаг 2 с, не раньше 1980 года). */
function dosDateTime(unixSeconds: number): { time: number; date: number } {
  const d = new Date(Math.max(unixSeconds, 315532800) * 1000);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

export class ZipTooLargeError extends Error {}

/** Собирает архив. Порядок записей — как передан: сортирует вызывающий. */
export function buildZip(entries: readonly ZipEntry[], unixSeconds: number): Buffer {
  if (entries.length > MAX_ENTRIES) throw new ZipTooLargeError(`В архиве больше ${MAX_ENTRIES} файлов.`);
  const { time, date } = dosDateTime(unixSeconds);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const size = entry.data.length;
    if (size > MAX_SIZE || offset > MAX_SIZE) throw new ZipTooLargeError(`Архив больше 4 ГБ: ${entry.path}.`);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // version needed: stored
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + size;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  if (offset > MAX_SIZE || centralSize > MAX_SIZE) throw new ZipTooLargeError('Архив больше 4 ГБ.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Разбор архива этого же формата: для проверок и тестов. */
export function readZip(zip: Buffer): { path: string; data: Buffer; mode: number }[] {
  const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error('Нет конца центрального каталога.');
  const count = zip.readUInt16LE(endOffset + 10);
  let pointer = zip.readUInt32LE(endOffset + 16);
  const out: { path: string; data: Buffer; mode: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(pointer) !== 0x02014b50) throw new Error('Повреждён центральный каталог.');
    const size = zip.readUInt32LE(pointer + 24);
    const nameLength = zip.readUInt16LE(pointer + 28);
    const extra = zip.readUInt16LE(pointer + 30);
    const comment = zip.readUInt16LE(pointer + 32);
    const mode = zip.readUInt32LE(pointer + 38) >>> 16;
    const local = zip.readUInt32LE(pointer + 42);
    const path = zip.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    const localName = zip.readUInt16LE(local + 26);
    const localExtra = zip.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    out.push({ path, data: zip.subarray(start, start + size), mode });
    pointer += 46 + nameLength + extra + comment;
  }
  return out;
}
