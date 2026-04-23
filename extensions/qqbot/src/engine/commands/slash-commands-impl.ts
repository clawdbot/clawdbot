/**
 * QQBot plugin-level slash command handler.
 *
 * Type definitions and the command registry/dispatcher are in
 * core/gateway/slash-commands.ts. This file contains the concrete
 * built-in command implementations that depend on framework SDK.
 */

import fs from "node:fs";
import path from "node:path";
import { debugLog } from "../utils/log.js";
import { getHomeDir, getQQBotDataDir, isWindows } from "../utils/platform.js";
import {
  SlashCommandRegistry,
  type SlashCommandContext,
  type SlashCommandResult,
  type SlashCommandFileResult,
  type QQBotFrameworkCommand,
  type QueueSnapshot,
} from "./slash-commands.js";

// ---- Injected dependency ----

/** Resolve the framework runtime version — injected to avoid plugin-sdk dependency. */
let _resolveVersion: (() => string) | null = null;

/** Register the version resolver — called by the outer layer. */
export function registerVersionResolver(fn: () => string): void {
  _resolveVersion = fn;
}

function resolveRuntimeServiceVersion(): string {
  return _resolveVersion?.() ?? "unknown";
}

// Re-export core types for backward compatibility.
export type {
  SlashCommandContext,
  SlashCommandResult,
  SlashCommandFileResult,
  QQBotFrameworkCommand,
  QueueSnapshot,
} from "./slash-commands.js";

// Plugin version — injected by the outer layer via registerPluginVersion().
let PLUGIN_VERSION = "unknown";

/** Register the plugin version — called by the outer layer. */
export function registerPluginVersion(version: string): void {
  if (version) {
    PLUGIN_VERSION = version;
  }
}

const QQBOT_PLUGIN_GITHUB_URL = "https://github.com/openclaw/openclaw/tree/main/extensions/qqbot";
const QQBOT_UPGRADE_GUIDE_URL = "https://q.qq.com/qqbot/openclaw/upgrade.html";

// ============ Module-level registry instance ============

const registry = new SlashCommandRegistry();

function registerCommand(cmd: {
  name: string;
  description: string;
  usage?: string;
  requireAuth?: boolean;
  handler: (ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>;
}): void {
  registry.register(cmd);
}

/**
 * Return all commands that require authorization, for registration with the
 * framework via api.registerCommand() in registerFull().
 */
export function getFrameworkCommands(): QQBotFrameworkCommand[] {
  return registry.getFrameworkCommands();
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
    if (Number.isNaN(eventTime)) {
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
 * /bot-version — show both the QQBot plugin version and the OpenClaw
 * framework version. Aligned with the standalone `openclaw-qqbot`
 * build so users see the same identification regardless of which
 * distribution they run.
 *
 * Note: unlike the standalone build, the built-in plugin is released
 * in-tree with the OpenClaw framework (same version), so an online
 * npm dist-tag check is not applicable here and is intentionally
 * omitted.
 */
registerCommand({
  name: "bot-version",
  description: "查看 QQBot 插件版本和 OpenClaw 框架版本",
  usage: [`/bot-version`, ``, `查看当前 QQBot 插件版本和 OpenClaw 框架版本。`].join("\n"),
  handler: async () => {
    const frameworkVersion = resolveRuntimeServiceVersion();
    const lines = [
      `🦞 OpenClaw 框架版本：${frameworkVersion}`,
      `🤖 QQBot 插件版本：v${PLUGIN_VERSION}`,
      `🌟 官方 GitHub 仓库：[点击前往](${QQBOT_PLUGIN_GITHUB_URL})`,
    ];
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
  handler: (ctx) => {
    // Exclude c2c-only commands from group listings.
    const GROUP_EXCLUDED = new Set(["bot-upgrade", "bot-clear-storage"]);
    const isGroup = ctx.type === "group";

    const lines = [`### QQBot 内置命令`, ``];
    for (const [name, cmd] of registry.getAllCommands()) {
      if (isGroup && GROUP_EXCLUDED.has(name)) {
        continue;
      }
      lines.push(`<qqbot-cmd-input text="/${name}" show="/${name}"/> ${cmd.description}`);
    }
    lines.push(``, `> 插件版本 v${PLUGIN_VERSION}`);
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

// ============ /bot-clear-storage ============

/** Recursively scan all files under a directory, sorted by size descending. */
function scanDirectoryFiles(dirPath: string): { filePath: string; size: number }[] {
  const files: { filePath: string; size: number }[] = [];
  if (!fs.existsSync(dirPath)) {
    return files;
  }
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          files.push({ filePath: fullPath, size: stat.size });
        } catch {
          // Skip inaccessible files.
        }
      }
    }
  };
  walk(dirPath);
  files.sort((a, b) => b.size - a.size);
  return files;
}

/** Format byte count into a human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Recursively remove empty directories (leaf-to-root). */
function removeEmptyDirs(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      removeEmptyDirs(path.join(dirPath, entry.name));
    }
  }
  try {
    const remaining = fs.readdirSync(dirPath);
    if (remaining.length === 0) {
      fs.rmdirSync(dirPath);
    }
  } catch {
    // Directory may be in use, skip.
  }
}

/** Maximum number of files to display in the scan preview. */
const CLEAR_STORAGE_MAX_DISPLAY = 10;

registerCommand({
  name: "bot-clear-storage",
  description: "清理通过 QQBot 对话产生的下载文件，释放主机磁盘空间",
  usage: [
    `/bot-clear-storage`,
    ``,
    `扫描当前机器人产生的下载文件并列出明细。`,
    `确认后执行删除，释放主机磁盘空间。`,
    ``,
    `/bot-clear-storage --force   确认执行清理`,
    ``,
    `⚠️ 仅在私聊中可用。`,
  ].join("\n"),
  handler: (ctx) => {
    const { appId, type } = ctx;

    if (type !== "c2c") {
      return `💡 请在私聊中使用此指令`;
    }

    const isForce = ctx.args.trim() === "--force";
    const targetDir = path.join(getHomeDir(), ".openclaw", "media", "qqbot", "downloads", appId);
    const displayDir = `~/.openclaw/media/qqbot/downloads/${appId}`;

    if (!isForce) {
      // Step 1: scan and display file list with a confirmation button.
      const files = scanDirectoryFiles(targetDir);

      if (files.length === 0) {
        return [`✅ 当前没有需要清理的文件`, ``, `目录 \`${displayDir}\` 为空或不存在。`].join(
          "\n",
        );
      }

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      const lines: string[] = [
        `即将清理 \`${displayDir}\` 目录下所有文件，总共 ${files.length} 个文件，占用磁盘存储空间 ${formatBytes(totalSize)}。`,
        ``,
        `目录文件概况：`,
      ];

      const displayFiles = files.slice(0, CLEAR_STORAGE_MAX_DISPLAY);
      for (const f of displayFiles) {
        const relativePath = path.relative(targetDir, f.filePath).replace(/\\/g, "/");
        lines.push(`${relativePath} (${formatBytes(f.size)})`, ``, ``);
      }
      if (files.length > CLEAR_STORAGE_MAX_DISPLAY) {
        lines.push(`...[合计：${files.length} 个文件（${formatBytes(totalSize)}）]`, ``);
      }

      lines.push(
        ``,
        `---`,
        ``,
        `确认清理后，上述保存在 OpenClaw 运行主机磁盘上的文件将永久删除，后续对话过程中 AI 无法再找回相关文件。`,
        `‼️ 点击指令确认删除`,
        `<qqbot-cmd-enter text="/bot-clear-storage --force" />`,
      );

      return lines.join("\n");
    }

    // Step 2: --force — execute deletion.
    const files = scanDirectoryFiles(targetDir);

    if (files.length === 0) {
      return `✅ 目录已为空，无需清理`;
    }

    let deletedCount = 0;
    let deletedSize = 0;
    let failedCount = 0;

    for (const f of files) {
      try {
        fs.unlinkSync(f.filePath);
        deletedCount++;
        deletedSize += f.size;
      } catch {
        failedCount++;
      }
    }

    try {
      removeEmptyDirs(targetDir);
    } catch {
      // Non-critical, silently ignore.
    }

    if (failedCount === 0) {
      return [
        `✅ 清理成功`,
        ``,
        `已删除 ${deletedCount} 个文件，释放 ${formatBytes(deletedSize)} 磁盘空间。`,
      ].join("\n");
    }

    return [
      `⚠️ 部分清理完成`,
      ``,
      `已删除 ${deletedCount} 个文件（${formatBytes(deletedSize)}），${failedCount} 个文件删除失败。`,
    ].join("\n");
  },
});

// ============ /bot-approve 审批配置管理 ============

/** Injected runtime getter — set by the outer bootstrap layer. */
let _runtimeGetter:
  | (() => {
      config: {
        loadConfig: () => Record<string, unknown>;
        writeConfigFile: (cfg: unknown) => Promise<void>;
      };
    })
  | null = null;

/** Register the runtime getter — called by the outer layer during startup. */
export function registerApproveRuntimeGetter(
  getter: () => {
    config: {
      loadConfig: () => Record<string, unknown>;
      writeConfigFile: (cfg: unknown) => Promise<void>;
    };
  },
): void {
  _runtimeGetter = getter;
}

/**
 * /bot-approve — 管理命令执行审批配置
 *
 * 修改 openclaw.json 中 tools.exec.security / tools.exec.ask 字段。
 *
 * security: deny | allowlist | full
 * ask: off | on-miss | always
 */
registerCommand({
  name: "bot-approve",
  description: "管理命令执行审批配置",
  usage: [
    `/bot-approve            查看操作指引`,
    `/bot-approve on         开启审批（白名单模式，推荐）`,
    `/bot-approve off        关闭审批，命令直接执行`,
    `/bot-approve always     始终审批，每次执行都需审批`,
    `/bot-approve reset      恢复框架默认值`,
    `/bot-approve status     查看当前审批配置`,
  ].join("\n"),
  handler: async (ctx) => {
    const arg = ctx.args.trim().toLowerCase();

    let runtime: ReturnType<NonNullable<typeof _runtimeGetter>>;
    try {
      if (!_runtimeGetter) {
        throw new Error("runtime not available");
      }
      runtime = _runtimeGetter();
    } catch {
      // runtime 不可用时返回操作指引
      return [
        `🔐 命令执行审批配置`,
        ``,
        `❌ 当前环境不支持在线配置修改，请通过 CLI 手动配置：`,
        ``,
        `\`\`\`shell`,
        `# 开启审批（白名单模式）`,
        `openclaw config set tools.exec.security allowlist`,
        `openclaw config set tools.exec.ask on-miss`,
        ``,
        `# 关闭审批`,
        `openclaw config set tools.exec.security full`,
        `openclaw config set tools.exec.ask off`,
        `\`\`\``,
      ].join("\n");
    }

    const configApi = runtime.config;

    const loadExecConfig = () => {
      const cfg = configApi.loadConfig();
      const tools = (cfg.tools ?? {}) as Record<string, unknown>;
      const exec = (tools.exec ?? {}) as Record<string, unknown>;
      const security = typeof exec.security === "string" ? exec.security : "deny";
      const ask = typeof exec.ask === "string" ? exec.ask : "on-miss";
      return { security, ask };
    };

    const writeExecConfig = async (security: string, ask: string) => {
      const cfg = structuredClone(configApi.loadConfig());
      const tools = (cfg.tools ?? {}) as Record<string, unknown>;
      const exec = (tools.exec ?? {}) as Record<string, unknown>;
      exec.security = security;
      exec.ask = ask;
      tools.exec = exec;
      cfg.tools = tools;
      await configApi.writeConfigFile(cfg);
    };

    const formatStatus = (security: string, ask: string) => {
      const secIcon = security === "full" ? "🟢" : security === "allowlist" ? "🟡" : "🔴";
      const askIcon = ask === "off" ? "🟢" : ask === "always" ? "🔴" : "🟡";
      return [
        `🔐 当前审批配置`,
        ``,
        `${secIcon} 安全模式 (security): **${security}**`,
        `${askIcon} 审批模式 (ask): **${ask}**`,
        ``,
        security === "deny"
          ? `⚠️ 当前为 deny 模式，所有命令执行被拒绝`
          : security === "full" && ask === "off"
            ? `✅ 所有命令无需审批直接执行`
            : security === "allowlist" && ask === "on-miss"
              ? `🛡️ 白名单命令直接执行，其余需审批`
              : ask === "always"
                ? `🔒 每次命令执行都需要人工审批`
                : `ℹ️ security=${security}, ask=${ask}`,
      ].join("\n");
    };

    // 无参数：操作指引
    if (!arg) {
      return [
        `🔐 命令执行审批配置`,
        ``,
        `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批（白名单模式）`,
        `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
        `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
        `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
        `<qqbot-cmd-input text="/bot-approve status" show="/bot-approve status"/> 查看当前配置`,
      ].join("\n");
    }

    // status: 查看当前配置
    if (arg === "status") {
      const { security, ask } = loadExecConfig();
      return [
        formatStatus(security, ask),
        ``,
        `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批`,
        `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
        `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
        `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
      ].join("\n");
    }

    // on: 开启审批（白名单 + 未命中审批）
    if (arg === "on") {
      try {
        await writeExecConfig("allowlist", "on-miss");
        return [
          `✅ 审批已开启`,
          ``,
          `• security = allowlist（白名单模式）`,
          `• ask = on-miss（未命中白名单时需审批）`,
          ``,
          `已批准的命令自动加入白名单，下次直接执行。`,
        ].join("\n");
      } catch (err: unknown) {
        return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // off: 关闭审批
    if (arg === "off") {
      try {
        await writeExecConfig("full", "off");
        return [
          `✅ 审批已关闭`,
          ``,
          `• security = full（允许所有命令）`,
          `• ask = off（不需要审批）`,
          ``,
          `⚠️ 所有命令将直接执行，不会弹出审批确认。`,
        ].join("\n");
      } catch (err: unknown) {
        return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // always: 始终审批
    if (arg === "always" || arg === "strict") {
      try {
        await writeExecConfig("allowlist", "always");
        return [
          `✅ 已切换为严格审批模式`,
          ``,
          `• security = allowlist`,
          `• ask = always（每次执行都需审批）`,
          ``,
          `每个命令都会弹出审批按钮，需手动确认。`,
        ].join("\n");
      } catch (err: unknown) {
        return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // reset: 删除配置，恢复框架默认值
    if (arg === "reset") {
      try {
        const cfg = structuredClone(configApi.loadConfig());
        const tools = (cfg.tools ?? {}) as Record<string, unknown>;
        const exec = (tools.exec ?? {}) as Record<string, unknown>;
        delete exec.security;
        delete exec.ask;
        if (Object.keys(exec).length === 0) {
          delete tools.exec;
        } else {
          tools.exec = exec;
        }
        if (Object.keys(tools).length === 0) {
          delete cfg.tools;
        } else {
          cfg.tools = tools;
        }
        await configApi.writeConfigFile(cfg);
        return [
          `✅ 审批配置已重置`,
          ``,
          `已移除 tools.exec.security 和 tools.exec.ask`,
          `框架将使用默认值（security=deny, ask=on-miss）`,
          ``,
          `如需开启命令执行，请使用 /bot-approve on`,
        ].join("\n");
      } catch (err: unknown) {
        return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return [
      `❌ 未知参数: ${arg}`,
      ``,
      `可用选项: on | off | always | reset | status`,
      `输入 /bot-approve ? 查看详细用法`,
    ].join("\n");
  },
});

// Slash command entry point — delegates to core/ registry.

/**
 * Try to match and execute a plugin-level slash command.
 *
 * @returns A reply when matched, or null when the message should continue through normal routing.
 */
export async function matchSlashCommand(ctx: SlashCommandContext): Promise<SlashCommandResult> {
  return registry.matchSlashCommand(ctx, { info: debugLog });
}

/** Return the plugin version for external callers. */
export function getPluginVersion(): string {
  return PLUGIN_VERSION;
}

// Utility used by /bot-logs command.
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

function hasExplicitCommandAllowlist(accountConfig?: Record<string, unknown>): boolean {
  const allowFrom = accountConfig?.allowFrom;
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) {
    return false;
  }
  return allowFrom.every((entry) => {
    const normalized = normalizeCommandAllowlistEntry(entry);
    return normalized.length > 0 && normalized !== "*";
  });
}
