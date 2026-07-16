// Doctor session state provider tests cover route-state repair through the public doctor path.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runPluginSessionStateDoctorRepairs } from "./doctor-session-state-providers.js";

const codexOwner = {
  id: "codex",
  label: "Codex",
  providerIds: ["codex", "codex-cli", "openai-codex"],
  runtimeIds: ["codex", "codex-cli"],
  cliSessionKeys: ["codex-cli"],
  authProfilePrefixes: ["codex:", "codex-cli:", "openai-codex:"],
};
const anthropicOwner = {
  id: "anthropic",
  label: "Anthropic",
  providerIds: ["anthropic"],
  runtimeIds: ["claude-cli"],
  cliSessionKeys: ["claude-cli"],
  authProfilePrefixes: ["anthropic:", "claude-cli:"],
};
const ownerState = vi.hoisted(() => ({ owners: [] as Array<Record<string, unknown>> }));

vi.mock("../plugins/doctor-contract-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/doctor-contract-registry.js")>(
    "../plugins/doctor-contract-registry.js",
  );
  return {
    ...actual,
    listPluginDoctorSessionRouteStateOwners: vi.fn(() => ownerState.owners),
  };
});

async function runDoctor(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  confirm?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-route-doctor-"));
  const storePath = path.join(root, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(params.store), "utf8");
  const warnings: string[] = [];
  const changes: string[] = [];
  const confirmRuntimeRepair = vi.fn(async () => params.confirm ?? true);
  try {
    await runPluginSessionStateDoctorRepairs({
      cfg: params.cfg,
      store: structuredClone(params.store),
      absoluteStorePath: storePath,
      prompter: { confirmRuntimeRepair, note: vi.fn() },
      env: params.env ?? {},
      warnings,
      changes,
    });
    return {
      store: JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, SessionEntry>,
      warnings,
      changes,
      confirmRuntimeRepair,
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function entry(patch: Record<string, unknown>): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    ...patch,
  } as SessionEntry;
}

describe("doctor session state provider routes", () => {
  beforeEach(() => {
    ownerState.owners = [codexOwner];
  });

  it("skips unrelated recovery metadata and valid locked harness rows", async () => {
    const store = {
      "agent:main:subagent:wedged-child": entry({
        abortedLastRun: true,
        subagentRecovery: {
          automaticAttempts: 2,
          lastAttemptAt: 1,
          wedgedAt: 2,
          wedgedReason: "blocked",
        },
      }),
      "agent:main:ordinary-locked": entry({
        modelSelectionLocked: true,
        agentHarnessId: "codex",
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "auto",
        cliSessionBindings: { "codex-cli": { sessionId: "native-codex-session" } },
      }),
    };

    const result = await runDoctor({ cfg: {}, store });

    expect(result.store).toEqual(store);
    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.confirmRuntimeRepair).not.toHaveBeenCalled();
  });

  it("keeps owner state when the configured provider selects the owner runtime", async () => {
    const store = {
      "agent:main:telegram:direct:1": entry({
        modelProvider: "codex-cli",
        model: "gpt-5.5",
        cliSessionBindings: { "codex-cli": { sessionId: "codex-cli-session" } },
      }),
    };
    const cfg = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            agentRuntime: { id: "codex-cli" },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDoctor({ cfg, store });

    expect(result.store).toEqual(store);
    expect(result.confirmRuntimeRepair).not.toHaveBeenCalled();
  });

  it("clears stale automatic owner state through the doctor repair boundary", async () => {
    const sessionKey = "agent:main:telegram:direct:2";
    const store = {
      [sessionKey]: entry({
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        modelOverrideSource: "auto",
        modelProvider: "openai-codex",
        model: "gpt-5.4",
        contextTokens: 1_050_000,
        systemPromptReport: { source: "run" },
        agentHarnessId: "codex",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
        cliSessionBindings: {
          "codex-cli": { sessionId: "codex-session" },
          "claude-cli": { sessionId: "claude-session" },
        },
      }),
    };
    const cfg = {
      agents: { defaults: { model: { primary: "github-copilot/gpt-5-mini" } } },
    } satisfies OpenClawConfig;

    const result = await runDoctor({ cfg, store });
    const repaired = result.store[sessionKey] as unknown as Record<string, unknown>;

    expect(result.confirmRuntimeRepair).toHaveBeenCalledOnce();
    expect(result.warnings.join("\n")).toContain("stale Codex session routing state");
    expect(result.changes.join("\n")).toContain("Cleared stale Codex session routing state");
    expect(repaired.providerOverride).toBeUndefined();
    expect(repaired.modelOverride).toBeUndefined();
    expect(repaired.modelProvider).toBeUndefined();
    expect(repaired.agentHarnessId).toBeUndefined();
    expect(repaired.authProfileOverride).toBeUndefined();
    expect(repaired.cliSessionBindings).toEqual({
      "claude-cli": { sessionId: "claude-session" },
    });
  });

  it("leaves explicit user owner choices for manual review", async () => {
    const sessionKey = "agent:main:telegram:direct:3";
    const store = {
      [sessionKey]: entry({
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        modelOverrideSource: "user",
        modelProvider: "openai-codex",
        model: "gpt-5.4",
        agentHarnessId: "codex",
      }),
    };
    const cfg = {
      agents: { defaults: { model: { primary: "github-copilot/gpt-5-mini" } } },
    } satisfies OpenClawConfig;

    const result = await runDoctor({ cfg, store });

    expect(result.store).toEqual(store);
    expect(result.warnings.join("\n")).toContain("explicit Codex model overrides");
    expect(result.confirmRuntimeRepair).not.toHaveBeenCalled();
  });

  it("keeps configured owner model state while clearing a stale runtime pin", async () => {
    const sessionKey = "agent:main:telegram:direct:4";
    const store = {
      [sessionKey]: entry({
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        modelOverrideSource: "auto",
        modelProvider: "openai-codex",
        model: "gpt-5.4",
        agentHarnessId: "codex",
      }),
    };
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "github-copilot/gpt-5-mini",
            fallbacks: ["openai-codex/gpt-5.4"],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDoctor({ cfg, store });
    const repaired = result.store[sessionKey] as unknown as Record<string, unknown>;

    expect(repaired.providerOverride).toBe("openai-codex");
    expect(repaired.modelOverride).toBe("gpt-5.4");
    expect(repaired.modelProvider).toBe("openai-codex");
    expect(repaired.agentHarnessId).toBeUndefined();
  });

  it("skips bare entries and only prompts for route-state rows", async () => {
    const store: Record<string, SessionEntry> = {};
    for (let index = 0; index < 100; index += 1) {
      store[`agent:main:bare-${index}`] = entry({});
    }
    store["agent:main:codex"] = entry({ agentHarnessId: "codex-cli" });

    const result = await runDoctor({
      cfg: { agents: { defaults: { model: "anthropic/claude-sonnet-4" } } },
      store,
      confirm: false,
    });

    expect(result.confirmRuntimeRepair).toHaveBeenCalledOnce();
    expect(result.changes).toStrictEqual([]);
    expect(result.store).toEqual(store);
  });

  it("preserves a provider-owned runtime pin when that runtime remains configured", async () => {
    ownerState.owners = [codexOwner, anthropicOwner];
    const store = {
      "agent:main:telegram:direct:5": entry({ agentRuntimeOverride: "claude-cli" }),
    };
    const cfg = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4.7" } } },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            agentRuntime: { id: "claude-cli" },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDoctor({ cfg, store });

    expect(result.store).toEqual(store);
    expect(result.confirmRuntimeRepair).not.toHaveBeenCalled();
  });

  it("applies independent multi-owner repairs and records each owner", async () => {
    ownerState.owners = [codexOwner, anthropicOwner];
    const sessionKey = "agent:main:telegram:direct:6";
    const store = {
      [sessionKey]: entry({
        agentHarnessId: "codex",
        agentRuntimeOverride: "claude-cli",
      }),
    };

    const result = await runDoctor({
      cfg: { agents: { defaults: { model: "github-copilot/gpt-5-mini" } } },
      store,
    });
    const repaired = result.store[sessionKey] as unknown as Record<string, unknown>;

    expect(result.confirmRuntimeRepair).toHaveBeenCalledTimes(2);
    expect(result.warnings.join("\n")).toContain("stale Codex session routing state");
    expect(result.warnings.join("\n")).toContain("stale Anthropic session routing state");
    expect(result.changes.join("\n")).toContain("Cleared stale Codex session routing state");
    expect(result.changes.join("\n")).toContain("Cleared stale Anthropic session routing state");
    expect(repaired.agentHarnessId).toBeUndefined();
    expect(repaired.agentRuntimeOverride).toBeUndefined();
  });
});
