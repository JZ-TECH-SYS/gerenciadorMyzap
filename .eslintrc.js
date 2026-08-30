module.exports = {
  env: {
    commonjs: true,
    es6: true,
    node: true,
  },
  extends: [
    'airbnb-base',
  ],
  globals: {
    Atomics: 'readonly',
    SharedArrayBuffer: 'readonly',
  },
  parserOptions: {
    // 2022: o codigo usa optional chaining (?.) e nullish coalescing (??);
    // com 2018 o parser quebrava e o lint ficava inutilizavel no repo todo.
    ecmaVersion: 2022,
  },
  rules: {
  },
};
