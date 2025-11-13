module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: ["dist", "drizzle"],
  env: { browser: true, node: true, es2021: true },
  parserOptions: { sourceType: "module", ecmaVersion: "latest" },
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
  },
};
