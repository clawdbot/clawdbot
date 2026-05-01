import fs from "node:fs";
import path from "node:path";
import { getHomeDir, getQQBotDataDir, isWindows } from "../../utils/platform.js";
import type { SlashCommandResult } from "../slash-commands.js";

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

  if (!isWindows()) {
    for (const name of ["openclaw", "clawdbot", "moltbot"]) {
      pushDir(path.join("/var/log", name));
    }
  }

  const tmpRoots = new Set<string>();
  if (isWindows()) {
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
 * Build the /bot-logs result: collect recent log files, write them to a temp file.
 */
export function buildBotLogsResult(): SlashCommandResult {
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
