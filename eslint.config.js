import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'dist/', 'out/'] },
  js.configs.recommended,
  {
    files: ['src/main/**/*.js', 'src/shared/**/*.js', 'tools/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
  },
  {
    files: ['tools/genba/page.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: globals.browser },
    rules: { 'no-unused-vars': 'off' }, // build()는 Electron이 executeJavaScript로 호출한다
  },
  {
    files: ['src/preload/**/*.cjs', 'tools/genba/build.cjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['src/renderer/**/*.js', 'src/settings/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.browser },
  },
];
