import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const WORKSPACE_TEMPLATE_PACK_PATHS = [
  "docs/reference/templates/AGENTS.md",
  "docs/reference/templates/SOUL.md",
  "docs/reference/templates/TOOLS.md",
  "docs/reference/templates/IDENTITY.md",
  "docs/reference/templates/USER.md",
  "docs/reference/templates/HEARTBEAT.md",
  "docs/reference/templates/BOOTSTRAP.md",
];

const REQUIRED_BOOTSTRAP_WORKSPACE_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
];

export const WORKSPACE_BOOTSTRAP_SMOKE_TIMEOUT_MS = 15_000;
const SAFE_UNIX_SMOKE_PATH = "/usr/bin:/bin";

export function createWorkspaceBootstrapSmokeEnv(env, homeDir, overrides = {}) {
  const allowlistedEnvEntries = [
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "WINDIR",
  ];
  const windowsRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  const nodeBinDir = dirname(process.execPath);
  const safePath =
    process.platform === "win32"
      ? `${nodeBinDir};${windowsRoot}\\System32;${windowsRoot}`
      : `${nodeBinDir}:${SAFE_UNIX_SMOKE_PATH}`;

  return {
    ...Object.fromEntries(
      allowlistedEnvEntries.flatMap((key) => {
        const value = env[key];
        return typeof value === "string" && value.length > 0 ? [[key, value]] : [];
      }),
    ),
    PATH: safePath,
    HOME: homeDir,
    USERPROFILE: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_SUPPRESS_NOTES: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_SHARED_CREDENTIALS_FILE: join(homeDir, ".aws", "credentials"),
    AWS_CONFIG_FILE: join(homeDir, ".aws", "config"),
    ...overrides,
  };
}

function collectMissingBootstrapWorkspaceFiles(workspaceDir) {
  return REQUIRED_BOOTSTRAP_WORKSPACE_FILES.filter(
    (filename) => !existsSync(join(workspaceDir, filename)),
  );
}

function describeExecFailure(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const stdout =
    typeof error.stdout === "string"
      ? error.stdout.trim()
      : error.stdout instanceof Uint8Array
        ? Buffer.from(error.stdout).toString("utf8").trim()
        : "";
  const stderr =
    typeof error.stderr === "string"
      ? error.stderr.trim()
      : error.stderr instanceof Uint8Array
        ? Buffer.from(error.stderr).toString("utf8").trim()
        : "";
  return [error.message, stdout, stderr].filter(Boolean).join(" | ");
}

export function runInstalledWorkspaceBootstrapSmoke(params) {
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-workspace-bootstrap-smoke-"));
  const homeDir = join(tempRoot, "home");
  const cwd = join(tempRoot, "cwd");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  let combinedOutput = "";
  try {
    try {
      execFileSync(
        process.execPath,
        [
          join(params.packageRoot, "openclaw.mjs"),
          "agent",
          "--message",
          "workspace bootstrap smoke",
          "--session-id",
          "workspace-bootstrap-smoke",
          "--local",
          "--timeout",
          "1",
          "--json",
        ],
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 16,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: WORKSPACE_BOOTSTRAP_SMOKE_TIMEOUT_MS,
          env: createWorkspaceBootstrapSmokeEnv(process.env, homeDir),
        },
      );
    } catch (error) {
      combinedOutput = describeExecFailure(error);
    }

    if (combinedOutput.includes("Missing workspace template:")) {
      throw new Error(
        `installed workspace bootstrap failed before agent execution: ${combinedOutput}`,
      );
    }

    const workspaceDir = join(homeDir, ".openclaw", "workspace");
    const missingFiles = collectMissingBootstrapWorkspaceFiles(workspaceDir);
    if (missingFiles.length > 0) {
      const outputDetails = combinedOutput.length > 0 ? `\nCommand output:\n${combinedOutput}` : "";
      throw new Error(
        `installed workspace bootstrap did not create required files in ${workspaceDir}: ${missingFiles.join(", ")}${outputDetails}`,
      );
    }
  } finally {
    try {
      rmSync(tempRoot, { force: true, recursive: true });
    } catch {
      // best effort cleanup only
    }
  }
}
