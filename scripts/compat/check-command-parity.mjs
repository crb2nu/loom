#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const INTERNAL_REGISTERED_COMMANDS = new Set([
  // Triggered by skills UX flows; not intended as standalone command palette entries.
  "loom.syncSkills",
  "loom.previewSkillOutput",
  // Legacy diagnostic view command kept internal for now.
  "loom.showContextGraph",
]);

function listSourceFiles() {
  const sourceRoot = path.join(repoRoot, "src");
  const files = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) {
        continue;
      }
      files.push(path.relative(repoRoot, absolutePath));
    }
  }

  walk(sourceRoot);
  return files.sort((a, b) => a.localeCompare(b));
}

function readContributedCommands() {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const commandEntries = packageJson?.contributes?.commands ?? [];
  return new Set(commandEntries.map((entry) => String(entry.command)));
}

function extractRegisteredCommands(sourceFiles) {
  const commands = new Set();
  const pattern = /registerCommand\(\s*"([^"]+)"/g;

  for (const file of sourceFiles) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    let match;
    while ((match = pattern.exec(content)) !== null) {
      commands.add(match[1]);
    }
  }
  return commands;
}

function sortSet(input) {
  return [...input].sort((a, b) => a.localeCompare(b));
}

function main() {
  const sourceFiles = listSourceFiles();
  const contributed = readContributedCommands();
  const registered = extractRegisteredCommands(sourceFiles);

  const missingContributions = sortSet(
    new Set(
      [...registered].filter(
        (command) => !contributed.has(command) && !INTERNAL_REGISTERED_COMMANDS.has(command)
      )
    )
  );

  const unknownInternal = sortSet(
    new Set([...INTERNAL_REGISTERED_COMMANDS].filter((command) => !registered.has(command)))
  );

  const failures = [];
  if (missingContributions.length > 0) {
    failures.push(
      `Registered commands missing from package.json contributions: ${missingContributions.join(", ")}`
    );
  }
  if (unknownInternal.length > 0) {
    failures.push(
      `Internal command allowlist entries are stale (not registered): ${unknownInternal.join(", ")}`
    );
  }

  if (failures.length > 0) {
    console.error("compat:commands failed");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("compat:commands passed");
  console.log(`- source files scanned: ${sourceFiles.length}`);
  console.log(`- registered commands (literal): ${registered.size}`);
  console.log(`- contributed commands: ${contributed.size}`);
  console.log(`- internal allowlist entries: ${INTERNAL_REGISTERED_COMMANDS.size}`);
}

main();
