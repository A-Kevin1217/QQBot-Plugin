module.exports = {
  env: {
    browser: true,
    es2021: true
  },
  extends: 'eslint:recommended',
  overrides: [
    {
      env: {
        node: true
      },
      files: [
        '.eslintrc.{js,cjs}'
      ],
      parserOptions: {
        sourceType: 'script'
      }
    }
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  ignorePatterns: [
    'test/**'
  ],
  rules: {
    // 驼峰命名
    camelcase: 'off',
    // switch case 落空
    'no-fallthrough': 'off',
    // 常规字符串中出现模板字面量占位符
    'no-template-curly-in-string': 'off'
  }
}
