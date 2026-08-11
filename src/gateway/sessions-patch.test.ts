import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

const SUBAGENT_MODEL = "synthetic/hf:moonshotai/Kimi-K2.5";
const KIMI_SUBAGENT_KEY = "agent:kimi:subagent:child";

async function applySubagentModelPatch(cfg: OpenClawConfig) {
  const res = await applySessionsPatchToStore({
    cfg,
    store: {},
    storeKey: KIMI_SUBAGENT_KEY,
    patch: {
      key: KIMI_SUBAGENT_KEY,
      model: SUBAGENT_MODEL,
    },
    loadGatewayModelCatalog: async () => [
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "sonnet" },
      { provider: "synthetic", id: "hf:moonshotai/Kimi-K2.5", name: "kimi" },
    ],
  });
  expect(res.ok).toBe(true);
  if (!res.ok) {
    throw new Error(res.error.message);
  }
  return res.entry;
}

function makeKimiSubagentCfg(params: {
  agentPrimaryModel: string;
  agentSubagentModel?: string;
  defaultsSubagentModel?: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
        subagents: params.defaultsSubagentModel
          ? { model: params.defaultsSubagentModel }
          : undefined,
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "default" },
        },
      },
      list: [
        {
          id: "kimi",
          model: { primary: params.agentPrimaryModel },
          subagents: params.agentSubagentModel ? { model: params.agentSubagentModel } : undefined,
        },
      ],
    },
  } as OpenClawConfig;
}

describe("gateway sessions patch", () => {
  test("persists thinkingLevel=off (does not clear)", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", thinkingLevel: "off" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.thinkingLevel).toBe("off");
  });

  test("clears thinkingLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": { thinkingLevel: "low" } as SessionEntry,
    };
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", thinkingLevel: null },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.thinkingLevel).toBeUndefined();
  });

  test("persists elevatedLevel=off (does not clear)", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", elevatedLevel: "off" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.elevatedLevel).toBe("off");
  });

  test("persists elevatedLevel=on", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", elevatedLevel: "on" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.elevatedLevel).toBe("on");
  });

  test("clears elevatedLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": { elevatedLevel: "off" } as SessionEntry,
    };
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", elevatedLevel: null },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.elevatedLevel).toBeUndefined();
  });

  test("rejects invalid elevatedLevel values", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", elevatedLevel: "maybe" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.error.message).toContain("invalid elevatedLevel");
  });

  test("clears auth overrides when model patch changes", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-5",
        authProfileOverride: "anthropic:default",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 3,
      } as SessionEntry,
    };
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", model: "openai/gpt-5.2" },
      loadGatewayModelCatalog: async () => [{ provider: "openai", id: "gpt-5.2", name: "gpt-5.2" }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.providerOverride).toBe("openai");
    expect(res.entry.modelOverride).toBe("gpt-5.2");
    expect(res.entry.authProfileOverride).toBeUndefined();
    expect(res.entry.authProfileOverrideSource).toBeUndefined();
    expect(res.entry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  test("sets spawnDepth for subagent sessions", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:subagent:child",
      patch: { key: "agent:main:subagent:child", spawnDepth: 2 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.spawnDepth).toBe(2);
  });

  test("rejects spawnDepth on non-subagent sessions", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", spawnDepth: 1 },
    });
    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.error.message).toContain("spawnDepth is only supported");
  });

  test("normalizes exec/send/group patches", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: {
        key: "agent:main:main",
        execHost: " NODE ",
        execSecurity: " ALLOWLIST ",
        execAsk: " ON-MISS ",
        execNode: " worker-1 ",
        sendPolicy: "DENY" as unknown as "allow",
        groupActivation: "Always" as unknown as "mention",
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.execHost).toBe("node");
    expect(res.entry.execSecurity).toBe("allowlist");
    expect(res.entry.execAsk).toBe("on-miss");
    expect(res.entry.execNode).toBe("worker-1");
    expect(res.entry.sendPolicy).toBe("deny");
    expect(res.entry.groupActivation).toBe("always");
  });

  test("clears exec companion fields when execNode is set to null", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess",
        updatedAt: 1,
        execHost: "node",
        execSecurity: "allowlist",
        execAsk: "on-miss",
        execNode: "worker-1",
      } as SessionEntry,
    };
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", execNode: null },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.execNode).toBeUndefined();
    expect(res.entry.execHost).toBeUndefined();
    expect(res.entry.execSecurity).toBeUndefined();
    expect(res.entry.execAsk).toBeUndefined();
  });

  test("preserves explicitly-set execHost when execNode is null in same patch", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess",
        updatedAt: 1,
        execHost: "node",
        execSecurity: "allowlist",
        execAsk: "on-miss",
        execNode: "worker-1",
      } as SessionEntry,
    };
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", execNode: null, execHost: "sandbox" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.execNode).toBeUndefined();
    expect(res.entry.execHost).toBe("sandbox");
    expect(res.entry.execSecurity).toBeUndefined();
    expect(res.entry.execAsk).toBeUndefined();
  });

  test("preserves all companion fields when explicitly set alongside execNode null", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess",
        updatedAt: 1,
        execHost: "node",
        execSecurity: "full",
        execAsk: "always",
        execNode: "worker-1",
      } as SessionEntry,
    };
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: {
        key: "agent:main:main",
        execNode: null,
        execHost: "gateway",
        execSecurity: "deny",
        execAsk: "off",
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.entry.execNode).toBeUndefined();
    expect(res.entry.execHost).toBe("gateway");
    expect(res.entry.execSecurity).toBe("deny");
    expect(res.entry.execAsk).toBe("off");
  });

  test("rejects invalid execHost values", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", execHost: "edge" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.error.message).toContain("invalid execHost");
  });

  test("rejects invalid sendPolicy values", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", sendPolicy: "ask" as unknown as "allow" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.error.message).toContain("invalid sendPolicy");
  });

  test("rejects invalid groupActivation values", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:main",
      patch: { key: "agent:main:main", groupActivation: "never" as unknown as "mention" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.error.message).toContain("invalid groupActivation");
  });

  test("allows target agent own model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      agentPrimaryModel: "synthetic/hf:moonshotai/Kimi-K2.5",
    });

    const entry = await applySubagentModelPatch(cfg);
    // Selected model matches the target agent default, so no override is stored.
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
  });

  test("allows target agent subagents.model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      agentPrimaryModel: "anthropic/claude-sonnet-4-6",
      agentSubagentModel: SUBAGENT_MODEL,
    });

    const entry = await applySubagentModelPatch(cfg);
    expect(entry.providerOverride).toBe("synthetic");
    expect(entry.modelOverride).toBe("hf:moonshotai/Kimi-K2.5");
  });

  test("allows global defaults.subagents.model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      agentPrimaryModel: "anthropic/claude-sonnet-4-6",
      defaultsSubagentModel: SUBAGENT_MODEL,
    });

    const entry = await applySubagentModelPatch(cfg);
    expect(entry.providerOverride).toBe("synthetic");
    expect(entry.modelOverride).toBe("hf:moonshotai/Kimi-K2.5");
  });
});
