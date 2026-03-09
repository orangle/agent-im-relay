import { access, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareSeaBuild } from '../../scripts/sea-build.mjs';

describe('sea build preflight', () => {
  it('creates dist and throws a clear error when the bundle entry is missing', async () => {
    const packageDir = await mkdtemp(join('/tmp', 'agent-inbox-sea-'));
    const distDir = join(packageDir, 'dist');
    const entryFile = join(distDir, 'index.mjs');

    await expect(
      prepareSeaBuild({
        distDir,
        entryFile,
        blobFile: join(distDir, 'agent-inbox.blob'),
        seaConfigFile: join(distDir, 'sea-config.json'),
      }),
    ).rejects.toThrow(/run pnpm --filter agent-inbox build before build:sea/i);

    await expect(access(distDir)).resolves.toBeUndefined();
  });
});
