// The ledger's temporary file must reach the disk before it is renamed over
// rung.json; otherwise a power cut right after the rename can leave an empty
// ledger, and an empty ledger could ring the same ids twice. This file mocks
// node:fs/promises to watch the order of sync and rename, so it is kept apart
// from doorbell.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const fileOperationsInOrder: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const realFileSystem = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...realFileSystem,
    open: async (...openArguments: Parameters<typeof realFileSystem.open>) => {
      const fileHandle = await realFileSystem.open(...openArguments);
      const realSync = fileHandle.sync.bind(fileHandle);
      fileHandle.sync = async () => {
        fileOperationsInOrder.push('sync');
        return realSync();
      };
      return fileHandle;
    },
    rename: async (...renameArguments: Parameters<typeof realFileSystem.rename>) => {
      fileOperationsInOrder.push('rename');
      return realFileSystem.rename(...renameArguments);
    },
  };
});

const { openRungMessageLedger } = await import('./doorbell.js');

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  fileOperationsInOrder.length = 0;
});

test('the ledger temporary file is synced to disk before it is renamed over rung.json', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'claudecommander-ledger-durability-'));
  temporaryDirectories.push(stateDirectory);
  await openRungMessageLedger(join(stateDirectory, 'rung.json')).recordRung(['m_1']);
  expect(fileOperationsInOrder).toEqual(['sync', 'rename']);
});
