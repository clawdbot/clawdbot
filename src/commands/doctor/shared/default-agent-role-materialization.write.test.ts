import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../config/io.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { materializeDefaultAgentRoles } from "./default-agent-role-materialization.js";

const roots: string[] = [];

afterEach(async () => {
  resetConfigRuntimeState();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("default role materialization authored writes", () => {
  it("preserves env references through writeConfigFile and is idempotent after persistence", async () => {
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

  it("round-trips env references through writeConfigFile when agentId identity collision would otherwise trip EnvRefArrayMutationError", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-default-roles-agent-id-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const raw = `${JSON.stringify(
      {
        agents: {
          defaults: {
            heartbeat: { agentId: "ops" },
            systemAgent: { agentId: "ops" },
          },
          entries: {
            ops: { default: true },
            group: {},
          },
        },
        bindings: [
          {
            agentId: "ops",
            match: {
              channel: "telegram",
              peer: { kind: "direct", id: "${TELEGRAM_OWNER_ID}" },
            },
          },
        ],
        channels: {
          telegram: { enabled: true },
          whatsapp: { enabled: true },
        },
        talk: { agentId: "ops", provider: "test" },
      },
      null,
      2,
    )}\n`;
    await fs.writeFile(configPath, raw, "utf-8");

    const io = createConfigIO({
      configPath,
      env: {
        HOME: root,
        OPENCLAW_TEST_FAST: "1",
        TELEGRAM_OWNER_ID: "owner-id-resolved",
      } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);

    // The migration detects the trip-prone shape (single literal
    // `agentId: "ops"` binding + env-template in the parsed file) and skips
    // every channel-wide materialization so the writer's matcher cannot
    // find a second incoming match.
    const materialized = materializeDefaultAgentRoles(snapshot.config);
    expect(materialized.changes).toEqual([
      "Skipped telegram, whatsapp: identity-collision guard against ops would trip EnvRefArrayMutationError during write.",
    ]);

    // The full ConfigIO write path exercises the env-resolved snapshot →
    // materialize → re-read-and-parse → restoreEnvVarRefs sequence where
    // the original identity-collision actually occurs.
    await expect(
      io.writeConfigFile(materialized.config, { baseSnapshot: snapshot }),
    ).resolves.toBeDefined();

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      agents?: {
        defaults?: { heartbeat?: { agentId?: string }; systemAgent?: { agentId?: string } };
      };
      bindings?: Array<{
        agentId?: string;
        match?: {
          channel?: string;
          accountId?: string;
          peer?: { kind?: string; id?: string };
        };
      }>;
    };
    // The user's authored env-template round-trips intact on disk.
    expect(persisted.bindings).toContainEqual({
      agentId: "ops",
      match: {
        channel: "telegram",
        peer: { kind: "direct", id: "${TELEGRAM_OWNER_ID}" },
      },
    });
    // Neither channel received a sibling channel-wide "ops" entry —
    // the migration's identity-collision guard held the line.
    expect(persisted.bindings).not.toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(persisted.bindings).not.toContainEqual({
      agentId: "ops",
      match: { channel: "whatsapp", accountId: "*" },
    });
    expect(persisted.agents?.defaults?.heartbeat?.agentId).toBe("ops");
    expect(persisted.agents?.defaults?.systemAgent?.agentId).toBe("ops");

    // Re-running the migration on the reread still produces the
    // trip-prone skip: the persisted file keeps the env-template and the
    // lone literal `agentId: "ops"` binding, so the matcher's identity
    // path would still trip on a sibling append. The migration therefore
    // refuses to mutate the bindings on a second pass and stays in the
    // handwritten state.
    const reread = await io.readConfigFileSnapshot();
    expect(materializeDefaultAgentRoles(reread.config, { parsed: reread.parsed }).changes).toEqual([
      "Skipped telegram, whatsapp: identity-collision guard against ops would trip EnvRefArrayMutationError during write.",
    ]);
  });
});
