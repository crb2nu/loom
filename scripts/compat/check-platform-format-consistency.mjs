#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const platformsPath = path.join(repoRoot, "src", "utils", "platform.ts");
const readmePath = path.join(repoRoot, "README.md");

const platformKeys = [
  "vscode",
  "antigravity",
  "gemini",
  "claude",
  "codex",
  "kilocode",
  "opencode",
  "zed",
];

function parseRuntimePlatforms(source) {
  const parsed = new Map();

  for (const key of platformKeys) {
    const regex = new RegExp(
      `${key}:\\s*\\{[\\s\\S]*?displayName:\\s*"([^"]+)"[\\s\\S]*?configFormat:\\s*"([^"]+)"`,
      "m"
    );
    const match = source.match(regex);
    if (!match) {
      throw new Error(`Unable to parse runtime platform metadata for "${key}"`);
    }
    parsed.set(match[1], String(match[2]).toUpperCase());
  }

  return parsed;
}

function parseReadmePlatformTable(source, platformDisplayNames) {
  const parsed = new Map();
  const lines = source.split("\n");

  for (const line of lines) {
    const rowMatch = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
    if (!rowMatch) {
      continue;
    }

    const platform = rowMatch[1].trim();
    const format = rowMatch[2].trim().toUpperCase();

    if (platformDisplayNames.has(platform)) {
      parsed.set(platform, format);
    }
  }

  return parsed;
}

function main() {
  const runtimeSource = fs.readFileSync(platformsPath, "utf8");
  const readmeSource = fs.readFileSync(readmePath, "utf8");

  const runtime = parseRuntimePlatforms(runtimeSource);
  const readme = parseReadmePlatformTable(readmeSource, new Set(runtime.keys()));

  const failures = [];

  for (const [displayName, runtimeFormat] of runtime.entries()) {
    if (!readme.has(displayName)) {
      failures.push(`README platform table is missing "${displayName}"`);
      continue;
    }

    const readmeFormat = readme.get(displayName);
    if (readmeFormat !== runtimeFormat) {
      failures.push(
        `Format mismatch for ${displayName}: runtime=${runtimeFormat}, README=${readmeFormat}`
      );
    }
  }

  if (failures.length > 0) {
    console.error("compat:platforms failed");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("compat:platforms passed");
  console.log(`- runtime platforms checked: ${runtime.size}`);
  console.log(`- README table rows matched: ${readme.size}`);
}

main();
