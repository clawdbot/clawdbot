import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import {
  extractTrustedCodexProjectPaths,
  renderIsolatedCodexConfig,
} from "./codex-trust-config.js";
import { resolveAcpxPluginRoot } from "./config.js";
import type { ResolvedAcpxPluginConfig } from "./config.js";
import {
  OPENCLAW_ACPX_LEASE_ID_ARG,
  OPENCLAW_ACPX_LEASE_ID_ENV,
  OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
} from "./process-lease.js";

const CODEX_ACP_PACKAGE = "@zed-industries/codex-acp";
const CODEX_ACP_BIN = "codex-acp";
const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_ACP_BIN = "claude-agent-acp";
const RUN_CONFIGURED_COMMAND_SENTINEL = "--openclaw-run-configured";
const requireFromHere = createRequire(import.meta.url);

type PackageManifest = {
  name?: unknown;
  bin?: unknown;
  dependencies?: Record<string, unknown>;
};

function readSelfManifest(): PackageManifest {
  const manifestPath = path.join(resolveAcpxPluginRoot(import.meta.url), "package.json");
  return JSON.parse(fsSync.readFileSync(manifestPath, "utf8")) as PackageManifest;
}

function readManifestDependencyVersion(packageName: string): string {
  const version = readSelfManifest().dependencies?.[packageName];
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`Missing ${packageName} dependency version in @openclaw/acpx manifest`);
  }
  return version;
}

const CODEX_ACP_PACKAGE_VERSION = readManifestDependencyVersion(CODEX_ACP_PACKAGE);
const CLAUDE_ACP_PACKAGE_VERSION = readManifestDependencyVersion(CLAUDE_ACP_PACKAGE);

function quoteCommandPart(value: string): string {
  return JSON.stringify(value);
}

function splitCommandParts(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function resolvePackageBinPath(
  packageJsonPath: string,
  manifest: PackageManifest,
  binName: string,
): string | undefined {
  const { bin } = manifest;
  const relativeBinPath =
    typeof bin === "string"
      ? bin
      : bin && typeof bin === "object"
        ? (bin as Record<string, unknown>)[binName]
        : undefined;
  if (typeof relativeBinPath !== "string" || relativeBinPath.trim() === "") {
    return undefined;
  }
  return path.resolve(path.dirname(packageJsonPath), relativeBinPath);
}

async function resolveInstalledAcpPackageBinPath(
  packageName: string,
  binName: string,
): Promise<string | undefined> {
  try {
    const packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`);
    const { value: manifest } = await readJsonFileWithFallback<PackageManifest>(
      packageJsonPath,
      {},
    );
    if (manifest.name !== packageName) {
      return undefined;
    }
    const binPath = resolvePackageBinPath(packageJsonPath, manifest, binName);
    if (!binPath) {
      return undefined;
    }
    await fs.access(binPath);
    return binPath;
  } catch {
    return undefined;
  }
}

async function resolveInstalledCodexAcpBinPath(): Promise<string | undefined> {
  // Keep OpenClaw's isolated CODEX_HOME wrapper, but launch the plugin-local
  // Codex ACP adapter when the package dependency is available.
  return await resolveInstalledAcpPackageBinPath(CODEX_ACP_PACKAGE, CODEX_ACP_BIN);
}

async function resolveInstalledClaudeAcpBinPath(): Promise<string | undefined> {
  return await resolveInstalledAcpPackageBinPath(CLAUDE_ACP_PACKAGE, CLAUDE_ACP_BIN);
}

type DiagnosticRedactionRuleSpec = {
  source: string;
  flags: string;
  replacement: string;
};

const DIAGNOSTIC_REDACTION_RULES: DiagnosticRedactionRuleSpec[] = [
  {
    source: String.raw`(authorization\s*[:=]\s*bearer\s+)[^\s'"<>]+`,
    flags: "gi",
    replacement: "$1[REDACTED]",
  },
  {
    source: String.raw`((?:api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|credential)\s*[:=]\s*)[^\s'"<>]+`,
    flags: "gi",
    replacement: "$1[REDACTED]",
  },
  {
    source: String.raw`("(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*")[^"]+`,
    flags: "g",
    replacement: "$1[REDACTED]",
  },
  {
    source: String.raw`(["']?(?:api[-_]?key|apiKey|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|id[-_]?token|idToken|auth[-_]?token|authToken|client[-_]?secret|clientSecret|app[-_]?secret|appSecret|token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?)[^"',}\s<>]+`,
    flags: "gi",
    replacement: "$1[REDACTED]",
  },
  {
    source: String.raw`([?&](?:access[-_]?token|auth[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|token|key|secret|password|pass|passwd|auth|signature)=)[^&\s'"<>]+`,
    flags: "gi",
    replacement: "$1[REDACTED]",
  },
  {
    source: String.raw`(--(?:api[-_]?key|token|secret|password|passwd)\s+)[^\s'"]+`,
    flags: "gi",
    replacement: "$1[REDACTED]",
  },
  {
    source:
      String.raw`-----BEGIN [A-Z ]*PRI` +
      String.raw`VATE KEY-----[\s\S]+?-----END [A-Z ]*PRI` +
      String.raw`VATE KEY-----`,
    flags: "g",
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    source: String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
    flags: "g",
    replacement: "[REDACTED_OPENAI_KEY]",
  },
  {
    source: String.raw`\b(gh[pousr]_[A-Za-z0-9_]{20,})\b`,
    flags: "g",
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    source: String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
    flags: "g",
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    source: String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_SLACK_TOKEN]",
  },
  {
    source: String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_API_KEY]",
  },
  {
    source: String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
    flags: "g",
    replacement: "[REDACTED_GOOGLE_KEY]",
  },
  {
    source: String.raw`\b(ya29\.[0-9A-Za-z_\-./+=]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_GOOGLE_TOKEN]",
  },
  {
    source: String.raw`\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_JWT]",
  },
  {
    source: String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_API_KEY]",
  },
  {
    source: String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_NPM_TOKEN]",
  },
  {
    source: String.raw`\b(LTAI[A-Za-z0-9]{10,})\b`,
    flags: "g",
    replacement: "[REDACTED_ACCESS_KEY]",
  },
  { source: String.raw`\b(hf_[A-Za-z0-9]{10,})\b`, flags: "g", replacement: "[REDACTED_API_KEY]" },
  {
    source: String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
    flags: "g",
    replacement: "bot[REDACTED_TELEGRAM_TOKEN]",
  },
  {
    source: String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
    flags: "g",
    replacement: "[REDACTED_TELEGRAM_TOKEN]",
  },
];

function renderDiagnosticRedactionRuleSpecs(): string {
  return JSON.stringify(DIAGNOSTIC_REDACTION_RULES);
}

function buildAdapterWrapperScript(params: {
  displayName: string;
  packageSpec: string;
  binName: string;
  installedBinPath?: string;
  envSetup: string;
  stderrLogFileNamePrefix?: string;
}): string {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

${params.envSetup}
const stderrLogFileNamePrefix = ${params.stderrLogFileNamePrefix ? JSON.stringify(params.stderrLogFileNamePrefix) : "undefined"};
const stderrLogMaxChars = 256 * 1024;

const openClawWrapperArgs = new Set([
  ${quoteCommandPart(OPENCLAW_ACPX_LEASE_ID_ARG)},
  ${quoteCommandPart(OPENCLAW_GATEWAY_INSTANCE_ID_ARG)},
]);

function readOpenClawWrapperArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeDiagnosticFilePart(value) {
  const sanitized = String(value || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return sanitized || "pid-" + process.pid;
}

function resolveStderrLogPath(args) {
  if (!stderrLogFileNamePrefix) {
    return undefined;
  }
  const leaseId =
    process.env[${JSON.stringify(OPENCLAW_ACPX_LEASE_ID_ENV)}] ||
    readOpenClawWrapperArg(args, ${quoteCommandPart(OPENCLAW_ACPX_LEASE_ID_ARG)}) ||
    "pid-" + process.pid;
  const fileName = stderrLogFileNamePrefix + "." + safeDiagnosticFilePart(leaseId) + ".log";
  return fileURLToPath(new URL("./" + fileName, import.meta.url));
}

const diagnosticRedactionRules = ${renderDiagnosticRedactionRuleSpecs()}.map((rule) => [
  new RegExp(rule.source, rule.flags),
  rule.replacement,
]);

function redactDiagnosticText(text) {
  let redacted = text;
  for (const [pattern, replacement] of diagnosticRedactionRules) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

let pendingStderrLogText = "";
const stderrPrivateKeyEndPattern = /-----END [A-Z ]*PRIVATE KEY-----/;

function hasUnclosedPrivateKeyBlock(text) {
  let lastBeginIndex = -1;
  for (const match of text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)) {
    lastBeginIndex = match.index ?? lastBeginIndex;
  }
  if (lastBeginIndex === -1) {
    return -1;
  }
  return stderrPrivateKeyEndPattern.test(text.slice(lastBeginIndex)) ? -1 : lastBeginIndex;
}

function writeRedactedStderrLog(text) {
  if (!stderrLogPath) {
    return;
  }
  if (!text) {
    return;
  }
  try {
    appendFileSync(stderrLogPath, redactDiagnosticText(text), "utf8");
    const current = readFileSync(stderrLogPath, "utf8");
    if (current.length > stderrLogMaxChars) {
      writeFileSync(stderrLogPath, current.slice(-stderrLogMaxChars), "utf8");
    }
  } catch {
    // Stderr capture is diagnostic-only; never break the ACP adapter.
  }
}

function redactIncompletePrivateKeyTail(text) {
  const unclosedPrivateKeyStart = hasUnclosedPrivateKeyBlock(text);
  if (unclosedPrivateKeyStart === -1) {
    return text;
  }
  return text.slice(0, unclosedPrivateKeyStart) + "[REDACTED_PRIVATE_KEY]";
}

function flushFinalizedStderrLogText() {
  const lastLineBreak = pendingStderrLogText.lastIndexOf("\\n");
  if (lastLineBreak === -1) {
    if (pendingStderrLogText.length > stderrLogMaxChars) {
      pendingStderrLogText = pendingStderrLogText.slice(-stderrLogMaxChars);
    }
    return;
  }
  let flushEnd = lastLineBreak + 1;
  const unclosedPrivateKeyStart = hasUnclosedPrivateKeyBlock(
    pendingStderrLogText.slice(0, flushEnd),
  );
  if (unclosedPrivateKeyStart !== -1) {
    flushEnd = unclosedPrivateKeyStart;
  }
  if (flushEnd <= 0) {
    if (pendingStderrLogText.length > stderrLogMaxChars) {
      pendingStderrLogText = pendingStderrLogText.slice(-stderrLogMaxChars);
    }
    return;
  }
  const finalizedText = pendingStderrLogText.slice(0, flushEnd);
  pendingStderrLogText = pendingStderrLogText.slice(flushEnd);
  writeRedactedStderrLog(finalizedText);
}

function appendStderrLog(chunk) {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (!text) {
    return;
  }
  pendingStderrLogText += text;
  flushFinalizedStderrLogText();
}

function finishStderrLog() {
  const text = redactIncompletePrivateKeyTail(pendingStderrLogText);
  pendingStderrLogText = "";
  writeRedactedStderrLog(text);
}

function stripOpenClawWrapperArgs(args) {
  const stripped = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (openClawWrapperArgs.has(value)) {
      index += 1;
      continue;
    }
    stripped.push(value);
  }
  return stripped;
}

const rawConfiguredArgs = process.argv.slice(2);
const stderrLogPath = resolveStderrLogPath(rawConfiguredArgs);

try {
  if (stderrLogPath) {
    writeFileSync(stderrLogPath, "", "utf8");
  }
} catch {
  // Stderr capture is diagnostic-only; never break the ACP adapter.
}

const configuredArgs = stripOpenClawWrapperArgs(rawConfiguredArgs);

function resolveNpmCliPath() {
  const candidate = path.resolve(
    path.dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return existsSync(candidate) ? candidate : undefined;
}

const npmCliPath = resolveNpmCliPath();
const installedBinPath = ${params.installedBinPath ? quoteCommandPart(params.installedBinPath) : "undefined"};
let defaultCommand;
let defaultArgs;
if (installedBinPath) {
  defaultCommand = process.execPath;
  defaultArgs = [installedBinPath];
} else if (npmCliPath) {
  defaultCommand = process.execPath;
  defaultArgs = [npmCliPath, "exec", "--yes", "--package", "${params.packageSpec}", "--", "${params.binName}"];
} else {
  defaultCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  defaultArgs = ["--yes", "--package", "${params.packageSpec}", "--", "${params.binName}"];
}
const command =
  configuredArgs[0] === "${RUN_CONFIGURED_COMMAND_SENTINEL}" ? configuredArgs[1] : defaultCommand;
const args =
  configuredArgs[0] === "${RUN_CONFIGURED_COMMAND_SENTINEL}"
    ? configuredArgs.slice(2)
    : [...defaultArgs, ...configuredArgs];

if (!command) {
  console.error("[openclaw] missing configured ${params.displayName} ACP command");
  process.exit(1);
}

const child = spawn(command, args, {
  detached: process.platform !== "win32",
  env,
  stdio: ["inherit", "inherit", "pipe"],
  windowsHide: true,
});

child.stderr?.on("data", (chunk) => {
  appendStderrLog(chunk);
  process.stderr.write(chunk);
});

let forceKillTimer;
let orphanCleanupStarted = false;
let childExitCode = 1;

function killChildTree(signal, options = {}) {
  if (!child.pid || (!options.force && child.killed)) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      // The adapter can spawn grandchildren; signaling the process group keeps
      // the generated wrapper from leaving an ACP tree behind.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct child signaling below.
    }
  }
  child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    killChildTree(signal);
  });
}

const originalParentPid = process.ppid;
const parentWatcher =
  process.platform === "win32"
    ? undefined
    : setInterval(() => {
        if (process.ppid === originalParentPid || process.ppid !== 1) {
          return;
        }
        if (orphanCleanupStarted) {
          return;
        }
        orphanCleanupStarted = true;
        if (parentWatcher) {
          clearInterval(parentWatcher);
        }
        killChildTree("SIGTERM");
        // Keep the wrapper alive long enough for stubborn adapters to receive
        // a forced fallback signal after SIGTERM.
        forceKillTimer = setTimeout(() => {
          killChildTree("SIGKILL", { force: true });
          childExitCode = 1;
        }, 1_500);
      }, 1_000);
parentWatcher?.unref?.();

child.on("error", (error) => {
  console.error(\`[openclaw] failed to launch ${params.displayName} ACP wrapper: \${error.message}\`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (parentWatcher) {
    clearInterval(parentWatcher);
  }
  if (orphanCleanupStarted) {
    return;
  }
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
  }
  if (code !== null) {
    childExitCode = code;
    return;
  }
  childExitCode = signal ? 1 : 0;
});

child.on("close", () => {
  finishStderrLog();
  process.exit(childExitCode);
});
`;
}

function buildCodexAcpWrapperScript(installedBinPath?: string): string {
  return buildAdapterWrapperScript({
    displayName: "Codex",
    packageSpec: `${CODEX_ACP_PACKAGE}@${CODEX_ACP_PACKAGE_VERSION}`,
    binName: CODEX_ACP_BIN,
    installedBinPath,
    stderrLogFileNamePrefix: "codex-acp-wrapper.stderr",
    envSetup: `const codexHome = fileURLToPath(new URL("./codex-home/", import.meta.url));
const env = {
  ...process.env,
  CODEX_HOME: codexHome,
};`,
  });
}

function buildClaudeAcpWrapperScript(installedBinPath?: string): string {
  return buildAdapterWrapperScript({
    displayName: "Claude",
    // This package is patched in OpenClaw; fallback must not float to an unpatched newer release.
    packageSpec: `${CLAUDE_ACP_PACKAGE}@${CLAUDE_ACP_PACKAGE_VERSION}`,
    binName: CLAUDE_ACP_BIN,
    installedBinPath,
    envSetup: `const env = {
  ...process.env,
};`,
  });
}

async function readSourceCodexConfig(codexHome: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function prepareIsolatedCodexHome(params: {
  baseDir: string;
  workspaceDir: string;
}): Promise<string> {
  const sourceCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sourceConfig = await readSourceCodexConfig(sourceCodexHome);
  const trustedProjectPaths = [
    ...(sourceConfig ? extractTrustedCodexProjectPaths(sourceConfig) : []),
    params.workspaceDir,
  ];
  const codexHome = path.join(params.baseDir, "codex-home");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    renderIsolatedCodexConfig({
      sourceConfigToml: sourceConfig,
      projectPaths: trustedProjectPaths,
    }),
    "utf8",
  );
  return codexHome;
}

async function makeGeneratedWrapperExecutableIfPossible(wrapperPath: string): Promise<void> {
  try {
    await fs.chmod(wrapperPath, 0o755);
  } catch {
    // The wrapper is invoked via `node wrapper.mjs`; executable mode is only a convenience.
  }
}

async function writeCodexAcpWrapper(baseDir: string, installedBinPath?: string): Promise<string> {
  await fs.mkdir(baseDir, { recursive: true });
  const wrapperPath = path.join(baseDir, "codex-acp-wrapper.mjs");
  await fs.writeFile(wrapperPath, buildCodexAcpWrapperScript(installedBinPath), {
    encoding: "utf8",
  });
  await makeGeneratedWrapperExecutableIfPossible(wrapperPath);
  return wrapperPath;
}

async function writeClaudeAcpWrapper(baseDir: string, installedBinPath?: string): Promise<string> {
  await fs.mkdir(baseDir, { recursive: true });
  const wrapperPath = path.join(baseDir, "claude-agent-acp-wrapper.mjs");
  await fs.writeFile(wrapperPath, buildClaudeAcpWrapperScript(installedBinPath), {
    encoding: "utf8",
  });
  await makeGeneratedWrapperExecutableIfPossible(wrapperPath);
  return wrapperPath;
}

function buildWrapperCommand(wrapperPath: string, args: string[] = []): string {
  return [process.execPath, wrapperPath, ...args].map(quoteCommandPart).join(" ");
}

function isAcpPackageSpec(value: string, packageName: string): boolean {
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedPackageName}(?:@.+)?$`, "i").test(value.trim());
}

function isAcpBinName(value: string, binName: string): boolean {
  const commandName = basename(value);
  const escapedBinName = binName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedBinName}(?:\\.exe|\\.[cm]?js)?$`, "i").test(commandName);
}

function isPackageRunnerCommand(value: string): boolean {
  return /^(?:npx|npm|pnpm|bunx)(?:\.cmd|\.exe)?$/i.test(basename(value));
}

function extractConfiguredAdapterArgs(params: {
  configuredCommand?: string;
  packageName: string;
  binName: string;
}): string[] | undefined {
  const trimmedConfiguredCommand = params.configuredCommand?.trim();
  if (!trimmedConfiguredCommand) {
    return [];
  }
  const parts = splitCommandParts(trimmedConfiguredCommand);
  if (!parts.length) {
    return [];
  }

  const packageIndex = parts.findIndex((part) => isAcpPackageSpec(part, params.packageName));
  if (packageIndex >= 0) {
    if (!isPackageRunnerCommand(parts[0] ?? "")) {
      return undefined;
    }
    const afterPackage = parts.slice(packageIndex + 1);
    if (afterPackage[0] === "--" && isAcpBinName(afterPackage[1] ?? "", params.binName)) {
      return afterPackage.slice(2);
    }
    if (isAcpBinName(afterPackage[0] ?? "", params.binName)) {
      return afterPackage.slice(1);
    }
    return afterPackage[0] === "--" ? afterPackage.slice(1) : afterPackage;
  }

  if (isAcpBinName(parts[0] ?? "", params.binName)) {
    return parts.slice(1);
  }
  if (basename(parts[0] ?? "") === "node" && isAcpBinName(parts[1] ?? "", params.binName)) {
    return parts.slice(2);
  }

  return undefined;
}

function buildCodexAcpWrapperCommand(wrapperPath: string, configuredCommand?: string): string {
  const configuredAdapterArgs = extractConfiguredAdapterArgs({
    configuredCommand,
    packageName: CODEX_ACP_PACKAGE,
    binName: CODEX_ACP_BIN,
  });
  if (configuredAdapterArgs) {
    return buildWrapperCommand(wrapperPath, configuredAdapterArgs);
  }
  return buildWrapperCommand(wrapperPath, [
    RUN_CONFIGURED_COMMAND_SENTINEL,
    ...splitCommandParts(configuredCommand?.trim() ?? ""),
  ]);
}

function buildClaudeAcpWrapperCommand(wrapperPath: string, configuredCommand?: string): string {
  const configuredAdapterArgs = extractConfiguredAdapterArgs({
    configuredCommand,
    packageName: CLAUDE_ACP_PACKAGE,
    binName: CLAUDE_ACP_BIN,
  });
  if (configuredAdapterArgs) {
    return buildWrapperCommand(wrapperPath, configuredAdapterArgs);
  }
  return configuredCommand?.trim() || buildWrapperCommand(wrapperPath);
}

export async function prepareAcpxCodexAuthConfig(params: {
  pluginConfig: ResolvedAcpxPluginConfig;
  stateDir: string;
  logger?: unknown;
  resolveInstalledCodexAcpBinPath?: () => Promise<string | undefined>;
  resolveInstalledClaudeAcpBinPath?: () => Promise<string | undefined>;
}): Promise<ResolvedAcpxPluginConfig> {
  void params.logger;
  const codexBaseDir = path.join(params.stateDir, "acpx");
  await prepareIsolatedCodexHome({
    baseDir: codexBaseDir,
    workspaceDir: params.pluginConfig.cwd,
  });
  const installedCodexBinPath = await (
    params.resolveInstalledCodexAcpBinPath ?? resolveInstalledCodexAcpBinPath
  )();
  const installedClaudeBinPath = await (
    params.resolveInstalledClaudeAcpBinPath ?? resolveInstalledClaudeAcpBinPath
  )();
  const wrapperPath = await writeCodexAcpWrapper(codexBaseDir, installedCodexBinPath);
  const claudeWrapperPath = await writeClaudeAcpWrapper(codexBaseDir, installedClaudeBinPath);
  const configuredCodexCommand = params.pluginConfig.agents.codex;
  const configuredClaudeCommand = params.pluginConfig.agents.claude;

  return {
    ...params.pluginConfig,
    agents: {
      ...params.pluginConfig.agents,
      codex: buildCodexAcpWrapperCommand(wrapperPath, configuredCodexCommand),
      claude: buildClaudeAcpWrapperCommand(claudeWrapperPath, configuredClaudeCommand),
    },
  };
}
