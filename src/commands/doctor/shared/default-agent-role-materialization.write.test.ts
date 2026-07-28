import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restoreEnvVarRefs } from "../../../config/env-preserve.js";
import { parseConfigJson5 } from "../../../config/io.read-helpers.js";
import { materializeDefaultAgentRoles } from "./default-agent-role-materialization.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("default role materialization authored writes", () => {
  it("preserves env references and is idempotent through restoreEnvVarRefs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-default-roles-"));
    roots.push(root);
    const raw = `${JSON.stringify(
      {
        agents: {
          defaults: { model: "${DEFAULT_MODEL}" },
          entries: {
            ops: { default: true },
            research: { model: "${RESEARCH_MODEL}" },
          },
        },
        channels: { telegram: { enabled: true } },
      },
      null,
      2,
    )}\n`;
    await fs.writeFile(path.join(root, "openclaw.json"), raw, "utf-8");

    const env = {
      DEFAULT_MODEL: "openai/default-model",
      RESEARCH_MODEL: "openai/research-model",
    } as NodeJS.ProcessEnv;

    const parsedResult = parseConfigJson5(raw);
    expect(parsedResult.ok).toBe(true);
    if (!parsedResult.ok) {
      throw new Error("parse failed");
    }
    const parsed = parsedResult.parsed as Parameters<typeof materializeDefaultAgentRoles>[0];

    const materialized = materializeDefaultAgentRoles(parsed);
    expect(materialized.changes.length).toBeGreaterThan(0);

    const restored = restoreEnvVarRefs(materialized.config, parsedResult.parsed, env) as {
      agents?: { defaults?: { model?: string }; entries?: Record<string, { model?: string }> };
      bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
    };
    expect(restored.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(restored.agents?.defaults?.model).toBe("${DEFAULT_MODEL}");
    expect(restored.agents?.entries?.research?.model).toBe("${RESEARCH_MODEL}");

    const reparsed = parseConfigJson5(`${JSON.stringify(restored, null, 2)}\n`);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) {
      throw new Error("reparse failed");
    }
    const rerun = materializeDefaultAgentRoles(
      reparsed.parsed as Parameters<typeof materializeDefaultAgentRoles>[0],
    );
    expect(rerun.changes).toEqual([]);
  });

  it("restores authored references when any binding already routes to the default agent without throwing EnvRefArrayMutationError", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-default-roles-agent-id-"));
    roots.push(root);
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
          {
            agentId: "ops",
            match: {
              channel: "telegram",
              peer: { kind: "group", id: "-1000000000001" },
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
    await fs.writeFile(path.join(root, "openclaw.json"), raw, "utf-8");

    const env = {
      TELEGRAM_OWNER_ID: "owner-id-resolved",
    } as NodeJS.ProcessEnv;

    const parsedResult = parseConfigJson5(raw);
    expect(parsedResult.ok).toBe(true);
    if (!parsedResult.ok) {
      throw new Error("parse failed");
    }
    const parsed = parsedResult.parsed as Parameters<typeof materializeDefaultAgentRoles>[0];

    // Any existing binding already routes to the default agent, so the
    // migration must skip ALL channel-wide materialization (not just the
    // channel where the binding lives). Otherwise the matcher in
    // restoreEnvVarRefs would find multiple incoming entries with the same
    // agentId and reject the write.
    const materialized = materializeDefaultAgentRoles(parsed);
    expect(materialized.changes).toEqual([]);
    expect(materialized.config.bindings).toEqual(parsed.bindings);

    let restored: unknown;
    expect(() => {
      restored = restoreEnvVarRefs(materialized.config, parsedResult.parsed, env);
    }).not.toThrow();

    const restoredRecord = restored as {
      bindings?: Array<{
        agentId?: string;
        match?: {
          channel?: string;
          accountId?: string;
          peer?: { kind?: string; id?: string };
        };
      }>;
    };
    expect(restoredRecord.bindings).toEqual(parsed.bindings);
    expect(restoredRecord.bindings).toContainEqual({
      agentId: "ops",
      match: {
        channel: "telegram",
        peer: { kind: "direct", id: "${TELEGRAM_OWNER_ID}" },
      },
    });
    // Neither channel receives a sibling channel-wide "ops" entry — the
    // matcher's identity resolution would otherwise collide.
    expect(restoredRecord.bindings).not.toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(restoredRecord.bindings).not.toContainEqual({
      agentId: "ops",
      match: { channel: "whatsapp", accountId: "*" },
    });

    const reparsed = parseConfigJson5(`${JSON.stringify(restored, null, 2)}\n`);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) {
      throw new Error("reparse failed");
    }
    const rerun = materializeDefaultAgentRoles(
      reparsed.parsed as Parameters<typeof materializeDefaultAgentRoles>[0],
    );
    expect(rerun.changes).toEqual([]);
  });
});
