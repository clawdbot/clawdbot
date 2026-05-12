import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { collectCodexNativeAssetWarnings, scanCodexNativeAssets } from "./codex-native-assets.js";

const tempRoots = new Set<string>();

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-codex-assets-"));
  tempRoots.add(root);
  return root;
}

async function writeFile(filePath: string, content = ""): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function codexConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {
        codex: { enabled: true },
      },
    },
    agents: {
      defaults: {
        agentRuntime: {
          id: "codex",
        },
      },
    },
  } as OpenClawConfig;
}

function hasAsset(hits: Array<{ kind: string; path: string }>, kind: string, assetPath: string) {
  return hits.some((hit) => hit.kind === kind && hit.path === assetPath);
}

afterEach(async () => {
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("scanCodexNativeAssets", () => {
  it("finds personal Codex CLI assets that isolated agents will not load implicitly", async () => {
    const root = await makeTempRoot();
    const codexHome = path.join(root, ".codex");
    await writeFile(path.join(codexHome, "skills", "tweet-helper", "SKILL.md"));
    await writeFile(path.join(root, ".agents", "skills", "agent-helper", "SKILL.md"));
    await writeFile(path.join(codexHome, "skills", ".system", "system-skill", "SKILL.md"));
    await writeFile(
      path.join(
        codexHome,
        "plugins",
        "cache",
        "openai-primary-runtime",
        "documents",
        "1.0.0",
        ".codex-plugin",
        "plugin.json",
      ),
      "{}",
    );
    await writeFile(path.join(codexHome, "config.toml"));
    await writeFile(path.join(codexHome, "hooks", "hooks.json"));

    const hits = await scanCodexNativeAssets({
      cfg: codexConfig(),
      env: { CODEX_HOME: codexHome, HOME: root },
    });

    expect(hasAsset(hits, "skill", path.join(codexHome, "skills", "tweet-helper"))).toBe(true);
    expect(hasAsset(hits, "skill", path.join(root, ".agents", "skills", "agent-helper"))).toBe(
      true,
    );
    expect(
      hasAsset(
        hits,
        "plugin",
        path.join(codexHome, "plugins", "cache", "openai-primary-runtime", "documents", "1.0.0"),
      ),
    ).toBe(true);
    expect(hasAsset(hits, "config", path.join(codexHome, "config.toml"))).toBe(true);
    expect(hasAsset(hits, "hooks", path.join(codexHome, "hooks", "hooks.json"))).toBe(true);
    expect(hasAsset(hits, "skill", path.join(codexHome, "skills", ".system", "system-skill"))).toBe(
      false,
    );
  });

  it("does not scan when Codex is not configured", async () => {
    const root = await makeTempRoot();
    const codexHome = path.join(root, ".codex");
    await writeFile(path.join(codexHome, "skills", "tweet-helper", "SKILL.md"));
    await writeFile(path.join(root, ".agents", "skills", "agent-helper", "SKILL.md"));

    await expect(
      scanCodexNativeAssets({
        cfg: {} as OpenClawConfig,
        env: { CODEX_HOME: codexHome, HOME: root },
      }),
    ).resolves.toStrictEqual([]);
  });
});

describe("collectCodexNativeAssetWarnings", () => {
  it("points users at explicit Codex migration instead of auto-copying native assets", async () => {
    const root = await makeTempRoot();
    const codexHome = path.join(root, ".codex");
    await writeFile(path.join(root, ".agents", "skills", "agent-helper", "SKILL.md"));

    const warnings = await collectCodexNativeAssetWarnings({
      cfg: codexConfig(),
      env: { CODEX_HOME: codexHome, HOME: root },
    });

    expect(warnings).toStrictEqual([
      [
        "- Personal Codex CLI assets were found, but native Codex-mode OpenClaw agents use isolated per-agent Codex homes.",
        `- Sources: ${codexHome} and ${path.join(root, ".agents", "skills")} (1 skill, 0 plugins, 0 config files, 0 hook files).`,
        "- These assets will not be loaded by the Codex app-server child unless you intentionally promote them.",
        "- Run `openclaw migrate codex --dry-run` to inventory them. Applying that migration copies skills into the current OpenClaw agent workspace; Codex plugins, hooks, and config stay manual-review only.",
      ].join("\n"),
    ]);
  });
});
