import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyXaiModelCompat,
  findUnsupportedSchemaKeywords,
  GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
  XAI_UNSUPPORTED_SCHEMA_KEYWORDS,
} from "../plugin-sdk/provider-tools.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { expectReadWriteEditTools } from "./test-helpers/pi-tools-fs-helpers.js";
import { createPiToolsSandboxContext } from "./test-helpers/pi-tools-sandbox-context.js";
import { providerAliasCases } from "./test-helpers/provider-alias-cases.js";
import { buildEmptyExplicitToolAllowlistError } from "./tool-allowlist-guard.js";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, normalizeToolName } from "./tool-policy.js";

const tinyPngBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
  "base64",
);

function collectActionValues(schema: unknown, values: Set<string>): void {
  if (!schema || typeof schema !== "object") {
    return;
  }

  const record = schema as Record<string, unknown>;
  if (typeof record.const === "string") {
    values.add(record.const);
  }
  if (Array.isArray(record.enum)) {
    for (const value of record.enum) {
      if (typeof value === "string") {
        values.add(value);
      }
    }
  }
  if (Array.isArray(record.anyOf)) {
    for (const variant of record.anyOf) {
      collectActionValues(variant, values);
    }
  }
}

async function writeSessionStore(
  storeTemplate: string,
  agentId: string,
  entries: Record<string, unknown>,
) {
  await fs.writeFile(
    storeTemplate.replaceAll("{agentId}", agentId),
    JSON.stringify(entries, null, 2),
    "utf-8",
  );
}

function createToolsForStoredSession(storeTemplate: string, sessionKey: string) {
  return createOpenClawCodingTools({
    sessionKey,
    config: {
      session: {
        store: storeTemplate,
      },
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
          },
        },
      },
    },
  });
}

function expectNoSubagentControlTools(tools: ReturnType<typeof createOpenClawCodingTools>) {
  const names = new Set(tools.map((tool) => tool.name));
  expect(names.has("sessions_spawn")).toBe(false);
  expect(names.has("sessions_list")).toBe(false);
  expect(names.has("sessions_history")).toBe(false);
  expect(names.has("subagents")).toBe(false);
}

function applyRuntimeToolsAllow<T extends { name: string }>(tools: T[], toolsAllow: string[]) {
  const allowSet = new Set(toolsAllow.map((name) => normalizeToolName(name)));
  return tools.filter((tool) => allowSet.has(normalizeToolName(tool.name)));
}

describe("createOpenClawCodingTools", () => {
  const testConfig: OpenClawConfig = {};

  it("exposes gateway config and restart actions to owner sessions", () => {
    const tools = createOpenClawCodingTools({ config: testConfig, senderIsOwner: true });
    const gateway = tools.find((tool) => tool.name === "gateway");
    expect(gateway).toBeDefined();

    const parameters = gateway?.parameters as {
      properties?: Record<string, unknown>;
    };
    const action = parameters.properties?.action as
      | { const?: unknown; enum?: unknown[] }
      | undefined;
    const values = new Set<string>();
    collectActionValues(action, values);

    expect([...values]).toEqual(
      expect.arrayContaining(["restart", "config.get", "config.patch", "config.apply"]),
    );
  });

  it("exposes only an explicitly authorized owner-only tool to non-owner sessions", () => {
    const tools = createOpenClawCodingTools({
      config: testConfig,
      senderIsOwner: false,
      ownerOnlyToolAllowlist: ["cron"],
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("cron")).toBe(true);
    expect(names.has("gateway")).toBe(false);
    expect(names.has("nodes")).toBe(false);
  });

  it("resolves isolated cron runtime toolsAllow after the cron owner-only grant", () => {
    const withoutGrant = applyRuntimeToolsAllow(
      createOpenClawCodingTools({
        config: testConfig,
        senderIsOwner: false,
      }),
      ["cron"],
    );
    const errorWithoutGrant = buildEmptyExplicitToolAllowlistError({
      sources: [{ label: "runtime toolsAllow", entries: ["cron"] }],
      callableToolNames: withoutGrant.map((tool) => tool.name),
      toolsEnabled: true,
    });

    expect(errorWithoutGrant?.message).toContain(
      "No callable tools remain after resolving explicit tool allowlist (runtime toolsAllow: cron); no registered tools matched.",
    );

    const withGrant = applyRuntimeToolsAllow(
      createOpenClawCodingTools({
        config: testConfig,
        senderIsOwner: false,
        ownerOnlyToolAllowlist: ["cron"],
      }),
      ["cron"],
    );

    expect(withGrant.map((tool) => tool.name)).toEqual(["cron"]);
    expect(
      buildEmptyExplicitToolAllowlistError({
        sources: [{ label: "runtime toolsAllow", entries: ["cron"] }],
        callableToolNames: withGrant.map((tool) => tool.name),
        toolsEnabled: true,
      }),
    ).toBeNull();
  });

  it("uses runtime toolsAllow when materializing plugin tools", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      runtimeToolAllowlist: ["memory_search", "memory_get"],
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginToolAllowlist: expect.arrayContaining(["memory_search", "memory_get"]),
      }),
    );
  });

  it("uses tools.alsoAllow for optional plugin discovery without widening to all plugins", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: { tools: { alsoAllow: ["lobster"] } },
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginToolAllowlist: ["lobster", DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY],
      }),
    );
  });

  it("passes explicit denylist entries to OpenClaw tool factory planning", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: { tools: { deny: ["pdf"] } },
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginToolDenylist: expect.arrayContaining(["pdf"]),
      }),
    );
  });

  it("records core tool-prep stages for hot-path diagnostics", () => {
    const stages: string[] = [];

    createOpenClawCodingTools({
      config: testConfig,
      recordToolPrepStage: (name) => stages.push(name),
      senderIsOwner: true,
    });

    expect(stages).toEqual(
      expect.arrayContaining([
        "tool-policy",
        "workspace-policy",
        "base-coding-tools",
        "shell-tools",
        "openclaw-tools:test-helper",
        "openclaw-tools",
        "message-provider-policy",
        "model-provider-policy",
        "authorization-policy",
        "schema-normalization",
        "tool-hooks",
        "abort-wrappers",
        "deferred-followup-descriptions",
      ]),
    );
    expect(stages.indexOf("tool-policy")).toBeLessThan(stages.indexOf("workspace-policy"));
    expect(stages.indexOf("workspace-policy")).toBeLessThan(stages.indexOf("base-coding-tools"));
    expect(stages.indexOf("openclaw-tools:test-helper")).toBeLessThan(
      stages.indexOf("openclaw-tools"),
    );
    expect(stages.indexOf("schema-normalization")).toBeLessThan(stages.indexOf("tool-hooks"));
  });

  it("preserves action enums in normalized schemas", () => {
    const defaultTools = createOpenClawCodingTools({ config: testConfig, senderIsOwner: true });
    const toolNames = ["canvas", "nodes", "cron", "gateway", "message"];
    const missingNames = toolNames.filter(
      (name) => !defaultTools.some((candidate) => candidate.name === name),
    );
    expect(missingNames).toEqual([]);

    for (const name of toolNames) {
      const tool = defaultTools.find((candidate) => candidate.name === name);
      const parameters = tool?.parameters as {
        properties?: Record<string, unknown>;
      };
      const action = parameters.properties?.action as
        | { const?: unknown; enum?: unknown[] }
        | undefined;
      const values = new Set<string>();
      collectActionValues(action, values);

      const min = name === "gateway" ? 1 : 2;
      expect(values.size).toBeGreaterThanOrEqual(min);
    }
  });

  it("enforces apply_patch availability and canonical names across model/provider constraints", () => {
    const defaultTools = createOpenClawCodingTools({ config: testConfig, senderIsOwner: true });
    expect(defaultTools.some((tool) => tool.name === "exec")).toBe(true);
    expect(defaultTools.some((tool) => tool.name === "process")).toBe(true);
    expect(defaultTools.some((tool) => tool.name === "apply_patch")).toBe(false);

    const openAiTools = createOpenClawCodingTools({
      config: testConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(openAiTools.some((tool) => tool.name === "apply_patch")).toBe(true);

    const codexTools = createOpenClawCodingTools({
      config: testConfig,
      modelProvider: "openai-codex",
      modelId: "gpt-5.4",
    });
    expect(codexTools.some((tool) => tool.name === "apply_patch")).toBe(true);

    const disabledConfig: OpenClawConfig = {
      tools: {
        exec: {
          applyPatch: { enabled: false },
        },
      },
    };
    const disabledOpenAiTools = createOpenClawCodingTools({
      config: disabledConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(disabledOpenAiTools.some((tool) => tool.name === "apply_patch")).toBe(false);

    const anthropicTools = createOpenClawCodingTools({
      config: disabledConfig,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    expect(anthropicTools.some((tool) => tool.name === "apply_patch")).toBe(false);

    const allowModelsConfig: OpenClawConfig = {
      tools: {
        exec: {
          applyPatch: { allowModels: ["gpt-5.4"] },
        },
      },
    };
    const allowed = createOpenClawCodingTools({
      config: allowModelsConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(allowed.some((tool) => tool.name === "apply_patch")).toBe(true);

    const denied = createOpenClawCodingTools({
      config: allowModelsConfig,
      modelProvider: "openai",
      modelId: "gpt-5.4-mini",
    });
    expect(denied.some((tool) => tool.name === "apply_patch")).toBe(false);

    const oauthTools = createOpenClawCodingTools({
      config: testConfig,
      modelProvider: "anthropic",
      modelAuthMode: "oauth",
    });
    const names = new Set(oauthTools.map((tool) => tool.name));
    expect(names.has("exec")).toBe(true);
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("apply_patch")).toBe(false);
  });

  it("provides top-level object schemas for all tools", () => {
    const tools = createOpenClawCodingTools({ config: testConfig });
    const offenders = tools
      .map((tool) => {
        const schema =
          tool.parameters && typeof tool.parameters === "object"
            ? (tool.parameters as Record<string, unknown>)
            : null;
        return {
          name: tool.name,
          type: schema?.type,
          keys: schema ? Object.keys(schema).toSorted() : null,
        };
      })
      .filter((entry) => entry.type !== "object");

    expect(offenders).toEqual([]);
  });

  it("does not expose provider-specific message tools", () => {
    const tools = createOpenClawCodingTools({ messageProvider: "discord" });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("discord")).toBe(false);
    expect(names.has("slack")).toBe(false);
    expect(names.has("telegram")).toBe(false);
    expect(names.has("whatsapp")).toBe(false);
  });

  it("filters session tools for sub-agent sessions by default", () => {
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("sessions_list")).toBe(false);
    expect(names.has("sessions_history")).toBe(false);
    expect(names.has("sessions_send")).toBe(false);
    expect(names.has("sessions_spawn")).toBe(false);
    expect(names.has("subagents")).toBe(false);

    expect(names.has("read")).toBe(true);
    expect(names.has("exec")).toBe(true);
    expect(names.has("process")).toBe(true);
    expect(names.has("apply_patch")).toBe(false);
  });

  it("uses stored spawnDepth to apply leaf tool policy for flat depth-2 session keys", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-depth-policy-"));
    try {
      const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
      await writeSessionStore(storeTemplate, "main", {
        "agent:main:subagent:flat": {
          sessionId: "session-flat-depth-2",
          updatedAt: Date.now(),
          spawnDepth: 2,
        },
      });

      const tools = createToolsForStoredSession(storeTemplate, "agent:main:subagent:flat");
      expectNoSubagentControlTools(tools);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies subagent tool policy to ACP children spawned under a subagent envelope", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-subagent-policy-"));
    try {
      const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
      await writeSessionStore(storeTemplate, "main", {
        "agent:main:acp:child": {
          sessionId: "session-acp-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:subagent:parent",
          spawnDepth: 2,
          subagentRole: "leaf",
          subagentControlScope: "none",
        },
        "agent:main:acp:plain": {
          sessionId: "session-acp-plain",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
        },
        "agent:main:acp:parent": {
          sessionId: "session-acp-parent",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:subagent:parent",
        },
      });
      await writeSessionStore(storeTemplate, "writer", {
        "agent:writer:acp:child": {
          sessionId: "session-acp-cross-agent-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:acp:parent",
        },
      });

      const persistedEnvelopeTools = createToolsForStoredSession(
        storeTemplate,
        "agent:main:acp:child",
      );
      expectNoSubagentControlTools(persistedEnvelopeTools);

      const restrictedTools = createToolsForStoredSession(storeTemplate, "agent:main:acp:plain");
      const restrictedNames = new Set(restrictedTools.map((tool) => tool.name));
      expect(restrictedNames.has("sessions_spawn")).toBe(true);
      expect(restrictedNames.has("subagents")).toBe(true);

      const ancestryTools = createToolsForStoredSession(storeTemplate, "agent:writer:acp:child");
      expectNoSubagentControlTools(ancestryTools);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies leaf tool policy for cross-agent subagent sessions when spawnDepth is missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cross-agent-subagent-"));
    try {
      const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
      await writeSessionStore(storeTemplate, "main", {
        "agent:main:subagent:parent": {
          sessionId: "session-main-parent",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
        },
      });
      await writeSessionStore(storeTemplate, "writer", {
        "agent:writer:subagent:child": {
          sessionId: "session-writer-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:subagent:parent",
        },
      });

      const tools = createToolsForStoredSession(storeTemplate, "agent:writer:subagent:child");
      expectNoSubagentControlTools(tools);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports allow-only sub-agent tool policy", () => {
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
      config: {
        tools: {
          subagents: {
            tools: {
              allow: ["read"],
            },
          },
        },
      },
    });
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("applies tool profiles before allow/deny policies", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { profile: "messaging" } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("message")).toBe(true);
    expect(names.has("sessions_send")).toBe(true);
    expect(names.has("sessions_spawn")).toBe(false);
    expect(names.has("exec")).toBe(false);
    expect(names.has("browser")).toBe(false);
  });

  it("includes browser tool with full profile when browser is configured (#76507)", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "full" },
        browser: { enabled: true },
        plugins: { entries: { browser: { enabled: true } } },
      } as OpenClawConfig,
      senderIsOwner: true,
    });
    const names = new Set(tools.map((tool) => tool.name));
    // full profile must not filter any tools — browser, canvas, etc. must be present.
    expect(names.has("browser")).toBe(true);
    expect(names.has("canvas")).toBe(true);
    expect(names.has("exec")).toBe(true);
    expect(names.has("message")).toBe(true);
  });

  it("includes browser tool with full profile for non-owner senders (#76507)", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "full" },
        browser: { enabled: true },
        plugins: { entries: { browser: { enabled: true } } },
      } as OpenClawConfig,
      senderIsOwner: false,
    });
    const names = new Set(tools.map((tool) => tool.name));
    // browser is NOT owner-only; it must be available to non-owner senders.
    expect(names.has("browser")).toBe(true);
    expect(names.has("canvas")).toBe(true);
    // owner-only tools should be filtered for non-owners
    expect(names.has("gateway")).toBe(false);
    expect(names.has("cron")).toBe(false);
    expect(names.has("nodes")).toBe(false);
  });

  it("includes browser tool without explicit profile (defaults to no filtering) (#76507)", () => {
    const tools = createOpenClawCodingTools({
      config: {
        browser: { enabled: true },
        plugins: { entries: { browser: { enabled: true } } },
      } as OpenClawConfig,
    });
    const names = new Set(tools.map((tool) => tool.name));
    // No profile means no profile filtering — all tools pass.
    expect(names.has("browser")).toBe(true);
  });

  it("keeps browser out of coding-profile subagents unless profile-stage alsoAllow adds it", () => {
    const baseConfig = {
      browser: { enabled: true },
      plugins: { entries: { browser: { enabled: true } } },
      tools: { profile: "coding" },
    } as OpenClawConfig;
    const codingSubagent = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
      config: baseConfig,
    });
    const codingNames = new Set(codingSubagent.map((tool) => tool.name));
    expect(codingNames.has("browser")).toBe(false);

    const subagentAllowOnly = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
      config: {
        ...baseConfig,
        tools: {
          profile: "coding",
          subagents: { tools: { allow: ["browser"] } },
        },
      } as OpenClawConfig,
    });
    expect(subagentAllowOnly.some((tool) => tool.name === "browser")).toBe(false);

    const profileStageAlsoAllow = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
      config: {
        ...baseConfig,
        tools: { profile: "coding", alsoAllow: ["browser"] },
      } as OpenClawConfig,
    });
    expect(profileStageAlsoAllow.some((tool) => tool.name === "browser")).toBe(true);
  });

  it("can keep message available when a cron route needs it under the coding profile", () => {
    const codingTools = createOpenClawCodingTools({
      config: { tools: { profile: "coding" } },
    });
    expect(codingTools.some((tool) => tool.name === "message")).toBe(false);

    const cronTools = createOpenClawCodingTools({
      config: { tools: { profile: "coding" } },
      forceMessageTool: true,
    });
    expect(cronTools.some((tool) => tool.name === "message")).toBe(true);
  });

  it("keeps heartbeat response available for heartbeat runs under the coding profile", () => {
    const codingTools = createOpenClawCodingTools({
      config: { tools: { profile: "coding" } },
      trigger: "heartbeat",
      enableHeartbeatTool: true,
      forceHeartbeatTool: true,
    });

    expect(codingTools.some((tool) => tool.name === "heartbeat_respond")).toBe(true);
  });

  it("enables heartbeat response when visible replies are message-tool-only", () => {
    const tools = createOpenClawCodingTools({
      config: {
        messages: { visibleReplies: "message_tool" },
        tools: { profile: "coding" },
      } as OpenClawConfig,
      trigger: "heartbeat",
    });

    expect(tools.some((tool) => tool.name === "heartbeat_respond")).toBe(true);
  });

  it("can keep message available when a cron route needs it under a provider coding profile", () => {
    const providerProfileTools = createOpenClawCodingTools({
      config: { tools: { byProvider: { openai: { profile: "coding" } } } },
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    expect(providerProfileTools.some((tool) => tool.name === "message")).toBe(false);

    const cronTools = createOpenClawCodingTools({
      config: { tools: { byProvider: { openai: { profile: "coding" } } } },
      modelProvider: "openai",
      modelId: "gpt-5.4",
      forceMessageTool: true,
    });
    expect(cronTools.some((tool) => tool.name === "message")).toBe(true);
  });

  it.each(providerAliasCases)(
    "applies canonical tools.byProvider deny policy to core tools for alias %s",
    (alias, canonical) => {
      const tools = createOpenClawCodingTools({
        config: {
          tools: {
            byProvider: {
              [canonical]: { deny: ["read"] },
            },
          },
        } as OpenClawConfig,
        modelProvider: alias,
      });
      const names = new Set(tools.map((tool) => tool.name));

      expect(names.has("read")).toBe(false);
      expect(names.has("write")).toBe(true);
    },
  );

  it("expands group shorthands in global tool policy", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { allow: ["group:fs"] } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("browser")).toBe(false);
  });

  it("expands group shorthands in global tool deny policy", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { deny: ["group:fs"] } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("read")).toBe(false);
    expect(names.has("write")).toBe(false);
    expect(names.has("edit")).toBe(false);
    expect(names.has("exec")).toBe(true);
  });

  it("lets agent profiles override global profiles", () => {
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:work:main",
      config: {
        tools: { profile: "coding" },
        agents: {
          list: [{ id: "work", tools: { profile: "messaging" } }],
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("message")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("read")).toBe(false);
  });

  it("removes unsupported JSON Schema keywords for Cloud Code Assist API compatibility", () => {
    const googleTools = createOpenClawCodingTools({
      modelProvider: "google",
      senderIsOwner: true,
    });
    for (const tool of googleTools) {
      const violations = findUnsupportedSchemaKeywords(
        tool.parameters,
        `${tool.name}.parameters`,
        GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
      );
      expect(violations).toEqual([]);
    }
  });

  it("applies xai model compat for direct Grok tool cleanup", () => {
    const xaiTools = createOpenClawCodingTools({
      modelProvider: "xai",
      modelCompat: applyXaiModelCompat({ compat: {} }).compat,
      senderIsOwner: true,
    });

    expect(xaiTools.some((tool) => tool.name === "web_search")).toBe(false);
    for (const tool of xaiTools) {
      const violations = findUnsupportedSchemaKeywords(
        tool.parameters,
        `${tool.name}.parameters`,
        XAI_UNSUPPORTED_SCHEMA_KEYWORDS,
      );
      expect(
        violations.filter((violation) => {
          const keyword = violation.split(".").at(-1) ?? "";
          return XAI_UNSUPPORTED_SCHEMA_KEYWORDS.has(keyword);
        }),
      ).toEqual([]);
    }
  });

  it("returns image-aware read metadata for images and text-only blocks for text files", async () => {
    const defaultTools = createOpenClawCodingTools();
    const readTool = defaultTools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-"));
    try {
      const imagePath = path.join(tmpDir, "sample.png");
      await fs.writeFile(imagePath, tinyPngBuffer);

      const imageResult = await readTool?.execute("tool-1", {
        path: imagePath,
      });

      const imageBlocks = imageResult?.content?.filter((block) => block.type === "image") as
        | Array<{ mimeType?: string }>
        | undefined;
      const imageTextBlocks = imageResult?.content?.filter((block) => block.type === "text") as
        | Array<{ text?: string }>
        | undefined;
      const imageText = imageTextBlocks?.map((block) => block.text ?? "").join("\n") ?? "";
      expect(imageText).toContain("Read image file [image/png]");
      if ((imageBlocks?.length ?? 0) > 0) {
        expect(imageBlocks?.every((block) => block.mimeType === "image/png")).toBe(true);
      } else {
        expect(imageText).toContain("[Image omitted:");
      }

      const textPath = path.join(tmpDir, "sample.txt");
      const contents = "Hello from openclaw read tool.";
      await fs.writeFile(textPath, contents, "utf8");

      const textResult = await readTool?.execute("tool-2", {
        path: textPath,
      });

      expect(textResult?.content?.some((block) => block.type === "image")).toBe(false);
      const textBlocks = textResult?.content?.filter((block) => block.type === "text") as
        | Array<{ text?: string }>
        | undefined;
      expect(textBlocks?.length ?? 0).toBeGreaterThan(0);
      const combinedText = textBlocks?.map((block) => block.text ?? "").join("\n");
      expect(combinedText).toContain(contents);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters tools by sandbox policy", () => {
    const sandboxDir = path.join(os.tmpdir(), "openclaw-sandbox");
    const sandbox = createPiToolsSandboxContext({
      workspaceDir: sandboxDir,
      agentWorkspaceDir: path.join(os.tmpdir(), "openclaw-workspace"),
      workspaceAccess: "none" as const,
      fsBridge: createHostSandboxFsBridge(sandboxDir),
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
    });
    const tools = createOpenClawCodingTools({ sandbox });
    expect(tools.some((tool) => tool.name === "exec")).toBe(true);
    expect(tools.some((tool) => tool.name === "read")).toBe(false);
    expect(tools.some((tool) => tool.name === "browser")).toBe(false);
  });

  it("hard-disables write/edit when sandbox workspaceAccess is ro", () => {
    const sandboxDir = path.join(os.tmpdir(), "openclaw-sandbox");
    const sandbox = createPiToolsSandboxContext({
      workspaceDir: sandboxDir,
      agentWorkspaceDir: path.join(os.tmpdir(), "openclaw-workspace"),
      workspaceAccess: "ro" as const,
      fsBridge: createHostSandboxFsBridge(sandboxDir),
      tools: {
        allow: ["read", "write", "edit"],
        deny: [],
      },
    });
    const tools = createOpenClawCodingTools({ sandbox });
    expect(tools.some((tool) => tool.name === "read")).toBe(true);
    expect(tools.some((tool) => tool.name === "write")).toBe(false);
    expect(tools.some((tool) => tool.name === "edit")).toBe(false);
  });

  it("accepts canonical parameters for read/write/edit", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canonical-"));
    try {
      const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

      const filePath = "canonical-test.txt";
      await writeTool?.execute("tool-canonical-1", {
        path: filePath,
        content: "hello world",
      });

      await editTool?.execute("tool-canonical-2", {
        path: filePath,
        edits: [{ oldText: "world", newText: "universe" }],
      });

      const result = await readTool?.execute("tool-canonical-3", {
        path: filePath,
      });

      const textBlocks = result?.content?.filter((block) => block.type === "text") as
        | Array<{ text?: string }>
        | undefined;
      const combinedText = textBlocks?.map((block) => block.text ?? "").join("\n");
      expect(combinedText).toContain("hello universe");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects legacy alias parameters", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-alias-"));
    try {
      const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

      await expect(
        writeTool?.execute("tool-legacy-write", {
          file: "legacy.txt",
          content: "hello old value",
        }),
      ).rejects.toThrow(/Missing required parameter: path/);

      await expect(
        editTool?.execute("tool-legacy-edit", {
          filePath: "legacy.txt",
          old_text: "old",
          newString: "new",
        }),
      ).rejects.toThrow(/Missing required parameters: path, edits/);

      await expect(
        readTool?.execute("tool-legacy-read", {
          file_path: "legacy.txt",
        }),
      ).rejects.toThrow(/Missing required parameter: path/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects structured content blocks for write", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-structured-write-"));
    try {
      const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
      const writeTool = tools.find((tool) => tool.name === "write");
      expect(writeTool).toBeDefined();

      await expect(
        writeTool?.execute("tool-structured-write", {
          path: "structured-write.js",
          content: [
            { type: "text", text: "const path = require('path');\n" },
            { type: "input_text", text: "const root = path.join(process.env.HOME, 'clawd');\n" },
          ],
        }),
      ).rejects.toThrow(/Missing required parameter: content/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects structured edit payloads", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-structured-edit-"));
    try {
      const filePath = path.join(tmpDir, "structured-edit.js");
      await fs.writeFile(filePath, "const value = 'old';\n", "utf8");

      const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
      const editTool = tools.find((tool) => tool.name === "edit");
      expect(editTool).toBeDefined();

      await expect(
        editTool?.execute("tool-structured-edit", {
          path: "structured-edit.js",
          edits: [
            {
              oldText: [{ type: "text", text: "old" }],
              newText: [{ kind: "text", value: "new" }],
            },
          ],
        }),
      ).rejects.toThrow(/Missing required parameter: edits/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
