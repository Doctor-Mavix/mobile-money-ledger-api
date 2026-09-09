import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  splitting: false,
  treeshake: true,
  clean: true,
  sourcemap: true,
  minify: false,
  dts: false,
  tsconfig: './tsconfig.json',
  // Bundling hoists external imports, so tsyringe would load before reflect-metadata
  // unless the polyfill is forced to the very first import declaration of the output.
  banner: { js: "import 'reflect-metadata';" },
});
