module.exports = {
    env: { es2022: true, node: true },
    extends: ['eslint:recommended'],
    rules: {
        'no-restricted-globals': ['error', 'event', 'name', 'length'],
        'prefer-arrow-callback': 'error',
        'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
        'no-console': 'off',
        'eqeqeq': ['error', 'always'],
        'semi': ['error', 'always'],
        'quotes': ['error', 'single', { avoidEscape: true }],
        'indent': ['error', 4, { SwitchCase: 1 }],
    },
    parserOptions: {
        ecmaVersion: 2022,
    },
};
