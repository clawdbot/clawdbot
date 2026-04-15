import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
          env: {
            ...process.env,
            HOME: homeDir,
            OPENCLAW_HOME: homeDir,
            OPENCLAW_SUPPRESS_NOTES: "1",
          },
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
      throw new Error(
        `installed workspace bootstrap did not create required files in ${workspaceDir}: ${missingFiles.join(", ")}`,
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
