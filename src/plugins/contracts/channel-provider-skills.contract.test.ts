import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildWorkspaceSkillStatus } from "../../skills/discovery/status.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
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
  it.each<{
    label: string;
    pluginId: "discord" | "slack";
    config: OpenClawConfig;
    eligible: boolean;
    disabled?: boolean;
  }>([
    {
      label: "exposes Discord with only a named-account token",
      pluginId: "discord",
      config: {
        channels: { discord: { accounts: { support: { token: "test-discord-token" } } } },
      },
      eligible: true,
    },
    {
      label: "exposes Discord with a root token",
      pluginId: "discord",
      config: { channels: { discord: { token: "test-discord-token" } } },
      eligible: true,
    },
    {
      label: "hides Discord without channel configuration",
      pluginId: "discord",
      config: {},
      eligible: false,
    },
    {
      label: "honors explicit Discord skill disablement",
      pluginId: "discord",
      config: {
        channels: { discord: { token: "test-discord-token" } },
        skills: { entries: { discord: { enabled: false } } },
      },
      eligible: false,
      disabled: true,
    },
    {
      label: "exposes Slack with only named-account credentials",
      pluginId: "slack",
      config: {
        channels: {
          slack: {
            accounts: { support: { botToken: "xoxb-test-token", appToken: "xapp-test-token" } },
          },
        },
      },
      eligible: true,
    },
  ])("$label", ({ pluginId, config, eligible, disabled = false }) => {
    const workspaceDir = resolve(process.cwd(), "extensions", pluginId);
    // Load the shipped asset without discovering operator skills or activating plugin runtimes.
    const entries = loadWorkspaceSkills(workspaceDir, { config, workspaceOnly: true });
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config,
      entries,
      managedSkillsDir: resolve(workspaceDir, "skills"),
    });
    expect(report.skills.find((skill) => skill.name === pluginId)).toMatchObject({
      eligible,
      disabled,
      modelVisible: eligible,
    });

    const snapshot = buildSkillSnapshot(workspaceDir, { config, entries });
    expect(snapshot.prompt.includes(`<name>${pluginId}</name>`)).toBe(eligible);
  });

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
