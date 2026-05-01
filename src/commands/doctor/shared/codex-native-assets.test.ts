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

    expect(hits).toEqual(
      expect.arrayContaining([
        { kind: "skill", path: path.join(codexHome, "skills", "tweet-helper") },
        { kind: "skill", path: path.join(root, ".agents", "skills", "agent-helper") },
        {
          kind: "plugin",
          path: path.join(
            codexHome,
            "plugins",
            "cache",
            "openai-primary-runtime",
            "documents",
            "1.0.0",
          ),
        },
        { kind: "config", path: path.join(codexHome, "config.toml") },
        { kind: "hooks", path: path.join(codexHome, "hooks", "hooks.json") },
      ]),
    );
    expect(hits).not.toEqual(
      expect.arrayContaining([
        { kind: "skill", path: path.join(codexHome, "skills", ".system", "system-skill") },
      ]),
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
    ).resolves.toEqual([]);
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

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("isolated per-agent Codex homes");
    expect(warnings[0]).toContain(codexHome);
    expect(warnings[0]).toContain(path.join(root, ".agents", "skills"));
    expect(warnings[0]).toContain("openclaw migrate codex --dry-run");
    expect(warnings[0]).toContain("manual-review only");
  });
});
