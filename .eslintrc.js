module.exports = {
  extends: [
    'eslint:recommended',
    'plugin:prettier/recommended',
    'plugin:node/recommended'
  ],
  plugins: ['prettier'],
  env: {
    node: true,
    es6: true
  },
  parserOptions: {
    ecmaVersion: 2017
  },
  rules: {
    'prettier/prettier': 'error'
  }
}
