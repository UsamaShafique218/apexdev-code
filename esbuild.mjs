import { readdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

const args = new Set(process.argv.slice(2));

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  // ws loads these native accelerators only if they are installed
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
};

if (args.has('--tests')) {
  await esbuild.build({
    ...common,
    entryPoints: readdirSync('test')
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => `test/${f}`),
    outdir: 'out-test',
  });
} else {
  const ctx = await esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    minify: args.has('--production'),
    sourcemap: !args.has('--production'),
  });
  if (args.has('--watch')) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}
