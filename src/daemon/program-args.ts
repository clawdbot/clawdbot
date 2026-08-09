/** Builds runtime command arguments for gateway and node service installs. */
import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import {
  buildGatewayDistEntrypointCandidates,
  findFirstAccessibleGatewayEntrypoint,
  isGatewayDistEntrypointPath,
} from "./gateway-entrypoint.js";
import { isNodeRuntime } from "./runtime-binary.js";

type GatewayProgramArgs = {
  programArguments: string[];
  workingDirectory?: string;
};

type GatewayRuntimePreference = "auto" | "node";

export const OPENCLAW_WRAPPER_ENV_KEY = "OPENCLAW_WRAPPER";
const NODE_BINARY_LOOKUP_TIMEOUT_MS = 5_000;

async function resolveCliEntrypointPathForService(): Promise<string> {
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new Error("Unable to resolve CLI entrypoint path");
  }

  const normalized = path.resolve(argv1);
  const resolvedPath = await resolveRealpathSafe(normalized);
  const looksLikeDist = isGatewayDistEntrypointPath(resolvedPath);
  if (looksLikeDist) {
    // Existing installed command lines may point at versioned pnpm realpaths.
    // Repair prefers stable package symlink paths when they still exist.
    const preferredDistEntrypoint = await findFirstAccessibleGatewayEntrypoint(
      buildGatewayDistEntrypointCandidates(normalized, resolvedPath),
      async (candidate) => {
        try {
          await fs.access(candidate);
          return true;
        } catch {
          return false;
        }
      },
    );
    if (preferredDistEntrypoint) {
      return preferredDistEntrypoint;
    }
    // Prefer the original (possibly symlinked) path over the resolved realpath.
    // This keeps LaunchAgent/systemd paths stable across package version updates,
    // since symlinks like node_modules/openclaw -> .pnpm/openclaw@X.Y.Z/...
    // are automatically updated by pnpm, while the resolved path contains
    // version-specific directories that break after updates.
    const normalizedLooksLikeDist = isGatewayDistEntrypointPath(normalized);
    if (normalizedLooksLikeDist && normalized !== resolvedPath) {
      try {
        await fs.access(normalized);
        return normalized;
      } catch {
        // Fall through to return resolvedPath
      }
    }
    return resolvedPath;
  }

  const distCandidates = buildDistCandidates(resolvedPath, normalized);

  for (const candidate of distCandidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep going
    }
  }

  throw new Error(
    `Cannot find built CLI at ${distCandidates.join(" or ")}. Run "pnpm build" first, or use dev mode.`,
  );
}

async function resolveRealpathSafe(inputPath: string): Promise<string> {
  try {
    return await fs.realpath(inputPath);
  } catch {
    return inputPath;
  }
}

function buildDistCandidates(...inputs: string[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const inputPath of inputs) {
    if (!inputPath) {
      continue;
    }
    const baseDir = path.dirname(inputPath);
    appendDistCandidates(candidates, seen, path.resolve(baseDir, ".."));
    appendDistCandidates(candidates, seen, baseDir);
    appendNodeModulesBinCandidates(candidates, seen, inputPath);
  }

  return candidates;
}

function appendDistCandidates(candidates: string[], seen: Set<string>, baseDir: string): void {
  const distDir = path.resolve(baseDir, "dist");
  const distEntries = [
    path.join(distDir, "index.js"),
    path.join(distDir, "index.mjs"),
    path.join(distDir, "entry.js"),
    path.join(distDir, "entry.mjs"),
  ];
  for (const entry of distEntries) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    candidates.push(entry);
  }
}

function appendNodeModulesBinCandidates(
  candidates: string[],
  seen: Set<string>,
  inputPath: string,
): void {
  const parts = inputPath.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex <= 0) {
    return;
  }
  if (parts[binIndex - 1] !== "node_modules") {
    return;
  }
  // openclaw from node_modules/.bin points at the package root sibling.
  const binName = path.basename(inputPath);
  const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
  const packageRoot = path.join(nodeModulesDir, binName);
  appendDistCandidates(candidates, seen, packageRoot);
}

function resolveRepoRootForDev(): string {
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new Error("Unable to resolve repo root");
  }
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const srcIndex = parts.lastIndexOf("src");
  if (srcIndex === -1) {
    throw new Error("Dev mode requires running from repo (src/entry.ts)");
  }
  return parts.slice(0, srcIndex).join(path.sep);
}

async function resolveNodePath(): Promise<string> {
  const nodePath = await resolveBinaryPath("node");
  return nodePath;
}

async function resolveBinaryPath(binary: string): Promise<string> {
  const cmd = process.platform === "win32" ? getWindowsSystem32ExePath("where.exe") : "which";
  try {
    const output = execFileSync(cmd, [binary], {
      encoding: "utf8",
      timeout: NODE_BINARY_LOOKUP_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }).trim();
    const resolved = output.split(/\r?\n/)[0]?.trim();
    if (!resolved) {
      throw new Error("empty");
    }
    await fs.access(resolved);
    return resolved;
  } catch {
    throw new Error(
      "Node not found in PATH. Install Node 24.15+ (recommended) or Node 22 LTS (22.22.3+).",
    );
  }
}

export async function resolveOpenClawWrapperPath(
  inputPath: string | undefined,
): Promise<string | undefined> {
  const trimmed = inputPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new Error("not a regular file");
    }
    // Wrappers replace the runtime executable, so require execute permission up
    // front rather than generating a service that fails at boot.
    await fs.access(resolved, fsConstants.X_OK);
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    throw new Error(
      `${OPENCLAW_WRAPPER_ENV_KEY} must point to an executable file: ${resolved}${detail}`,
      { cause: error },
    );
  }
  return resolved;
}

async function resolveCliProgramArguments(params: {
  args: string[];
  dev?: boolean;
  runtime?: GatewayRuntimePreference;
  nodePath?: string;
  wrapperPath?: string;
}): Promise<GatewayProgramArgs> {
  const wrapperPath = await resolveOpenClawWrapperPath(params.wrapperPath);
  if (wrapperPath) {
    return { programArguments: [wrapperPath, ...params.args] };
  }

  const execPath = process.execPath;
  const nodePath =
    params.nodePath ?? (isNodeRuntime(execPath) ? execPath : await resolveNodePath());

  if (params.dev) {
    const repoRoot = resolveRepoRootForDev();
    const devCliPath = path.join(repoRoot, "src", "entry.ts");
    await fs.access(devCliPath);
    return {
      programArguments: [nodePath, "--import", "tsx", devCliPath, ...params.args],
      workingDirectory: repoRoot,
    };
  }

  const cliEntrypointPath = await resolveCliEntrypointPathForService();
  return {
    programArguments: [nodePath, cliEntrypointPath, ...params.args],
  };
}

export async function resolveGatewayProgramArguments(params: {
  port: number;
  dev?: boolean;
  runtime?: GatewayRuntimePreference;
  nodePath?: string;
  wrapperPath?: string;
}): Promise<GatewayProgramArgs> {
  const gatewayArgs = ["gateway", "--port", String(params.port)];
  return resolveCliProgramArguments({
    args: gatewayArgs,
    dev: params.dev,
    runtime: params.runtime,
    nodePath: params.nodePath,
    wrapperPath: params.wrapperPath,
  });
}

export async function resolveNodeProgramArguments(params: {
  host: string;
  port: number;
  contextPath?: string;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  installedAppsSharing?: boolean;
  dev?: boolean;
  runtime?: GatewayRuntimePreference;
  nodePath?: string;
}): Promise<GatewayProgramArgs> {
  const args = ["node", "run", "--host", params.host, "--port", String(params.port)];
  if (params.tls === false && !params.tlsFingerprint) {
    // Managed services must carry plaintext explicitly; omission would let the
    // node runtime re-inherit TLS from the operator's global Gateway config.
    args.push("--no-tls");
  } else if (params.tls || params.tlsFingerprint) {
    args.push("--tls");
  }
  if (params.tlsFingerprint) {
    args.push("--tls-fingerprint", params.tlsFingerprint);
  }
  if (params.contextPath) {
    args.push("--context-path", params.contextPath);
  }
  if (params.nodeId) {
    args.push("--node-id", params.nodeId);
  }
  if (params.displayName) {
    args.push("--display-name", params.displayName);
  }
  if (params.installedAppsSharing !== undefined) {
    args.push(params.installedAppsSharing ? "--share-installed-apps" : "--no-share-installed-apps");
  }
  return resolveCliProgramArguments({
    args,
    dev: params.dev,
    runtime: params.runtime,
    nodePath: params.nodePath,
  });
}
