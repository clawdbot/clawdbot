import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { ResolvedAcpxPluginConfig } from "./config.js";

const CODEX_ACP_PACKAGE = "@zed-industries/codex-acp";
const CODEX_ACP_PACKAGE_RANGE = "^0.12.0";
const CODEX_ACP_BIN = "codex-acp";
const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_ACP_PACKAGE_VERSION = "0.31.4";
const CLAUDE_ACP_BIN = "claude-agent-acp";
const RUN_CONFIGURED_COMMAND_SENTINEL = "--openclaw-run-configured";
const requireFromHere = createRequire(import.meta.url);

type PackageManifest = {
  name?: unknown;
  bin?: unknown;
};

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
    const manifest = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as PackageManifest;
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

function buildAdapterWrapperScript(params: {
  displayName: string;
  packageSpec: string;
  binName: string;
  installedBinPath?: string;
  envSetup: string;
}): string {
  return `#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

${params.envSetup}
const configuredArgs = process.argv.slice(2);

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
  env,
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error(\`[openclaw] failed to launch ${params.displayName} ACP wrapper: \${error.message}\`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (code !== null) {
    process.exit(code);
  }
  process.exit(signal ? 1 : 0);
});
`;
}

function buildCodexAcpWrapperScript(installedBinPath?: string): string {
  return buildAdapterWrapperScript({
    displayName: "Codex",
    packageSpec: `${CODEX_ACP_PACKAGE}@${CODEX_ACP_PACKAGE_RANGE}`,
    binName: CODEX_ACP_BIN,
    installedBinPath,
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

async function prepareIsolatedCodexHome(baseDir: string): Promise<string> {
  const codexHome = path.join(baseDir, "codex-home");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    "# Generated by OpenClaw for Codex ACP sessions.\n",
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
  await prepareIsolatedCodexHome(codexBaseDir);
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
