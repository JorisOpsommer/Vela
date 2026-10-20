import tseslint from 'typescript-eslint';

/**
 * Architectural boundary guard (the maintainability contract):
 *  - `pinets` is BANNED outright. Vela ships no scripting engine: Pine Script lives in
 *    the `@luxalgo/vela-pinets` addon, which is AGPL-3.0 (as `pinets` is) — importing it
 *    here would pull that license onto this Apache-2.0 package. Engines plug in through
 *    the `ScriptingEngine` port instead (see docs/contributing/adding-an-engine.md).
 *  - `lightweight-charts` is a TEMPORARY type-only devDependency (legacy shared types);
 *    no new import of it is allowed anywhere — it is being replaced by Vela's own types.
 *  - The self-hosted app (`app/`) builds on the library from outside: it may import the
 *    public entry points and the provider/port modules, never core or renderer internals.
 */
export default tseslint.config(
    { ignores: ['**/dist/**', '**/node_modules/**', 'app/data/**'] },
    {
        files: ['app/**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
        },
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [{ name: 'pinets', message: 'The app ships no Pine engine (AGPL-3.0); see the ScriptingEngine port.' }],
                    patterns: [
                        {
                            group: ['**/src/core/**', '**/src/renderers/**', '**/src/state/**', '**/src/chart-types/**'],
                            message: 'Import Vela through its public entry points (src, src/workspace, src/widget, src/plugin, src/ui) or a provider module.',
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
        },
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        { name: 'pinets', message: 'Vela carries no Pine code. `pinets` is AGPL-3.0 and lives in the @luxalgo/vela-pinets addon; plug an engine in through the ScriptingEngine port instead.' },
                    ],
                },
            ],
        },
    },
);
