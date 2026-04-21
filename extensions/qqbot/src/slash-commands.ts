/**
 * QQBot plugin-level slash command handler.
 *
 * Design goals:
 * 1. Intercept plugin commands before messages enter the AI queue.
 * 2. Let unmatched "/" messages continue through the normal framework path.
 * 3. Keep command registration small and explicit.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveRuntimeServiceVersion } from "openclaw/plugin-sdk/cli-runtime";
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { QQBotAccountConfig } from "./types.js";
import { debugLog } from "./utils/debug-log.js";
import { getHomeDir, getQQBotDataDir, isWindows } from "./utils/platform.js";
const require = createRequire(import.meta.url);

// Read the package version from package.json.
const PLUGIN_VERSION = readPluginPackageVersion({ require });

const QQBOT_PLUGIN_GITHUB_URL = "https://github.com/openclaw/openclaw/tree/main/extensions/qqbot";
const QQBOT_UPGRADE_GUIDE_URL = "https://q.qq.com/qqbot/openclaw/upgrade.html";

// ============ Types ============

/** Slash command context (message metadata plus runtime state). */
export interface SlashCommandContext {
  /** Message type. */
  type: "c2c" | "guild" | "dm" | "group";
  /** Sender ID. */
  senderId: string;
  /** Sender display name. */
  senderName?: string;
  /** Message ID used for passive replies. */
  messageId: string;
  /** Event timestamp from QQ as an ISO string. */
  eventTimestamp: string;
  /** Local receipt timestamp in milliseconds. */
  receivedAt: number;
  /** Raw message content. */
  rawContent: string;
  /** Command arguments after stripping the command name. */
  args: string;
  /** Channel ID for guild messages. */
  channelId?: string;
  /** Group openid for group messages. */
  groupOpenid?: string;
  /** Account ID. */
  accountId: string;
  /** Bot App ID. */
  appId: string;
  /** Account config available to the command handler. */
  accountConfig?: QQBotAccountConfig;
  /** Whether the sender is authorized per the allowFrom config. */
  commandAuthorized: boolean;
  /** Queue snapshot for the current sender. */
  queueSnapshot: QueueSnapshot;
}

/** Queue status snapshot. */
export interface QueueSnapshot {
  /** Total pending messages across all sender queues. */
  totalPending: number;
  /** Number of senders currently being processed. */
  activeUsers: number;
  /** Maximum concurrent sender count. */
  maxConcurrentUsers: number;
  /** Pending messages for the current sender. */
  senderPending: number;
}

/** Slash command result: text, a text+file result, or null to skip handling. */
export type SlashCommandResult = string | SlashCommandFileResult | null;

/** Slash command result that sends text first and then a local file. */
export interface SlashCommandFileResult {
  text: string;
  /** Local file path to send. */
  filePath: string;
}

/** Slash command definition. */
interface SlashCommand {
  /** Command name without the leading slash. */
  name: string;
  /** Short description. */
  description: string;
  /** Detailed usage text shown by `/command ?`. */
  usage?: string;
  /** When true, the command requires the sender to pass the allowFrom authorization check. */
  requireAuth?: boolean;
  /** Command handler. */
  handler: (ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>;
}

/** Framework command definition for commands that require authorization. */
export interface QQBotFrameworkCommand {
  name: string;
  description: string;
  usage?: string;
  handler: (ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>;
}

function normalizeCommandAllowlistEntry(entry: unknown): string {
  if (
    typeof entry === "string" ||
    typeof entry === "number" ||
    typeof entry === "boolean" ||
    typeof entry === "bigint"
  ) {
    return `${entry}`
      .trim()
      .replace(/^qqbot:\s*/i, "")
      .trim();
  }
  return "";
}

function hasExplicitCommandAllowlist(accountConfig?: QQBotAccountConfig): boolean {
  const allowFrom = accountConfig?.allowFrom;
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) {
    return false;
  }
  return allowFrom.every((entry) => {
    const normalized = normalizeCommandAllowlistEntry(entry);
    return normalized.length > 0 && normalized !== "*";
  });
}

// ============ Command registry ============

// Pre-dispatch commands (requireAuth: false) — handled immediately before queuing.
const commands: Map<string, SlashCommand> = new Map();

// Framework commands (requireAuth: true) — registered via api.registerCommand() so that
// resolveCommandAuthorization() applies commands.allowFrom.qqbot precedence and
// qqbot: prefix normalization before the handler runs.
const frameworkCommands: Map<string, SlashCommand> = new Map();

function registerCommand(cmd: SlashCommand): void {
  if (cmd.requireAuth) {
    frameworkCommands.set(normalizeLowercaseStringOrEmpty(cmd.name), cmd);
  } else {
    commands.set(normalizeLowercaseStringOrEmpty(cmd.name), cmd);
  }
}

/**
 * Return all commands that require authorization, for registration with the
 * framework via api.registerCommand() in registerFull().
 */
export function getFrameworkCommands(): QQBotFrameworkCommand[] {
  return Array.from(frameworkCommands.values()).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    usage: cmd.usage,
    handler: cmd.handler,
  }));
}

// ============ Built-in commands ============

/**
 * /bot-ping — test current network latency between OpenClaw and QQ.
 */
registerCommand({
  name: "bot-ping",
  description: "测试 OpenClaw 与 QQ 之间的网络延迟",
  usage: [
    `/bot-ping`,
    ``,
    `测试当前 OpenClaw 宿主机与 QQ 服务器之间的网络延迟。`,
    `返回网络传输耗时和插件处理耗时。`,
  ].join("\n"),
  handler: (ctx) => {
    const now = Date.now();
    const eventTime = new Date(ctx.eventTimestamp).getTime();
    if (isNaN(eventTime)) {
      return `✅ pong!`;
    }
    const totalMs = now - eventTime;
    const qqToPlugin = ctx.receivedAt - eventTime;
    const pluginProcess = now - ctx.receivedAt;
    const lines = [
      `✅ pong!`,
      ``,
      `⏱ 延迟：${totalMs}ms`,
      `  ├ 网络传输：${qqToPlugin}ms`,
      `  └ 插件处理：${pluginProcess}ms`,
    ];
    return lines.join("\n");
  },
});

/**
 * /bot-version — show the OpenClaw framework version.
 */
registerCommand({
  name: "bot-version",
  description: "查看 OpenClaw 框架版本",
  usage: [`/bot-version`, ``, `查看当前 OpenClaw 框架版本。`].join("\n"),
  handler: async () => {
    const frameworkVersion = resolveRuntimeServiceVersion();
    const lines = [`🦞 OpenClaw 版本：${frameworkVersion}`];
    lines.push(`🌟 官方 GitHub 仓库：[点击前往](${QQBOT_PLUGIN_GITHUB_URL})`);
    return lines.join("\n");
  },
});

/**
 * /bot-upgrade — show the upgrade guide.
 */
registerCommand({
  name: "bot-upgrade",
  description: "查看 QQBot 升级指引",
  usage: [`/bot-upgrade`, ``, `查看 QQBot 升级说明。`].join("\n"),
  handler: () =>
    [`📘 QQBot 升级指引：`, `[点击查看升级说明](${QQBOT_UPGRADE_GUIDE_URL})`].join("\n"),
});

/**
 * /bot-help — list all built-in QQBot commands.
 */
registerCommand({
  name: "bot-help",
  description: "查看所有内置命令",
  usage: [
    `/bot-help`,
    ``,
    `查看所有可用的 QQBot 内置命令及其简要说明。`,
    `在命令后追加 ? 可查看详细用法。`,
  ].join("\n"),
  handler: () => {
    const lines = [`### QQBot 内置命令`, ``];
    for (const [name, cmd] of commands) {
      lines.push(`<qqbot-cmd-input text="/${name}" show="/${name}"/> ${cmd.description}`);
    }
    for (const [name, cmd] of frameworkCommands) {
      lines.push(`<qqbot-cmd-input text="/${name}" show="/${name}"/> ${cmd.description}`);
    }
    return lines.join("\n");
  },
});

/** Read user-configured log file paths from local config files. */
function getConfiguredLogFiles(): string[] {
  const homeDir = getHomeDir();
  const files: string[] = [];
  for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
    try {
      const cfgPath = path.join(homeDir, `.${cli}`, `${cli}.json`);
      if (!fs.existsSync(cfgPath)) {
        continue;
      }
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const logFile = cfg?.logging?.file;
      if (logFile && typeof logFile === "string") {
        files.push(path.resolve(logFile));
      }
      break;
    } catch {
      // ignore
    }
  }
  return files;
}

/** Collect directories that may contain runtime logs across common install layouts. */
function collectCandidateLogDirs(): string[] {
  const homeDir = getHomeDir();
  const dirs = new Set<string>();

  const pushDir = (p?: string) => {
    if (!p) {
      return;
    }
    const normalized = path.resolve(p);
    dirs.add(normalized);
  };

  const pushStateDir = (stateDir?: string) => {
    if (!stateDir) {
      return;
    }
    pushDir(stateDir);
    pushDir(path.join(stateDir, "logs"));
  };

  for (const logFile of getConfiguredLogFiles()) {
    pushDir(path.dirname(logFile));
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) {
      continue;
    }
    if (/STATE_DIR$/i.test(key) && /(OPENCLAW|CLAWDBOT|MOLTBOT)/i.test(key)) {
      pushStateDir(value);
    }
  }

  for (const name of [".openclaw", ".clawdbot", ".moltbot", "openclaw", "clawdbot", "moltbot"]) {
    pushDir(path.join(homeDir, name));
    pushDir(path.join(homeDir, name, "logs"));
  }

  const searchRoots = new Set<string>([homeDir, process.cwd(), path.dirname(process.cwd())]);
  if (process.env.APPDATA) {
    searchRoots.add(process.env.APPDATA);
  }
  if (process.env.LOCALAPPDATA) {
    searchRoots.add(process.env.LOCALAPPDATA);
  }

  for (const root of searchRoots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (!/(openclaw|clawdbot|moltbot)/i.test(entry.name)) {
          continue;
        }
        const base = path.join(root, entry.name);
        pushDir(base);
        pushDir(path.join(base, "logs"));
      }
    } catch {
      // Ignore missing or inaccessible directories.
    }
  }

  // Common Linux log directories under /var/log.
  if (!isWindows()) {
    for (const name of ["openclaw", "clawdbot", "moltbot"]) {
      pushDir(path.join("/var/log", name));
    }
  }

  // Temporary directories may also contain gateway logs.
  const tmpRoots = new Set<string>();
  if (isWindows()) {
    // Windows temp locations.
    tmpRoots.add("C:\\tmp");
    if (process.env.TEMP) {
      tmpRoots.add(process.env.TEMP);
    }
    if (process.env.TMP) {
      tmpRoots.add(process.env.TMP);
    }
    if (process.env.LOCALAPPDATA) {
      tmpRoots.add(path.join(process.env.LOCALAPPDATA, "Temp"));
    }
  } else {
    tmpRoots.add("/tmp");
  }
  for (const tmpRoot of tmpRoots) {
    for (const name of ["openclaw", "clawdbot", "moltbot"]) {
      pushDir(path.join(tmpRoot, name));
    }
  }

  return Array.from(dirs);
}

type LogCandidate = {
  filePath: string;
  sourceDir: string;
  mtimeMs: number;
};

function collectRecentLogFiles(logDirs: string[]): LogCandidate[] {
  const candidates: LogCandidate[] = [];
  const dedupe = new Set<string>();

  const pushFile = (filePath: string, sourceDir: string) => {
    const normalized = path.resolve(filePath);
    if (dedupe.has(normalized)) {
      return;
    }
    try {
      const stat = fs.statSync(normalized);
      if (!stat.isFile()) {
        return;
      }
      dedupe.add(normalized);
      candidates.push({ filePath: normalized, sourceDir, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore missing or inaccessible files.
    }
  };

  // Highest priority: explicit logging.file paths from config.
  for (const logFile of getConfiguredLogFiles()) {
    pushFile(logFile, path.dirname(logFile));
  }

  for (const dir of logDirs) {
    pushFile(path.join(dir, "gateway.log"), dir);
    pushFile(path.join(dir, "gateway.err.log"), dir);
    pushFile(path.join(dir, "openclaw.log"), dir);
    pushFile(path.join(dir, "clawdbot.log"), dir);
    pushFile(path.join(dir, "moltbot.log"), dir);

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        if (!/\.(log|txt)$/i.test(entry.name)) {
          continue;
        }
        if (!/(gateway|openclaw|clawdbot|moltbot)/i.test(entry.name)) {
          continue;
        }
        pushFile(path.join(dir, entry.name), dir);
      }
    } catch {
      // Ignore missing or inaccessible directories.
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

/**
 * Read the last N lines of a file without loading the entire file into memory.
 * Uses a reverse-read strategy: reads fixed-size chunks from the end of the
 * file until the requested number of newline characters are found.
 *
 * Also estimates the total line count from the file size and the average bytes
 * per line observed in the tail portion (exact count is not feasible for
 * multi-GB files without a full scan).
 */
function tailFileLines(
  filePath: string,
  maxLines: number,
): { tail: string[]; totalFileLines: number } {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) {
      return { tail: [], totalFileLines: 0 };
    }

    const CHUNK_SIZE = 64 * 1024;
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let position = fileSize;
    let newlineCount = 0;

    while (position > 0 && newlineCount <= maxLines) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, position);
      chunks.unshift(buf);
      bytesRead += readSize;

      for (let i = 0; i < readSize; i++) {
        if (buf[i] === 0x0a) {
          newlineCount++;
        }
      }
    }

    const tailContent = Buffer.concat(chunks).toString("utf8");
    const allLines = tailContent.split("\n");

    const tail = allLines.slice(-maxLines);

    let totalFileLines: number;
    if (bytesRead >= fileSize) {
      totalFileLines = allLines.length;
    } else {
      const avgBytesPerLine = bytesRead / Math.max(allLines.length, 1);
      totalFileLines = Math.round(fileSize / avgBytesPerLine);
    }

    return { tail, totalFileLines };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Build the /bot-logs result: collect recent log files, write them to a temp
 * file, and return the summary text plus the temp file path.
 *
 * Authorization is enforced upstream by the framework (registerCommand with
 * requireAuth:true); this function contains no auth logic.
 *
 * Returns a SlashCommandFileResult on success (text + filePath), or a plain
 * string error message when no logs are found or files cannot be read.
 */
function buildBotLogsResult(): SlashCommandResult {
  const logDirs = collectCandidateLogDirs();
  const recentFiles = collectRecentLogFiles(logDirs).slice(0, 4);

  if (recentFiles.length === 0) {
    const existingDirs = logDirs.filter((d) => {
      try {
        return fs.existsSync(d);
      } catch {
        return false;
      }
    });
    const searched =
      existingDirs.length > 0
        ? existingDirs.map((d) => `  • ${d}`).join("\n")
        : logDirs
            .slice(0, 6)
            .map((d) => `  • ${d}`)
            .join("\n") + (logDirs.length > 6 ? `\n  …以及另外 ${logDirs.length - 6} 个路径` : "");
    return [
      `⚠️ 未找到日志文件`,
      ``,
      `已搜索以下${existingDirs.length > 0 ? "存在的" : ""}路径：`,
      searched,
      ``,
      `💡 如果日志存放在自定义路径，请在配置中添加：`,
      `  "logging": { "file": "/path/to/your/logfile.log" }`,
    ].join("\n");
  }

  const lines: string[] = [];
  let totalIncluded = 0;
  let totalOriginal = 0;
  let truncatedCount = 0;
  const MAX_LINES_PER_FILE = 1000;
  for (const logFile of recentFiles) {
    try {
      const { tail, totalFileLines } = tailFileLines(logFile.filePath, MAX_LINES_PER_FILE);
      if (tail.length > 0) {
        const fileName = path.basename(logFile.filePath);
        lines.push(
          `\n========== ${fileName} (last ${tail.length} of ${totalFileLines} lines) ==========`,
        );
        lines.push(`from: ${logFile.sourceDir}`);
        lines.push(...tail);
        totalIncluded += tail.length;
        totalOriginal += totalFileLines;
        if (totalFileLines > MAX_LINES_PER_FILE) {
          truncatedCount++;
        }
      }
    } catch {
      lines.push(`[Failed to read ${path.basename(logFile.filePath)}]`);
    }
  }

  if (lines.length === 0) {
    return `⚠️ 找到了日志文件，但无法读取。请检查文件权限。`;
  }

  const tmpDir = getQQBotDataDir("downloads");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tmpFile = path.join(tmpDir, `bot-logs-${timestamp}.txt`);
  fs.writeFileSync(tmpFile, lines.join("\n"), "utf8");

  const fileCount = recentFiles.length;
  const topSources = Array.from(new Set(recentFiles.map((item) => item.sourceDir))).slice(0, 3);
  let summaryText = `共 ${fileCount} 个日志文件，包含 ${totalIncluded} 行内容`;
  if (truncatedCount > 0) {
    summaryText += `（其中 ${truncatedCount} 个文件已截断为最后 ${MAX_LINES_PER_FILE} 行，总计原始 ${totalOriginal} 行）`;
  }
  return {
    text: `📋 ${summaryText}\n📂 来源：${topSources.join(" | ")}`,
    filePath: tmpFile,
  };
}

registerCommand({
  name: "bot-logs",
  description: "导出本地日志文件",
  requireAuth: true,
  usage: [
    `/bot-logs`,
    ``,
    `导出最近的 OpenClaw 日志文件（最多 4 个文件）。`,
    `每个文件只保留最后 1000 行，并作为附件返回。`,
  ].join("\n"),
  handler: (ctx) => {
    // Defense in depth: require an explicit QQ allowlist entry for log export.
    // This keeps `/bot-logs` closed when setup leaves allowFrom in permissive mode.
    if (!hasExplicitCommandAllowlist(ctx.accountConfig)) {
      return `⛔ 权限不足：请先在 channels.qqbot.allowFrom（或对应账号 allowFrom）中配置明确的发送者列表后再使用 /bot-logs。`;
    }
    return buildBotLogsResult();
  },
});

// Slash command entry point.

/**
 * Try to match and execute a plugin-level slash command.
 *
 * @returns A reply when matched, or null when the message should continue through normal routing.
 */
export async function matchSlashCommand(ctx: SlashCommandContext): Promise<SlashCommandResult> {
  const content = ctx.rawContent.trim();
  if (!content.startsWith("/")) {
    return null;
  }

  // Parse the command name and trailing arguments.
  const spaceIdx = content.indexOf(" ");
  const cmdName = normalizeLowercaseStringOrEmpty(
    spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx),
  );
  const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

  const cmd = commands.get(cmdName);
  if (!cmd) {
    return null;
  }

  // Gate sensitive commands behind the allowFrom authorization check.
  if (cmd.requireAuth && !ctx.commandAuthorized) {
    debugLog(
      `[qqbot] Slash command /${cmd.name} rejected: sender ${ctx.senderId} is not authorized`,
    );
    return `⛔ 权限不足：/${cmd.name} 需要管理员权限。`;
  }

  // `/command ?` returns usage help.
  if (args === "?") {
    if (cmd.usage) {
      return `📖 /${cmd.name} 用法：\n\n${cmd.usage}`;
    }
    return `/${cmd.name} - ${cmd.description}`;
  }

  ctx.args = args;
  const result = await cmd.handler(ctx);
  return result;
}

/** Return the plugin version for external callers. */
export function getPluginVersion(): string {
  return PLUGIN_VERSION;
}
