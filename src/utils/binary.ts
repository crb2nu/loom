import * as path from "path";
import * as fs from "fs";
import * as os from "os";

export function findBinaryInPath(binaryName: string): string | undefined {
  const pathEntries = process.env.PATH?.split(path.delimiter) ?? [];
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const entry of pathEntries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, `${binaryName}${ext}`);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch (error) {
        continue;
      }
    }
  }
  return undefined;
}

export function resolveLoomBinary(workspaceRoot?: string): string {
  // Check environment override
  const envOverride = process.env.LOOM_BINARY?.trim();
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  // Check ~/.local/bin/loom (installed location)
  const homeLocal = path.join(os.homedir(), ".local", "bin", "loom");
  if (fs.existsSync(homeLocal)) {
    return homeLocal;
  }

  // Check workspace build directory
  if (workspaceRoot) {
    const workspaceBin = path.join(workspaceRoot, "services", "loom-core", "bin", "loom");
    if (fs.existsSync(workspaceBin)) {
      return workspaceBin;
    }
  }

  // Check PATH
  const pathCandidate = findBinaryInPath("loom");
  if (pathCandidate) {
    return pathCandidate;
  }

  // Fallback to assuming it's in PATH
  return "loom";
}

export function resolveHubWrapperCommand(workspaceRoot?: string): string {
  const envOverride =
    process.env.MCP_HUB_WRAPPER_PATH?.trim() ?? process.env.MCP_HUB_WRAPPER?.trim();
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  const pathCandidate = findBinaryInPath("mcp-hub-wrapper");
  if (pathCandidate) {
    return pathCandidate;
  }

  if (workspaceRoot) {
    const shim = path.join(workspaceRoot, "scripts", "mcp", "hub_wrapper.sh");
    if (fs.existsSync(shim)) {
      return shim;
    }
  }

  return "mcp-hub-wrapper";
}
