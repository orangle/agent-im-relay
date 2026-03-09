import { access, mkdir, writeFile } from 'node:fs/promises';

export async function prepareSeaBuild({
  distDir,
  entryFile,
  blobFile,
  seaConfigFile,
}) {
  await mkdir(distDir, { recursive: true });

  try {
    await access(entryFile);
  } catch {
    throw new Error(
      'Missing launcher bundle. Run pnpm --filter agent-inbox build before build:sea.',
    );
  }

  await writeFile(
    seaConfigFile,
    JSON.stringify(
      {
        main: entryFile,
        output: blobFile,
        disableExperimentalSEAWarning: true,
      },
      null,
      2,
    ),
  );
}
