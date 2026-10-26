'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// The plugin main thread has no DOM, but Figma does provide `fetch` (limited to the
// manifest's allowedDomains) and `URL`. Both are declared here so an accidental
// network call is still visible in review: code.js only reaches fetch in ghRequest.
const figmaGlobals = { figma: 'readonly', __html__: 'readonly', __uiFiles__: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', Uint8Array: 'readonly', fetch: 'readonly', URL: 'readonly' };

const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-prototype-builtins': 'off',
  'no-control-regex': 'off', // escaping code deliberately matches control characters
  'no-useless-escape': 'off', // ui.html needs <\/ inside strings so "</script>" can't end the tag
  eqeqeq: ['error', 'smart'],
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-eval': 'error',
  curly: ['error', 'multi-line'],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }]
};

module.exports = [
  { ignores: ['node_modules/**', '**/*.zip', 'docs/**'] },
  // Figma main thread (QuickJS/SES sandbox: no DOM, no Node)
  { files: ['devready-plugin/code.js'], languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals: figmaGlobals }, rules },
  // Plugin UI script (extracted from ui.html by scripts/lint.js)
  { files: ['devready-plugin/ui.html.js'], languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals: { ...globals.browser } }, rules },
  // Node tooling
  { files: ['tests/**/*.js', 'scripts/**/*.js', 'devready-plugin/check-sandbox.js', 'eslint.config.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } }, rules }
];
