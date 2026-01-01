import { TargetSpec } from "../types";

/**
 * Format command arguments for display.
 */
export function formatArgs(args?: Array<string | number | boolean>): string {
  if (!args || args.length === 0) {
    return "";
  }
  return args
    .map((value) => {
      if (typeof value === "string" && /\s/.test(value)) {
        return `"${value}"`;
      }
      return String(value);
    })
    .join(" ");
}

/**
 * Format a list of names for display.
 */
export function formatNameList(names: string[], max = 3): string {
  if (names.length === 0) {
    return "none";
  }
  if (names.length <= max) {
    return names.join(", ");
  }
  return `${names.slice(0, max).join(", ")} +${names.length - max} more`;
}

/**
 * Get a status icon for sync status.
 */
export function getStatusIcon(
  status: "synced" | "out-of-sync" | "unknown" | "no-generated"
): string {
  switch (status) {
    case "synced":
      return "$(check)";
    case "out-of-sync":
      return "$(warning)";
    case "no-generated":
      return "$(question)";
    default:
      return "$(circle-outline)";
  }
}

/**
 * Format sync status for display.
 */
export function formatSyncStatus(
  status: "synced" | "out-of-sync" | "unknown" | "no-generated"
): string {
  switch (status) {
    case "synced":
      return "MCP configs in sync";
    case "out-of-sync":
      return "MCP configs out of sync";
    case "no-generated":
      return "No generated config";
    default:
      return "Config sync unknown";
  }
}

/**
 * Format a snapshot label with timestamp.
 */
export function formatSnapshotLabel(isoTimestamp?: string): string {
  if (!isoTimestamp) {
    return "No snapshot recorded";
  }
  const date = new Date(isoTimestamp);
  return `Last: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

/**
 * Get the Python executable from environment or default.
 */
export function getPythonExecutable(): string {
  return process.env.CM_PYTHON_EXECUTABLE ?? "python3";
}

/**
 * Build a tooltip for a server item.
 */
export function buildServerTooltip(
  name: string,
  targetSpec: TargetSpec | undefined,
  categories?: string[]
): string {
  const lines: string[] = [`**${name}**`];

  if (targetSpec?.description) {
    lines.push("", targetSpec.description);
  }

  if (categories && categories.length > 0) {
    lines.push("", `Categories: ${categories.join(", ")}`);
  }

  if (targetSpec?.command) {
    const args = formatArgs(targetSpec.args);
    lines.push("", `Command: \`${targetSpec.command}${args ? " " + args : ""}\``);
  }

  if (targetSpec?.env && Object.keys(targetSpec.env).length > 0) {
    const envKeys = Object.keys(targetSpec.env);
    lines.push("", `Env: ${envKeys.join(", ")}`);
  }

  if (targetSpec?.timeout) {
    lines.push("", `Timeout: ${targetSpec.timeout}ms`);
  }

  if (targetSpec?.always_allow && targetSpec.always_allow.length > 0) {
    lines.push("", `Auto-approve: ${targetSpec.always_allow.join(", ")}`);
  }

  return lines.join("\n");
}
