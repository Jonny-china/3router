import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  plugins: ["eslint", "typescript", "unicorn", "oxc"],
  rules: {
    "no-console": "warn",
    "no-debugger": "error",
  },
});
