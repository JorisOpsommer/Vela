// Bundles the server (and the Vela sources it reuses) into dist/server. npm packages
// stay external and resolve from node_modules at runtime.
import { build } from 'esbuild';

export const serverBuild = {
    entryPoints: { index: 'server/index.ts', cli: 'server/cli.ts' },
    outdir: 'dist/server',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    sourcemap: true,
    logLevel: 'info',
};

if (import.meta.url === `file://${process.argv[1]}`) await build(serverBuild);
