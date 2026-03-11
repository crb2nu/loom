import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function listSourceFiles(rootDir: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(absolutePath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) {
      continue;
    }
    files.push(absolutePath);
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function loadPackageJson(): {
  contributes?: {
    commands?: Array<{ command?: string }>;
    configuration?: { properties?: Record<string, unknown> };
  };
} {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    contributes?: {
      commands?: Array<{ command?: string }>;
      configuration?: { properties?: Record<string, unknown> };
    };
  };
}

describe("extension surface parity", () => {
  it("keeps registered commands aligned with package.json contributions", () => {
    const packageJson = loadPackageJson();
    const contributedCommands = new Set(
      (packageJson.contributes?.commands ?? [])
        .map((entry) => entry.command)
        .filter((command): command is string => typeof command === "string")
    );

    const registeredCommands = new Set<string>();
    const pattern = /registerCommand\(\s*"([^"]+)"/g;
    for (const file of listSourceFiles(path.join(repoRoot, "src"))) {
      const content = fs.readFileSync(file, "utf8");
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        registeredCommands.add(match[1]);
      }
    }

    const missingCommands = [...registeredCommands]
      .filter((command) => !contributedCommands.has(command))
      .sort((a, b) => a.localeCompare(b));

    expect(missingCommands).toEqual([]);
  });

  it("keeps ConfigManager settings aligned with contributed configuration", () => {
    const packageJson = loadPackageJson();
    const contributedSettings = new Set(
      Object.keys(packageJson.contributes?.configuration?.properties ?? {}).map((key) =>
        key.replace(/^loom\./, "")
      )
    );

    const configManagerSource = fs.readFileSync(
      path.join(repoRoot, "src", "utils", "configManager.ts"),
      "utf8"
    );
    const referencedSettings = new Set<string>();
    const pattern = /c\.get(?:<[^>]+>)?\("([^"]+)"\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(configManagerSource)) !== null) {
      referencedSettings.add(match[1]);
    }

    const missingSettings = [...referencedSettings]
      .filter((setting) => !contributedSettings.has(setting))
      .sort((a, b) => a.localeCompare(b));

    expect(missingSettings).toEqual([]);
  });

  it("includes current loom-core parity additions in settings and commands", () => {
    const packageJson = loadPackageJson();
    const properties = packageJson.contributes?.configuration?.properties ?? {};
    const enabledPlatforms = properties["loom.enabledPlatforms"] as
      | { items?: { enum?: string[] }; default?: string[] }
      | undefined;
    const platformMode = properties["loom.platform"] as { enum?: string[] } | undefined;
    const commands = new Set(
      (packageJson.contributes?.commands ?? [])
        .map((entry) => entry.command)
        .filter((command): command is string => typeof command === "string")
    );

    expect(platformMode?.enum).toContain("opencode");
    expect(platformMode?.enum).toContain("zed");
    expect(enabledPlatforms?.items?.enum).toContain("opencode");
    expect(enabledPlatforms?.items?.enum).toContain("zed");
    expect(enabledPlatforms?.default).toContain("opencode");
    expect(enabledPlatforms?.default).toContain("zed");
    expect(properties).toHaveProperty("loom.onboardingComplete");
    expect(commands.has("loom.showDoctorReport")).toBe(true);
  });
});
