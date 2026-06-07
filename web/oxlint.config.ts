import baseConfig from "../oxlint.config.ts";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [baseConfig],
  plugins: ["eslint", "typescript", "unicorn", "oxc", "react", "jsx-a11y"],
  rules: {
    "react/jsx-key": "error",
    "react/jsx-no-target-blank": "error",
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "jsx-a11y/alt-text": "error",
  },
  settings: {
    react: {
      linkComponents: [{ name: "Link", linkAttribute: "to" }],
    },
  },
});
