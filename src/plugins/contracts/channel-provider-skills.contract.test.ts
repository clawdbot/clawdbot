import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

type PluginManifest = {
  channels?: unknown;
  skills?: unknown;
};

const RETIRED_SKILL_PATTERNS = [
  {
    pattern: /use\s+the\s+[`'"]slack[`'"]\s+tool/iu,
    replacement: "the `message` tool",
  },
  {
    pattern:
      /["']action["']\s*:\s*["'](?:sendMessage|readMessages|editMessage|deleteMessage|pinMessage|unpinMessage|listPins|memberInfo|emojiList)["']/u,
    replacement: "a canonical `message` action",
  },
  { pattern: /owner_open_id/u, replacement: "grant_to_requester" },
  { pattern: /feishu_doc_list_blocks/u, replacement: "feishu_doc action=list_blocks" },
  { pattern: /feishu_doc_update_block/u, replacement: "feishu_doc action=update_block" },
  { pattern: /feishu_doc_delete_block/u, replacement: "feishu_doc action=delete_block" },
  {
    pattern: /["']components["']\s*:\s*["']\[Carbon v2 components\]["']/u,
    replacement: "structured components",
  },
  { pattern: /## 备用方案（直接使用 `cron` 工具）/u, replacement: "qqbot_remind only" },
  {
    pattern: /github\.com\/steipete\/wacli\/cmd\/wacli@latest/u,
    replacement: "github.com/openclaw/wacli/cmd/wacli@latest",
  },
] as const;

function listRepositoryOwnedChannelSkillFiles(): string[] {
  const trackedFiles = listGitTrackedFiles({ pathspecs: ["extensions"] }) ?? [];
  const trackedFileSet = new Set(trackedFiles);
  const skillFiles = new Set<string>();

  for (const manifestPath of trackedFiles.filter((file) =>
    /^extensions\/[^/]+\/openclaw\.plugin\.json$/u.test(file),
  )) {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), manifestPath), "utf8"),
    ) as PluginManifest;
    if (!Array.isArray(manifest.channels) || !Array.isArray(manifest.skills)) {
      continue;
    }

    const pluginDir = dirname(manifestPath);
    for (const skillRoot of manifest.skills) {
      if (typeof skillRoot !== "string" || skillRoot.includes("node_modules")) {
        continue;
      }
      const relativeRoot = relative(process.cwd(), resolve(pluginDir, skillRoot)).replaceAll(
        "\\",
        "/",
      );
      for (const file of trackedFileSet) {
        if (file.startsWith(`${relativeRoot}/`) && file.endsWith(".md")) {
          skillFiles.add(file);
        }
      }
    }
  }

  return [...skillFiles].toSorted();
}

describe("bundled channel-provider skill contracts", () => {
  it("does not teach retired tool, action, parameter, or install contracts", () => {
    const failures: string[] = [];
    const skillFiles = listRepositoryOwnedChannelSkillFiles();

    expect(skillFiles.length).toBeGreaterThan(0);
    for (const file of skillFiles) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      for (const entry of RETIRED_SKILL_PATTERNS) {
        if (entry.pattern.test(source)) {
          failures.push(`${file}: replace ${entry.pattern.source} with ${entry.replacement}`);
        }
      }
    }

    expect(failures).toStrictEqual([]);
  });
});
