import { defineConfig } from 'vitest/config';

// The plugin's own vitest config, so `npm --prefix plugin test` never picks
// up the private repository's root config.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Emulator tests need this private repository's firebase.json and backend
    // code, so they run only through the root `npm run test:emu`.
    exclude: ['**/node_modules/**', 'dist/**', '**/*.emu.test.ts'],
  },
});
