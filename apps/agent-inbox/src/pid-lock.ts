import { unlinkSync } from 'node:fs';
import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquirePidLock(pidsDir: string, platform: string): Promise<boolean> {
  await mkdir(pidsDir, { recursive: true });
  const pidFile = join(pidsDir, `${platform}.pid`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(pidFile, 'wx');
      try {
        await handle.writeFile(String(process.pid), 'utf-8');
      } finally {
        await handle.close();
      }

      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }

      try {
        const existingPid = Number.parseInt(await readFile(pidFile, 'utf-8'), 10);
        if (Number.isFinite(existingPid) && isProcessAlive(existingPid)) {
          return false;
        }
      } catch (readError) {
        const readCode = (readError as NodeJS.ErrnoException).code;
        if (readCode !== 'ENOENT') {
          // fall through and retry after best-effort cleanup
        }
      }

      try {
        await unlink(pidFile);
      } catch (unlinkError) {
        const unlinkCode = (unlinkError as NodeJS.ErrnoException).code;
        if (unlinkCode !== 'ENOENT') {
          throw unlinkError;
        }
      }
    }
  }

  return false;
}

export function registerPidCleanup(pidsDir: string, platform: string): void {
  const pidFile = join(pidsDir, `${platform}.pid`);

  const cleanup = () => {
    try {
      unlinkSync(pidFile);
    } catch {
      // best-effort cleanup
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}

export async function releasePidLock(pidsDir: string, platform: string): Promise<void> {
  const pidFile = join(pidsDir, `${platform}.pid`);
  try {
    await unlink(pidFile);
  } catch {
    // already gone
  }
}
