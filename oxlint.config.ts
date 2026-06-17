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
  overrides: [
    {
      // 后端（Bun 服务 + CLI）需要向终端/日志输出，console 是正当用法。
      // 前端 web/src/ 仍受全局 no-console 约束。
      files: ["src/**/*.ts"],
      rules: {
        "no-console": "off",
      },
    },
  ],
});
