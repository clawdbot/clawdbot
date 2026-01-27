import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

import type { MoltbotConfig } from "../config/config.js";
import { resolveBrewExecutable } from "../infra/brew.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { CONFIG_DIR, ensureDir, resolveUserPath } from "../utils.js";
import {
  hasBinary,
  loadWorkspaceSkillEntries,
  resolveSkillsInstallPreferences,
  type SkillEntry,
  type SkillInstallSpec,
  type SkillsInstallPreferences,
} from "./skills.js";
import { resolveSkillKey } from "./skills/frontmatter.js";

export type SkillInstallRequest = {
  workspaceDir: string;
  skillName: string;
  installId: string;
  timeoutMs?: number;
  config?: MoltbotConfig;
};

export type SkillInstallResult = {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number | null;
};

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

function summarizeInstallOutput(text: string): string | undefined {
  const raw = text.trim();
  if (!raw) return undefined;
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;

  const preferred =
    lines.find((line) => /^error\b/i.test(line)) ??
    lines.find((line) => /\b(err!|error:|failed)\b/i.test(line)) ??
    lines.at(-1);

  if (!preferred) return undefined;
  const normalized = preferred.replace(/\s+/g, " ").trim();
  const maxLen = 200;
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1)}…` : normalized;
}

function formatInstallFailureMessage(result: {
  code: number | null;
  stdout: string;
  stderr: string;
}): string {
  const code = typeof result.code === "number" ? `exit ${result.code}` : "unknown exit";
  const summary = summarizeInstallOutput(result.stderr) ?? summarizeInstallOutput(result.stdout);
  if (!summary) return `Install failed (${code})`;
  return `Install failed (${code}): ${summary}`;
}

function resolveInstallId(spec: SkillInstallSpec, index: number): string {
  return (spec.id ?? `${spec.kind}-${index}`).trim();
}

function findInstallSpec(entry: SkillEntry, installId: string): SkillInstallSpec | undefined {
  const specs = entry.metadata?.install ?? [];
  for (const [index, spec] of specs.entries()) {
    if (resolveInstallId(spec, index) === installId) return spec;
  }
  return undefined;
}

function buildNodeInstallCommand(packageName: string, prefs: SkillsInstallPreferences): string[] {
  switch (prefs.nodeManager) {
    case "pnpm":
      return ["pnpm", "add", "-g", packageName];
    case "yarn":
      return ["yarn", "global", "add", packageName];
    case "bun":
      return ["bun", "add", "-g", packageName];
    default:
      return ["npm", "install", "-g", packageName];
  }
}

function buildInstallCommand(
  spec: SkillInstallSpec,
  prefs: SkillsInstallPreferences,
): {
  argv: string[] | null;
  error?: string;
} {
  switch (spec.kind) {
    case "brew": {
      if (!spec.formula) return { argv: null, error: "missing brew formula" };
      return { argv: ["brew", "install", spec.formula] };
    }
    case "node": {
      if (!spec.package) return { argv: null, error: "missing node package" };
      return {
        argv: buildNodeInstallCommand(spec.package, prefs),
      };
    }
    case "go": {
      if (!spec.module) return { argv: null, error: "missing go module" };
      return { argv: ["go", "install", spec.module] };
    }
    case "uv": {
      if (!spec.package) return { argv: null, error: "missing uv package" };
      return { argv: ["uv", "tool", "install", spec.package] };
    }
    case "download": {
      return { argv: null, error: "download install handled separately" };
    }
    default:
      return { argv: null, error: "unsupported installer" };
  }
}

function resolveDownloadTargetDir(entry: SkillEntry, spec: SkillInstallSpec): string {
  if (spec.targetDir?.trim()) return resolveUserPath(spec.targetDir);
  const key = resolveSkillKey(entry.skill, entry);
  return path.join(CONFIG_DIR, "tools", key);
}

function resolveArchiveType(spec: SkillInstallSpec, filename: string): string | undefined {
  const explicit = spec.archive?.trim().toLowerCase();
  if (explicit) return explicit;
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "tar.bz2";
  if (lower.endsWith(".zip")) return "zip";
  return undefined;
}

async function downloadFile(
  url: string,
  destPath: string,
  timeoutMs: number,
): Promise<{ bytes: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status} ${response.statusText})`);
    }
    await ensureDir(path.dirname(destPath));
    const file = fs.createWriteStream(destPath);
    const body = response.body as unknown;
    const readable = isNodeReadableStream(body)
      ? body
      : Readable.fromWeb(body as NodeReadableStream);
    await pipeline(readable, file);
    const stat = await fs.promises.stat(destPath);
    return { bytes: stat.size };
  } finally {
    clearTimeout(timeout);
  }
}

async function extractArchive(params: {
  archivePath: string;
  archiveType: string;
  targetDir: string;
  stripComponents?: number;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const { archivePath, archiveType, targetDir, stripComponents, timeoutMs } = params;
  if (archiveType === "zip") {
    if (!hasBinary("unzip")) {
      return { stdout: "", stderr: "unzip not found on PATH", code: null };
    }
    const argv = ["unzip", "-q", archivePath, "-d", targetDir];
    return await runCommandWithTimeout(argv, { timeoutMs });
  }

  if (!hasBinary("tar")) {
    return { stdout: "", stderr: "tar not found on PATH", code: null };
  }
  const argv = ["tar", "xf", archivePath, "-C", targetDir];
  if (typeof stripComponents === "number" && Number.isFinite(stripComponents)) {
    argv.push("--strip-components", String(Math.max(0, Math.floor(stripComponents))));
  }
  return await runCommandWithTimeout(argv, { timeoutMs });
}

async function installDownloadSpec(params: {
  entry: SkillEntry;
  spec: SkillInstallSpec;
  timeoutMs: number;
}): Promise<SkillInstallResult> {
  const { entry, spec, timeoutMs } = params;
  const url = spec.url?.trim();
  if (!url) {
    return {
      ok: false,
      message: "missing download url",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  let filename = "";
  try {
    const parsed = new URL(url);
    filename = path.basename(parsed.pathname);
  } catch {
    filename = path.basename(url);
  }
  if (!filename) filename = "download";

  const targetDir = resolveDownloadTargetDir(entry, spec);
  await ensureDir(targetDir);

  const archivePath = path.join(targetDir, filename);
  let downloaded = 0;
  try {
    const result = await downloadFile(url, archivePath, timeoutMs);
    downloaded = result.bytes;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const archiveType = resolveArchiveType(spec, filename);
  const shouldExtract = spec.extract ?? Boolean(archiveType);
  if (!shouldExtract) {
    return {
      ok: true,
      message: `Downloaded to ${archivePath}`,
      stdout: `downloaded=${downloaded}`,
      stderr: "",
      code: 0,
    };
  }

  if (!archiveType) {
    return {
      ok: false,
      message: "extract requested but archive type could not be detected",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const extractResult = await extractArchive({
    archivePath,
    archiveType,
    targetDir,
    stripComponents: spec.stripComponents,
    timeoutMs,
  });
  const success = extractResult.code === 0;
  return {
    ok: success,
    message: success
      ? `Downloaded and extracted to ${targetDir}`
      : formatInstallFailureMessage(extractResult),
    stdout: extractResult.stdout.trim(),
    stderr: extractResult.stderr.trim(),
    code: extractResult.code,
  };
}

async function resolveBrewBinDir(timeoutMs: number, brewExe?: string): Promise<string | undefined> {
  const exe = brewExe ?? (hasBinary("brew") ? "brew" : resolveBrewExecutable());
  if (!exe) return undefined;

  const prefixResult = await runCommandWithTimeout([exe, "--prefix"], {
    timeoutMs: Math.min(timeoutMs, 30_000),
  });
  if (prefixResult.code === 0) {
    const prefix = prefixResult.stdout.trim();
    if (prefix) return path.join(prefix, "bin");
  }

  const envPrefix = process.env.HOMEBREW_PREFIX?.trim();
  if (envPrefix) return path.join(envPrefix, "bin");

  for (const candidate of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return undefined;
}

export async function installSkill(params: SkillInstallRequest): Promise<SkillInstallResult> {
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 300_000, 1_000), 900_000);
  const workspaceDir = resolveUserPath(params.workspaceDir);
  const entries = loadWorkspaceSkillEntries(workspaceDir);
  const entry = entries.find((item) => item.skill.name === params.skillName);
  if (!entry) {
    return {
      ok: false,
      message: `Skill not found: ${params.skillName}`,
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const spec = findInstallSpec(entry, params.installId);
  if (!spec) {
    return {
      ok: false,
      message: `Installer not found: ${params.installId}`,
      stdout: "",
      stderr: "",
      code: null,
    };
  }
  if (spec.kind === "download") {
    return await installDownloadSpec({ entry, spec, timeoutMs });
  }

  const prefs = resolveSkillsInstallPreferences(params.config);
  const command = buildInstallCommand(spec, prefs);
  if (command.error) {
    return {
      ok: false,
      message: command.error,
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const brewExe = hasBinary("brew") ? "brew" : resolveBrewExecutable();
  if (spec.kind === "brew" && !brewExe) {
    return {
      ok: false,
      message: "brew not installed",
      stdout: "",
      stderr: "",
      code: null,
    };
  }
  if (spec.kind === "uv" && !hasBinary("uv")) {
    if (brewExe) {
      const brewResult = await runCommandWithTimeout([brewExe, "install", "uv"], {
        timeoutMs,
      });
      if (brewResult.code !== 0) {
        return {
          ok: false,
          message: "Failed to install uv (brew)",
          stdout: brewResult.stdout.trim(),
          stderr: brewResult.stderr.trim(),
          code: brewResult.code,
        };
      }
    } else {
      return {
        ok: false,
        message: "uv not installed (install via brew)",
        stdout: "",
        stderr: "",
        code: null,
      };
    }
  }
  if (!command.argv || command.argv.length === 0) {
    return {
      ok: false,
      message: "invalid install command",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  if (spec.kind === "brew" && brewExe && command.argv[0] === "brew") {
    command.argv[0] = brewExe;
  }

  if (spec.kind === "go" && !hasBinary("go")) {
    if (brewExe) {
      const brewResult = await runCommandWithTimeout([brewExe, "install", "go"], {
        timeoutMs,
      });
      if (brewResult.code !== 0) {
        return {
          ok: false,
          message: "Failed to install go (brew)",
          stdout: brewResult.stdout.trim(),
          stderr: brewResult.stderr.trim(),
          code: brewResult.code,
        };
      }
    } else {
      return {
        ok: false,
        message: "go not installed (install via brew)",
        stdout: "",
        stderr: "",
        code: null,
      };
    }
  }

  let env: NodeJS.ProcessEnv | undefined;
  if (spec.kind === "go" && brewExe) {
    const brewBin = await resolveBrewBinDir(timeoutMs, brewExe);
    if (brewBin) env = { GOBIN: brewBin };
  }

  const result = await (async () => {
    const argv = command.argv;
    if (!argv || argv.length === 0) {
      return { code: null, stdout: "", stderr: "invalid install command" };
    }
    try {
      return await runCommandWithTimeout(argv, {
        timeoutMs,
        env,
      });
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      return { code: null, stdout: "", stderr };
    }
  })();

  const success = result.code === 0;
  return {
    ok: success,
    message: success ? "Installed" : formatInstallFailureMessage(result),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code,
  };
}
