import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { EMULATOR_FIREBASE_WEB_CONFIG, fetchFirebaseWebConfig, readFirebaseWebConfigWithCache } from './firebaseWebConfig.js';

// What Firebase Hosting serves at /__/firebase/init.json for a web app.
const HOSTING_INIT_JSON = {
  apiKey: 'AIzaSyExampleKey',
  authDomain: 'claudecommander-1cf54c.firebaseapp.com',
  projectId: 'claudecommander-1cf54c',
  storageBucket: 'claudecommander-1cf54c.firebasestorage.app',
  messagingSenderId: '123456789',
  appId: '1:123456789:web:abc',
};
const BACKEND_URL = 'https://claudecommander-1cf54c.web.app';

// A fetch that answers every request with one scripted answer and records the URLs asked for.
function createFakeFetch(answer: () => Response) {
  const requestedUrls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return answer();
  }) as typeof fetch & { requestedUrls: string[] };
  fakeFetch.requestedUrls = requestedUrls;
  return fakeFetch;
}

const initJsonAnswer = () => new Response(JSON.stringify(HOSTING_INIT_JSON), { status: 200, headers: { 'Content-Type': 'application/json' } });

let temporaryDirectory = '';
let cacheFile = '';
const loggedLines: string[] = [];

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'claudecommander-web-config-'));
  cacheFile = join(temporaryDirectory, 'state', 'firebase-web-config.json');
  loggedLines.length = 0;
});

afterEach(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('fetchFirebaseWebConfig reads <backendUrl>/__/firebase/init.json', async () => {
  const fakeFetch = createFakeFetch(initJsonAnswer);
  await fetchFirebaseWebConfig('https://claudecommander-1cf54c.web.app', fakeFetch);
  expect(fakeFetch.requestedUrls).toEqual(['https://claudecommander-1cf54c.web.app/__/firebase/init.json']);
});

test('fetchFirebaseWebConfig answers the apiKey, authDomain, projectId and appId it was served', async () => {
  const config = await fetchFirebaseWebConfig(`${BACKEND_URL}/`, createFakeFetch(initJsonAnswer));
  expect(config).toMatchObject({
    apiKey: 'AIzaSyExampleKey',
    authDomain: 'claudecommander-1cf54c.firebaseapp.com',
    projectId: 'claudecommander-1cf54c',
    appId: '1:123456789:web:abc',
  });
});

test('fetchFirebaseWebConfig refuses an answer that is not 200, not JSON, or lacks apiKey or projectId', async () => {
  await expect(fetchFirebaseWebConfig(BACKEND_URL, createFakeFetch(() => new Response('nope', { status: 404 })))).rejects.toThrow(/HTTP 404/);
  await expect(fetchFirebaseWebConfig(BACKEND_URL, createFakeFetch(() => new Response('<html>', { status: 200 })))).rejects.toThrow(/not a Firebase web config/);
  await expect(
    fetchFirebaseWebConfig(BACKEND_URL, createFakeFetch(() => new Response(JSON.stringify({ apiKey: 'k' }), { status: 200 }))),
  ).rejects.toThrow(/not a Firebase web config/);
});

test('EMULATOR_FIREBASE_WEB_CONFIG names the demo-claudecommander project with a demo key', () => {
  expect(EMULATOR_FIREBASE_WEB_CONFIG).toMatchObject({ projectId: 'demo-claudecommander', apiKey: 'demo-key' });
});

test('a fetched web config is cached, and the cache is used when the backend cannot be reached', async () => {
  const fetched = await readFirebaseWebConfigWithCache(BACKEND_URL, createFakeFetch(initJsonAnswer), cacheFile, (line) => loggedLines.push(line));
  expect(JSON.parse(readFileSync(cacheFile, 'utf8')).backend_url).toBe(BACKEND_URL);

  const unreachable = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const fromCache = await readFirebaseWebConfigWithCache(BACKEND_URL, unreachable, cacheFile, (line) => loggedLines.push(line));
  expect(fromCache).toEqual(fetched);
  expect(loggedLines.join('\n')).toMatch(/using the cached Firebase web config/);
});

test('a cached web config saved for another backend is never used', async () => {
  await readFirebaseWebConfigWithCache('https://other-backend.example.test', createFakeFetch(initJsonAnswer), cacheFile, () => {});
  const unreachable = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  await expect(readFirebaseWebConfigWithCache(BACKEND_URL, unreachable, cacheFile, () => {})).rejects.toThrow(/could not read the Firebase web config/);
});
