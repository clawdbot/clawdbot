import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectDiscordLegacyStateMigrations } from "./model-picker-preferences-migrations.js";

const tempDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-model-picker-migration-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Discord model picker preference migration", () => {
  it("plans legacy JSON import into plugin state", async () => {
    const stateDir = await makeStateDir();
    const sourcePath = path.join(stateDir, "discord", "model-picker-preferences.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        entries: {
          "discord:default:dm:user:123": {
            recent: ["OpenAI/gpt-5", "bad", "openai/gpt-5"],
            updatedAt: "2026-05-29T00:00:00.000Z",
          },
        },
      }),
    );

    const plans = await Promise.resolve(
      detectDiscordLegacyStateMigrations({
        cfg: {},
        env: {},
        oauthDir: path.join(stateDir, "credentials"),
        stateDir,
      }),
    );

    if (!plans) {
      throw new Error("expected migration plans");
    }
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan?.kind).toBe("plugin-state-import");
    if (plan?.kind !== "plugin-state-import") {
      throw new Error("expected plugin-state import plan");
    }
    expect(plan.pluginId).toBe("discord");
    expect(plan.namespace).toBe("model-picker-preferences");
    const entries = await plan.readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toMatch(/^v1:[0-9a-f]{32}:[0-9a-f]{24}$/u);
    expect(entries[0]?.value).toEqual({
      scopeKey: "discord:default:dm:user:123",
      modelRef: "openai/gpt-5",
      updatedAt: "2026-05-29T00:00:00.001Z",
    });
  });
});
