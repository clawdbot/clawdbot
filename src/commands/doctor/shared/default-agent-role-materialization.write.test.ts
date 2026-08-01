import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../config/io.js";
import { materializeDefaultAgentRoles } from "./default-agent-role-materialization.js";

const roots: string[] = [];

afterEach(async () => {
  resetConfigRuntimeState();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("default role materialization authored writes", () => {
  it("preserves env references and includes and is idempotent after persistence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-default-roles-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const channelsPath = path.join(root, "channels.json5");
    const includeRaw = `${JSON.stringify({ telegram: { enabled: true } }, null, 2)}\n`;
    await fs.writeFile(channelsPath, includeRaw, "utf-8");
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          agents: {
            defaults: { model: "${DEFAULT_MODEL}" },
            entries: {
              ops: { default: true },
              research: { model: "${RESEARCH_MODEL}" },
            },
          },
          channels: { $include: "./channels.json5" },
          talk: { provider: "test" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const io = createConfigIO({
      configPath,
      env: {
        HOME: root,
        OPENCLAW_TEST_FAST: "1",
        DEFAULT_MODEL: "openai/default-model",
        RESEARCH_MODEL: "openai/research-model",
      } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    const materialized = materializeDefaultAgentRoles(snapshot.config);
    expect(materialized.changes.length).toBeGreaterThan(0);
    await io.writeConfigFile(materialized.config, { baseSnapshot: snapshot });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      agents?: {
        defaults?: { model?: string; heartbeat?: { agentId?: string } };
        entries?: Record<string, { model?: string }>;
      };
      channels?: { $include?: string };
      bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
      talk?: { agentId?: string };
    };
    expect(persisted.agents?.defaults?.model).toBe("${DEFAULT_MODEL}");
    expect(persisted.agents?.entries?.research?.model).toBe("${RESEARCH_MODEL}");
    expect(persisted.channels).toEqual({ $include: "./channels.json5" });
    await expect(fs.readFile(channelsPath, "utf-8")).resolves.toBe(includeRaw);
    expect(persisted.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(persisted.agents?.defaults?.heartbeat?.agentId).toBe("ops");
    expect(persisted.talk?.agentId).toBe("ops");

    const reread = await io.readConfigFileSnapshot();
    expect(materializeDefaultAgentRoles(reread.config).changes).toEqual([]);
  });
});
