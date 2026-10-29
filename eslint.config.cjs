// ESLint flat config (ESLint v9). Incremental: strict where bugs cost money (backend, IPC, migrations,
// scripts, tests), lighter on the renderer UI code, which still needs a cleanup pass.
const js = require('@eslint/js');
const globals = require('globals');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

const coreRules = {
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-throw-literal': 'error',
  'no-unsafe-finally': 'error',
  'no-self-compare': 'error',
};

const tsRules = {
  ...coreRules,
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  '@typescript-eslint/ban-ts-comment': 'error',
  '@typescript-eslint/no-explicit-any': 'off', // the IPC contract still uses `any` in a few legacy handlers
};

const tsLanguage = { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' };

module.exports = [
  { ignores: ['dist/**', 'drizzle/**', 'node_modules/**', 'e2e-artifacts/**', '.serena/**', 'build/**'] },

  // Backend, Electron main/preload and shared code: errors.
  {
    files: ['src/backend/**/*.ts', 'src/main/**/*.ts', 'src/preload/**/*.ts', 'src/common/**/*.ts'],
    languageOptions: { ...tsLanguage, globals: { ...globals.node } },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: tsRules,
  },

  // Renderer (React, shadcn/ui): the same rules, but unused variables only warn for now.
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'vite.config.ts', 'drizzle.config.ts'],
    languageOptions: { ...tsLanguage, globals: { ...globals.browser, ...globals.node } },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsRules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^(_|actionTypes$)', caughtErrors: 'none' }],
    },
  },

  // Scripts, migrations tooling and the whole test workflow (plain JS): ESLint recommended + core rules.
  {
    files: ['scripts/**/*.{mjs,cjs,js}', 'e2e/**/*.{mjs,cjs,js}', '*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // e2e callbacks run inside the Electron renderer (window, document, sessionStorage...)
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...coreRules,
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
  // CommonJS config files
  { files: ['*.cjs'], languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } } },
];
