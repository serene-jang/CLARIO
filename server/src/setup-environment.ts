import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';

export async function readEnvironment(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}

export async function saveSetupEnvironment(
  path: string,
  previous: string,
  values: Record<string, string>,
) {
  let next = previous;
  for (const [key, value] of Object.entries(values)) {
    const line = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'gm');
    next = next.replace(line, '');
    next = `${next.trimEnd()}\n${key}=${JSON.stringify(value)}\n`;
  }
  const temporary = `${path}.setup-${randomBytes(8).toString('hex')}.tmp`;
  try {
    if ((await readEnvironment(path)) !== previous) {
      throw new Error('Environment changed concurrently.');
    }
    await writeFile(temporary, next.trimStart(), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (!(
        cleanupError instanceof Error &&
        'code' in cleanupError &&
        cleanupError.code === 'ENOENT'
      )) {
        console.error('local_setup_cleanup_failed');
      }
    }
    throw error;
  }
}
