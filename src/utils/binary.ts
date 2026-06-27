import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function findExistingFile(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function getWorkspaceLoomCandidates(workspaceRoot: string): string[] {
  const normalizedRoot = path.resolve(workspaceRoot);
  const candidates = new Set<string>();

  // Repo-local build when loom-core itself is the opened folder.
  candidates.add(path.join(normalizedRoot, "bin", "loom"));

  // Monorepo root layout.
  candidates.add(path.join(normalizedRoot, "services", "loom-core", "bin", "loom"));

  // Sibling repo layout when the opened folder is services/loom.
  candidates.add(path.join(path.dirname(normalizedRoot), "loom-core", "bin", "loom"));

  // Walk ancestors so nested folders like platform/gitops still resolve the workspace binary.
  let current = normalizedRoot;
  let done = false;
  while (!done) {
    candidates.add(path.join(current, "services", "loom-core", "bin", "loom"));
    const parent = path.dirname(current);
    if (parent === current) {
      done = true;
    } else {
      current = parent;
    }
  }

  return Array.from(candidates);
}

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
      } catch {
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

  // Check workspace-local and monorepo build locations.
  if (workspaceRoot) {
    const workspaceCandidate = findExistingFile(getWorkspaceLoomCandidates(workspaceRoot));
    if (workspaceCandidate) {
      return workspaceCandidate;
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
