import fs from "node:fs";
import path from "node:path";
import { getHomeDir } from "../../utils/platform.js";
import type { SlashCommandRegistry } from "../slash-commands.js";

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

const CLEAR_STORAGE_MAX_DISPLAY = 10;

/**
 * Resolve the canonical downloads directory for an appId under the user's home.
 * Must stay strictly under ~/.openclaw/media/qqbot/downloads/.
 */
export function resolveQqbotDownloadsDirForApp(appId: string): string {
  const id = appId.trim();
  if (!id || id.includes("\0") || /[/\\\n]|\.\./.test(id)) {
    throw new Error("invalid appId path");
  }
  const base = path.join(getHomeDir(), ".openclaw", "media", "qqbot", "downloads");
  const resolvedBase = path.resolve(base);
  const target = path.resolve(path.join(resolvedBase, id));
  if (target === resolvedBase || !target.startsWith(resolvedBase + path.sep)) {
    throw new Error("invalid appId path");
  }
  return target;
}

export function registerClearStorageCommands(registry: SlashCommandRegistry): void {
  registry.register({
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
      let targetDir: string;
      try {
        targetDir = resolveQqbotDownloadsDirForApp(appId);
      } catch {
        return `❌ 无效的机器人标识，无法解析清理目录。`;
      }
      const displayDir = `~/.openclaw/media/qqbot/downloads/${appId}`;

      if (!isForce) {
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
}
