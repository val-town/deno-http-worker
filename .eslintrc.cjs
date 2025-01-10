module.exports = {
  env: {
    es2022: true,
    node: true,
  },
  parserOptions: {
    sourceType: "module",
    project: "./tsconfig.json",
  },
  plugins: ["@typescript-eslint" /*, "import"*/],
  parser: "@typescript-eslint/parser",
  settings: {
    "import/internal-regex": "^~/",
    "import/resolver": {
      node: {
        extensions: [".ts", ".tsx"],
      },
      typescript: {
        alwaysTryTypes: true,
      },
    },
  },
  rules: {
    "@typescript-eslint/no-explicit-any": 0,
    "@typescript-eslint/no-namespace": 0,
    "@typescript-eslint/ban-types": 0,
  },
  extends: ["plugin:@typescript-eslint/recommended"],
  ignorePatterns: ["dist", "src/test", "deno-bootstrap", "*.cjs"],
};
