// The Firebase web config the daemon's client SDK needs (apiKey, projectId,
// authDomain, appId). It is not a secret: Firebase Hosting serves it to anyone
// at the reserved URL <backend_url>/__/firebase/init.json, and the Firestore
// rules, not the config, are what protect the data.
//
// Reading it from the backend, rather than baking it into dist/cli.js, keeps
// the public bundle free of any one deployment's project. The last good copy
// is cached in the state directory, so a daemon restarted while Hosting is
// briefly unreachable still starts.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FirebaseOptions } from 'firebase/app';

// The Firebase emulators accept any API key; a `demo-` project id makes the
// SDK refuse to reach any real Firebase resource.
export const EMULATOR_FIREBASE_WEB_CONFIG: FirebaseOptions = {
  apiKey: 'demo-key',
  authDomain: 'demo-claudecommander.firebaseapp.com',
  projectId: 'demo-claudecommander',
};

// The fields of init.json we pass on to initializeApp. Anything else in the
// answer is dropped, so the cache holds nothing we did not mean to keep.
const WEB_CONFIG_FIELD_NAMES = ['apiKey', 'authDomain', 'projectId', 'appId', 'storageBucket', 'messagingSenderId'] as const;

function initJsonUrlFor(backendUrl: string): string {
  return `${backendUrl.replace(/\/+$/, '')}/__/firebase/init.json`;
}

// The usable web config inside a parsed init.json, or null when it is not one.
// apiKey and projectId are the two fields the SDK cannot work without.
function webConfigFrom(parsed: unknown): FirebaseOptions | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.apiKey !== 'string' || candidate.apiKey === '') return null;
  if (typeof candidate.projectId !== 'string' || candidate.projectId === '') return null;
  const webConfig: Record<string, string> = {};
  for (const fieldName of WEB_CONFIG_FIELD_NAMES) {
    const value = candidate[fieldName];
    if (typeof value === 'string' && value !== '') webConfig[fieldName] = value;
  }
  return webConfig as FirebaseOptions;
}

// GET <backendUrl>/__/firebase/init.json. Throws an Error with a one-line
// message on any failure; the answer's body is never repeated in it.
export async function fetchFirebaseWebConfig(backendUrl: string, fetchFunction: typeof fetch): Promise<FirebaseOptions> {
  const initJsonUrl = initJsonUrlFor(backendUrl);
  let response: Response;
  let responseText: string;
  try {
    response = await fetchFunction(initJsonUrl, { method: 'GET' });
    responseText = await response.text();
  } catch {
    throw new Error(`could not reach ${initJsonUrl}`);
  }
  if (response.status !== 200) throw new Error(`${initJsonUrl} answered HTTP ${response.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    parsed = undefined;
  }
  const webConfig = webConfigFrom(parsed);
  if (webConfig === null) throw new Error(`${initJsonUrl} is not a Firebase web config`);
  return webConfig;
}

interface CachedWebConfigOnDisk {
  backend_url: string;
  web_config: unknown;
}

async function readCachedWebConfig(backendUrl: string, cacheFile: string): Promise<FirebaseOptions | null> {
  let cached: Partial<CachedWebConfigOnDisk>;
  try {
    cached = JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    // No cache yet, or a damaged one: either way there is nothing to use.
    return null;
  }
  // A cache saved for another backend (the machine was paired again
  // elsewhere) would sign in to the wrong project, so it is ignored.
  if (cached?.backend_url !== backendUrl) return null;
  return webConfigFrom(cached.web_config);
}

// Written to a temporary file and renamed, so a reader never sees half a file.
async function writeCachedWebConfig(backendUrl: string, cacheFile: string, webConfig: FirebaseOptions): Promise<void> {
  await mkdir(dirname(cacheFile), { recursive: true });
  const temporaryFile = `${cacheFile}.${process.pid}.tmp`;
  const cached: CachedWebConfigOnDisk = { backend_url: backendUrl, web_config: webConfig };
  await writeFile(temporaryFile, `${JSON.stringify(cached, null, 2)}\n`, 'utf8');
  await rename(temporaryFile, cacheFile);
}

// The web config fresh from the backend (and saved to the cache), or, when the
// backend cannot give it, the cached copy for this same backend. Throws when
// there is neither.
export async function readFirebaseWebConfigWithCache(
  backendUrl: string,
  fetchFunction: typeof fetch,
  cacheFile: string,
  log: (line: string) => void,
): Promise<FirebaseOptions> {
  try {
    const webConfig = await fetchFirebaseWebConfig(backendUrl, fetchFunction);
    try {
      await writeCachedWebConfig(backendUrl, cacheFile, webConfig);
    } catch (error) {
      log(`could not save the Firebase web config cache ${cacheFile}: ${(error as Error).message}`);
    }
    return webConfig;
  } catch (fetchError) {
    const cachedWebConfig = await readCachedWebConfig(backendUrl, cacheFile);
    if (cachedWebConfig === null) {
      throw new Error(`could not read the Firebase web config: ${(fetchError as Error).message}, and no cached copy for this backend exists`);
    }
    log(`${(fetchError as Error).message}; using the cached Firebase web config`);
    return cachedWebConfig;
  }
}
