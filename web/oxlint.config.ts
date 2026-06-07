import baseConfig from "../oxlint.config.ts";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [baseConfig],
  plugins: ["eslint", "typescript", "unicorn", "oxc", "react", "jsx-a11y"],
  rules: {
    "react/jsx-key": "error",
    "react/jsx-no-target-blank": "error",
    "react/react-in-jsx-scope": "off",
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "jsx-a11y/alt-text": "error",
    "jsx-a11y/click-events-have-key-events": "warn",
    "jsx-a11y/no-static-element-interactions": "warn",
    "jsx-a11y/control-has-associated-label": "warn",
  },
  settings: {
    react: {
      linkComponents: [{ name: "Link", linkAttribute: "to" }],
    },
  },
});
