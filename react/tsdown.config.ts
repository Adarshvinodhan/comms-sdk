import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'browser',
  dts: true,
  sourcemap: true,
  clean: true,
  // Typecheck resolves the local SDK via tsconfig paths. The published build must keep the package import.
  deps: { neverBundle: ['@sminfotech/comms-sdk'] },
});
