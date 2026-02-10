import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["node_modules", "out"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "cobertura"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/__tests__/**",
        "src/extension.ts", // Main entry point, tested via integration
      ],
      thresholds: {
        // Current coverage: lines 26%, functions 65%, branches 77%, statements 26%
        // Commands, webviews, and providers need VS Code runtime; ratchet up as tests expand
        lines: 25,
        functions: 60,
        branches: 60,
        statements: 25,
      },
    },
    setupFiles: ["./src/__tests__/setup.ts"],
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "src/__tests__/mocks/vscode.ts"),
    },
  },
});
