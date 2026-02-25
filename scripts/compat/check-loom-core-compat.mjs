#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const defaultCommandContract = path.join(
  repoRoot,
  "compat",
  "loom-core",
  "contracts",
  "cli",
  "loom_commands.json"
);
const defaultPlatformSchema = path.join(
  repoRoot,
  "compat",
  "loom-core",
  "contracts",
  "platform",
  "platform_config_schema.json"
);

const commandContractPath = process.env.LOOM_CORE_CONTRACT_COMMANDS ?? defaultCommandContract;
const platformSchemaPath = process.env.LOOM_CORE_PLATFORM_SCHEMA ?? defaultPlatformSchema;

const platformNames = ["vscode", "antigravity", "gemini", "claude", "codex", "kilocode"];

const requiredCommandChecks = [
  { label: "loom daemon start", path: ["daemon", "start"], flags: [] },
  { label: "loom daemon stop", path: ["daemon", "stop"], flags: [] },
  { label: "loom daemon restart", path: ["daemon", "restart"], flags: [] },
  { label: "loom daemon status", path: ["daemon", "status"], flags: [] },
  { label: "loom servers --json", path: ["servers"], flags: ["--json"] },
  { label: "loom servers", path: ["servers"], flags: [] },
  { label: "loom tools list", path: ["tools", "list"], flags: [] },
  { label: "loom sync <platform> --regen", path: ["sync", "<platform>"], flags: ["--regen"] },
];

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function parseArgv(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--contract" && argv[i + 1]) {
      out.contract = argv[i + 1];
      i += 1;
    } else if (part === "--platform-schema" && argv[i + 1]) {
      out.platformSchema = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function normalizeCommandEntry(entry) {
  if (typeof entry === "string") {
    const tokens = entry.split(/\s+/).filter(Boolean);
    return {
      path: tokens.filter((token) => !token.startsWith("-")),
      flags: tokens.filter((token) => token.startsWith("-")),
      raw: entry,
      source: entry,
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const explicitPath = Array.isArray(entry.path)
    ? entry.path.map((x) => String(x))
    : typeof entry.command === "string"
      ? entry.command.split(/\s+/).filter(Boolean)
      : [];

  const flags = Array.isArray(entry.flags)
    ? entry.flags.map((x) => String(x))
    : Array.isArray(entry.args)
      ? entry.args.filter((x) => String(x).startsWith("-")).map((x) => String(x))
      : [];

  if (explicitPath.length === 0) {
    return null;
  }

  return {
    path: explicitPath,
    flags,
    raw: entry,
    source: JSON.stringify(entry),
  };
}

function getCommandEntries(contract) {
  const entries = Array.isArray(contract)
    ? contract
    : Array.isArray(contract.commands)
      ? contract.commands
      : [];

  return entries.map((entry) => normalizeCommandEntry(entry)).filter(Boolean);
}

function pathMatches(actual, expected) {
  if (actual.length !== expected.length) {
    return false;
  }

  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i] === "<platform>") {
      if (actual[i] !== "<platform>" && !platformNames.includes(actual[i])) {
        return false;
      }
      continue;
    }

    if (actual[i] !== expected[i]) {
      return false;
    }
  }

  return true;
}

function commandMatches(entry, check) {
  if (!pathMatches(entry.path, check.path)) {
    return false;
  }

  const flagSet = new Set(entry.flags);
  return check.flags.every((flag) => flagSet.has(flag));
}

function extractServerJsonFields(contract, commandEntries) {
  const fromTopLevel = [];
  if (contract?.fields?.daemon?.servers_json) {
    fromTopLevel.push(...contract.fields.daemon.servers_json);
  }

  if (contract?.schemas?.daemon_servers?.required_fields) {
    fromTopLevel.push(...contract.schemas.daemon_servers.required_fields);
  }

  const fromCommand = [];
  const serverJsonCommand = commandEntries.find(
    (entry) => pathMatches(entry.path, ["servers"]) && entry.flags.includes("--json")
  );

  if (serverJsonCommand?.raw?.outputs?.json?.required_fields) {
    fromCommand.push(...serverJsonCommand.raw.outputs.json.required_fields);
  }

  if (serverJsonCommand?.raw?.json_fields) {
    fromCommand.push(...serverJsonCommand.raw.json_fields);
  }

  return [...fromTopLevel, ...fromCommand].map((x) => String(x));
}

function extractPlatformConfigFields(contract, schema) {
  const fields = [];

  if (contract?.schemas?.platform_config?.required_fields) {
    fields.push(...contract.schemas.platform_config.required_fields);
  }

  if (schema?.required_fields) {
    fields.push(...schema.required_fields);
  }

  return fields.map((x) => String(x));
}

function main() {
  const argv = parseArgv(process.argv);
  const commandPath = argv.contract ?? commandContractPath;
  const platformPath = argv.platformSchema ?? platformSchemaPath;

  const failures = [];

  if (!fs.existsSync(commandPath)) {
    console.error(`compat:loom-core missing contract file: ${commandPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(platformPath)) {
    console.error(`compat:loom-core missing platform schema: ${platformPath}`);
    process.exit(1);
  }

  const commandContract = readJson(commandPath);
  const platformSchema = readJson(platformPath);
  const commandEntries = getCommandEntries(commandContract);

  for (const check of requiredCommandChecks) {
    const found = commandEntries.some((entry) => commandMatches(entry, check));
    if (!found) {
      failures.push(`Missing required command contract: ${check.label}`);
    }
  }

  const daemonFields = extractServerJsonFields(commandContract, commandEntries);
  for (const field of ["servers[].name", "servers[].running"]) {
    if (!daemonFields.includes(field)) {
      failures.push(`Missing required daemon JSON field contract: ${field}`);
    }
  }

  const platformFields = extractPlatformConfigFields(commandContract, platformSchema);
  if (!platformFields.includes("mcpServers") && !platformFields.includes("servers")) {
    failures.push("Platform config contract must include at least one of: mcpServers, servers");
  }

  if (failures.length > 0) {
    console.error("compat:loom-core failed");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("compat:loom-core passed");
  console.log(`- commands contract: ${path.relative(repoRoot, commandPath)}`);
  console.log(`- platform schema: ${path.relative(repoRoot, platformPath)}`);
  console.log(`- checked command requirements: ${requiredCommandChecks.length}`);
}

main();
