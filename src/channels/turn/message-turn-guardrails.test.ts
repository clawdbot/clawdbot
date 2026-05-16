import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const migratedMessageTurnFiles = [
  "extensions/discord/src/monitor/message-handler.context.ts",
  "extensions/discord/src/monitor/message-handler.preflight.ts",
  "extensions/feishu/src/bot.ts",
  "extensions/imessage/src/monitor/inbound-processing.ts",
  "extensions/line/src/bot-handlers.ts",
  "extensions/line/src/bot-message-context.ts",
  "extensions/mattermost/src/mattermost/monitor.ts",
  "extensions/msteams/src/monitor-handler/message-handler.ts",
  "extensions/signal/src/monitor/event-handler.ts",
  "extensions/slack/src/monitor/message-handler/prepare.ts",
  "extensions/telegram/src/bot-message-context.body.ts",
  "extensions/telegram/src/bot-message-context.session.ts",
  "extensions/telegram/src/bot-message-dispatch.ts",
  "extensions/whatsapp/src/auto-reply/monitor/group-gating.ts",
  "extensions/zalouser/src/monitor.ts",
];

const historyWindowFiles = [
  "extensions/discord/src/monitor/message-handler.context.ts",
  "extensions/feishu/src/bot.ts",
  "extensions/imessage/src/monitor/inbound-processing.ts",
  "extensions/line/src/bot-handlers.ts",
  "extensions/line/src/bot-message-context.ts",
  "extensions/mattermost/src/mattermost/monitor.ts",
  "extensions/msteams/src/monitor-handler/message-handler.ts",
  "extensions/qqbot/src/bridge/sdk-adapter.ts",
  "extensions/signal/src/monitor/event-handler.ts",
  "extensions/slack/src/monitor/message-handler/prepare.ts",
  "extensions/telegram/src/bot-message-context.body.ts",
  "extensions/telegram/src/bot-message-context.session.ts",
  "extensions/telegram/src/bot-message-dispatch.ts",
  "extensions/whatsapp/src/auto-reply/monitor/group-gating.ts",
  "extensions/zalouser/src/monitor.ts",
];

const lowLevelHistoryHelpers = [
  "buildInboundHistoryFromMap",
  "buildHistoryContextFromMap",
  "buildPendingHistoryContextFromMap",
  "clearHistoryEntries",
  "clearHistoryEntriesIfEnabled",
  "recordPendingHistoryEntry",
  "recordPendingHistoryEntryIfEnabled",
  "recordPendingHistoryEntryWithMedia",
];

const legacyReplyHistoryCompatibilityFiles = new Set([
  "extensions/mattermost/runtime-api.ts",
  "extensions/mattermost/src/mattermost/runtime-api.ts",
  "extensions/mattermost/src/runtime-api.ts",
]);

const skippedExtensionScanDirs = new Set([
  ".cache",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
]);

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, ...relativePath.split("/")), "utf8");
}

function isScannableTsFile(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return (
    !parts.some((part) => skippedExtensionScanDirs.has(part)) &&
    relativePath.endsWith(".ts") &&
    !relativePath.endsWith(".d.ts")
  );
}

function listGitTsFiles(relativeDir: string): string[] | null {
  const result = spawnSync("git", ["ls-files", "--", relativeDir], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter((line) => line.length > 0 && isScannableTsFile(line))
    .toSorted();
}

function listTsFiles(relativeDir: string): string[] {
  const gitFiles = listGitTsFiles(relativeDir);
  if (gitFiles) {
    return gitFiles;
  }

  const dir = path.join(repoRoot, ...relativeDir.split("/"));
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (skippedExtensionScanDirs.has(entry.name)) {
        return [];
      }
      return listTsFiles(relativePath);
    }
    if (!entry.isFile() || !isScannableTsFile(relativePath)) {
      return [];
    }
    return [relativePath];
  });
}

function collectReplyHistoryBindings(source: string): Set<string> {
  const bindings = new Set<string>();
  const importOrExportPattern =
    /\b(?:import|export)\s*\{([\s\S]*?)\}\s*from\s*["']openclaw\/plugin-sdk\/reply-history["']/g;
  for (const match of source.matchAll(importOrExportPattern)) {
    const block = match[1] ?? "";
    for (const nameMatch of block.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      bindings.add(nameMatch[0]);
    }
  }
  return bindings;
}

describe("message turn migration guardrails", () => {
  it("lists plugin TypeScript files from git without walking extension roots", () => {
    const readDir = vi.spyOn(fs, "readdirSync");
    try {
      const files = listTsFiles("extensions");

      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => file.startsWith("extensions/"))).toBe(true);
      expect(files.some((file) => file.endsWith(".d.ts"))).toBe(false);
      expect(readDir).not.toHaveBeenCalled();
    } finally {
      readDir.mockRestore();
    }
  });

  it("keeps migrated message paths off low-level reply-history helpers", () => {
    for (const file of migratedMessageTurnFiles) {
      const source = readRepoFile(file);
      for (const helper of lowLevelHistoryHelpers) {
        expect(source, `${file} should use the channel history window, not ${helper}`).not.toMatch(
          new RegExp(`\\b${helper}\\b`),
        );
      }
    }
  });

  it("keeps migrated history users on the channel history window facade", () => {
    for (const file of historyWindowFiles) {
      expect(readRepoFile(file), `${file} should keep using createChannelHistoryWindow`).toContain(
        "createChannelHistoryWindow",
      );
    }
  });

  it("keeps plugin runtime files off deprecated reply-history map helpers", () => {
    for (const file of listTsFiles("extensions")) {
      if (file.includes(".test.") || file.endsWith(".test.ts")) {
        continue;
      }
      if (legacyReplyHistoryCompatibilityFiles.has(file)) {
        continue;
      }
      const source = readRepoFile(file);
      const replyHistoryBindings = collectReplyHistoryBindings(source);
      for (const helper of lowLevelHistoryHelpers) {
        expect(
          replyHistoryBindings.has(helper),
          `${file} should use createChannelHistoryWindow instead of ${helper}`,
        ).toBe(false);
      }
    }
  });
});
