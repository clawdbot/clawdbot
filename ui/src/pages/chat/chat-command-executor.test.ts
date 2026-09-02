// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionsListResult,
  SessionsPatchResult,
} from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { createSessionCapability, type SessionCapability } from "../../lib/sessions/index.ts";
import {
  createResolvedModelPatch,
  createModelCatalog,
  OPENAI_GPT5_MINI_MODEL,
} from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { executeSlashCommand as executeSlashCommandImpl } from "./chat-command-executor.ts";

function createTestSessionCapability(client: GatewayBrowserClient): SessionCapability {
  const sessions = createSessionCapability({
    snapshot: { client, phase: "connected", hello: sessionMutationGatewayHello() },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  const list: SessionCapability["list"] = async (options = {}) =>
    (await client.request<SessionsListResult | undefined>("sessions.list", options)) ?? null;
  const patch: SessionCapability["patch"] = async (key, sessionPatch, options) =>
    await client.request<SessionsPatchResult>("sessions.patch", {
      key,
      ...(options?.agentId ? { agentId: options.agentId } : {}),
      ...sessionPatch,
    });
  return Object.assign(sessions, { list, patch });
}

function executeSlashCommand(
  client: GatewayBrowserClient,
  sessionKey: string,
  commandName: string,
  args: string,
  context: Omit<
    Parameters<typeof executeSlashCommandImpl>[4],
    "sessionAccessSnapshot" | "sessions"
  > & {
    sessionAccessSnapshot?: Parameters<typeof executeSlashCommandImpl>[4]["sessionAccessSnapshot"];
  } = {},
) {
  const {
    sessionAccessSnapshot = {
      client,
      hello: sessionMutationGatewayHello(),
      phase: "connected",
    },
    ...rest
  } = context;
  return executeSlashCommandImpl(client, sessionKey, commandName, args, {
    sessions: createTestSessionCapability(client),
    ...rest,
    sessionAccessSnapshot,
  });
}

function restrictedSnapshot(
  client: GatewayBrowserClient,
  methods: string[],
  scopes = ["operator.read"],
): Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> {
  return {
    client,
    phase: "connected",
    hello: {
      auth: { role: "operator", scopes },
      features: { methods },
    } as ApplicationGatewaySnapshot["hello"],
  };
}

function row(key: string, overrides?: Partial<GatewaySessionRow>): GatewaySessionRow {
  const active = overrides?.status === "running" || overrides?.hasActiveRun === true;
  return {
    key,
    spawnedBy: overrides?.spawnedBy,
    kind: "direct",
    updatedAt: null,
    ...(active
      ? {
          hasActiveRun: true,
          activeRunIds: ["active-run"],
          activeLeafEntryId: "leaf-active",
        }
      : {}),
    ...overrides,
  };
}

function createSessionsResult(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function requireRequestCall(
  request: ReturnType<typeof vi.fn>,
  method: string,
): { method: string; payload: Record<string, unknown> } {
  const call = request.mock.calls.find(([calledMethod]) => calledMethod === method);
  if (!call) {
    throw new Error(`expected ${method} request`);
  }
  return { method: call[0] as string, payload: call[1] as Record<string, unknown> };
}

function expectNoRequestCall(request: ReturnType<typeof vi.fn>, method: string) {
  expect(request.mock.calls.some(([calledMethod]) => calledMethod === method)).toBe(false);
}

describe("executeSlashCommand directives", () => {
  it("lets the canonical row retire a slash-command selection equal to the default", async () => {
    const key = "agent:main:main";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("gpt-5-mini", "openai");
      }
      if (method === "sessions.list") {
        return createSessionsResult([
          row(key, {
            model: "gpt-5-mini",
            modelProvider: "openai",
            modelOverrideSource: null,
          }),
        ]);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = createTestGatewayClient(request);
    const snapshot = { client, phase: "connected" as const, hello: sessionMutationGatewayHello() };
    const sessions = createSessionCapability({
      snapshot,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });
    const result = await executeSlashCommandImpl(client, key, "model", "openai/gpt-5-mini", {
      sessions,
      sessionAccessSnapshot: snapshot,
      chatModelCatalog: createModelCatalog(OPENAI_GPT5_MINI_MODEL),
    });
    expect(result.failed).not.toBe(true);
    expect(sessions.state.result?.sessions[0]?.modelOverrideSource).toBeNull();
    expect(sessions.state.modelOverrides).toEqual({});
    sessions.dispose();
  });

  it("does not compact a session without operator.admin", async () => {
    const request = vi.fn();
    const client = createTestGatewayClient(request);

    const result = await executeSlashCommand(client, "main", "compact", "", {
      sessionAccessSnapshot: restrictedSnapshot(client, ["sessions.compact"]),
    });

    expect(result.failed).toBe(true);
    expectNoRequestCall(request, "sessions.compact");
  });

  it.each([
    { name: "allows /model with operator.write", scopes: ["operator.write"], allowed: true },
    { name: "rejects /model without operator.write", scopes: ["operator.read"], allowed: false },
  ])("$name", async ({ scopes, allowed }) => {
    const request = vi.fn(async () => createResolvedModelPatch("gpt-5-mini", "openai"));
    const client = createTestGatewayClient(request);

    const result = await executeSlashCommand(client, "main", "model", "gpt-5-mini", {
      sessionAccessSnapshot: restrictedSnapshot(client, ["sessions.patch"], scopes),
      chatModelCatalog: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
    });

    expect(result.failed === true).toBe(!allowed);
    if (allowed) {
      expect(requireRequestCall(request, "sessions.patch").payload).toMatchObject({
        key: "main",
        model: "gpt-5-mini",
      });
    } else {
      expectNoRequestCall(request, "sessions.patch");
    }
  });

  it("passes the captured chat owner to canonical model patching", async () => {
    const client = createTestGatewayClient(vi.fn());
    const patch = vi
      .fn()
      .mockResolvedValue(
        createResolvedModelPatch(OPENAI_GPT5_MINI_MODEL.id, OPENAI_GPT5_MINI_MODEL.provider),
      );
    const ownsModelOverride = vi.fn(() => true);
    const sessions = {
      ...createTestSessionCapability(client),
      patch,
    } as SessionCapability;

    const result = await executeSlashCommandImpl(client, "global", "model", "gpt-5-mini", {
      sessions,
      sessionAccessSnapshot: {
        client,
        hello: sessionMutationGatewayHello(),
        phase: "connected",
      },
      agentId: "work",
      ownsModelOverride,
      chatModelCatalog: createModelCatalog(OPENAI_GPT5_MINI_MODEL),
    });

    expect(result.failed).not.toBe(true);
    expect(patch).toHaveBeenCalledWith(
      "global",
      { model: "gpt-5-mini" },
      expect.objectContaining({
        agentId: "work",
        ownsModelOverride,
      }),
    );
  });

  it("does not patch through a replacement connection after loading session state", async () => {
    let resolveList: ((value: SessionsListResult) => void) | undefined;
    const listResult = new Promise<SessionsListResult>((resolve) => {
      resolveList = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return await listResult;
      }
      if (method === "sessions.patch") {
        return { ok: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = createTestGatewayClient(request);
    let current = true;

    const pending = executeSlashCommand(client, "agent:main:main", "think", "high", {
      isCurrent: () => current,
    });
    current = false;
    resolveList?.(
      createSessionsResult([
        row("agent:main:main", {
          thinkingOptions: ["off", "low", "high"],
        }),
      ]),
    );

    const result = await pending;
    expect(result.failed).toBe(true);
    expectNoRequestCall(request, "sessions.patch");
  });

  it("rechecks live scopes before patching after loading session state", async () => {
    let resolveList: ((value: SessionsListResult) => void) | undefined;
    const listResult = new Promise<SessionsListResult>((resolve) => {
      resolveList = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return await listResult;
      }
      if (method === "sessions.patch") {
        return { ok: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = createTestGatewayClient(request);
    let snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> = {
      client,
      phase: "connected" as const,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["sessions.patch"] },
      } as ApplicationGatewaySnapshot["hello"],
    };

    const pending = executeSlashCommand(client, "agent:main:main", "think", "high", {
      sessionAccessSnapshot: snapshot,
      readSessionAccessSnapshot: () => snapshot,
      isCurrent: () => true,
    });
    snapshot = restrictedSnapshot(client, ["sessions.patch"]);
    resolveList?.(
      createSessionsResult([
        row("agent:main:main", {
          thinkingOptions: ["off", "low", "high"],
        }),
      ]),
    );

    const result = await pending;
    expect(result.failed).toBe(true);
    expectNoRequestCall(request, "sessions.patch");
  });

  it("resolves the legacy main alias for bare /model", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: { modelProvider: "openai", model: "default-model" },
          sessions: [
            row("agent:main:main", {
              model: "gpt-4.1-mini",
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-4.1-mini" }, { id: "gpt-4.1" }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(createTestGatewayClient(request), "main", "model", "");

    expect(result.content).toBe(
      [
        t("chat.commandResults.model.current", { model: "`gpt-4.1-mini`" }),
        t("chat.commandResults.model.available", {
          models: "`gpt-4.1-mini`, `gpt-4.1`",
          remaining: "",
        }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "models.list", {
      agentId: "main",
      view: "configured",
    });
  });

  it("omits unavailable catalog entries from bare /model output", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          defaults: { modelProvider: "openai", model: "gpt-5.5" },
          sessions: [row("main", { model: "gpt-5.5", modelProvider: "openai" })],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "main",
      "model",
      "",
      {
        chatModelCatalog: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            provider: "openai",
            available: true,
          },
          {
            id: "gpt-5.3-codex-spark",
            name: "GPT-5.3 Codex Spark",
            provider: "codex",
            available: false,
          },
        ],
      },
    );

    expect(result.content).toBe(
      [
        t("chat.commandResults.model.current", { model: "`gpt-5.5`" }),
        t("chat.commandResults.model.available", { models: "`gpt-5.5`", remaining: "" }),
      ].join("\n"),
    );
    expectNoRequestCall(request, "models.list");
  });

  it("scopes bare /model session reads to the selected agent", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          defaults: { modelProvider: "openai", model: "work-default" },
          sessions: [
            row("agent:work:main", {
              model: "work-model",
              modelProvider: "openai",
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "work-model", name: "Work Model", provider: "openai" }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:work:main",
      "model",
      "",
      {
        agentId: "work",
      },
    );

    expect(result.content).toContain(
      t("chat.commandResults.model.current", { model: "`work-model`" }),
    );
    expect(request).toHaveBeenCalledWith("sessions.list", { agentId: "work" });
    expect(request).toHaveBeenCalledWith("models.list", {
      agentId: "work",
      view: "configured",
    });
  });

  it("does not report global model defaults for an agent without a session row", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          defaults: { modelProvider: "anthropic", model: "global-default" },
          sessions: [],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:work:main",
      "model",
      "",
      {
        agentId: "work",
        chatModelCatalog: [
          { id: "work-model", name: "Work Model", provider: "openai", available: true },
        ],
      },
    );

    expect(result.content).toBe(
      [
        t("chat.commandResults.model.current", { model: "`default`" }),
        t("chat.commandResults.model.available", { models: "`work-model`", remaining: "" }),
      ].join("\n"),
    );
  });

  it("reports global model defaults for a configured default agent", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          defaults: { modelProvider: "openai", model: "work-default" },
          sessions: [],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:work:main",
      "model",
      "",
      {
        agentId: "work",
        defaultAgentId: "work",
        chatModelCatalog: [
          { id: "work-default", name: "Work Default", provider: "openai", available: true },
        ],
      },
    );

    expect(result.content).toBe(
      [
        t("chat.commandResults.model.current", { model: "`work-default`" }),
        t("chat.commandResults.model.available", {
          models: "`work-default`",
          remaining: "",
        }),
      ].join("\n"),
    );
  });

  it("uses a matching cached agent row when the scoped model list is temporarily empty", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          defaults: { modelProvider: "anthropic", model: "global-default" },
          sessions: [],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const sessionsResult: SessionsListResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: {
        modelProvider: "anthropic",
        model: "global-default",
        contextTokens: null,
      },
      sessions: [
        row("agent:work:main", {
          model: "work-model",
          modelProvider: "openai",
        }),
      ],
    };

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:work:main",
      "model",
      "",
      {
        agentId: "work",
        chatModelCatalog: [
          { id: "work-model", name: "Work Model", provider: "openai", available: true },
        ],
        sessionsResult,
        sessionsResultAgentId: "work",
      },
    );

    expect(result.content).toContain(
      t("chat.commandResults.model.current", { model: "`work-model`" }),
    );
  });

  it.each(["gpt-5-mini", "openai/gpt-5-mini", "nvidia/moonshotai/kimi-k2.5"])(
    "patches %s without rebuilding a second model cache",
    async (model) => {
      const request = vi.fn(async (method: string, _payload?: unknown) => {
        if (method === "sessions.patch") {
          return createResolvedModelPatch("gpt-5-mini", "openai");
        }
        throw new Error(`unexpected method: ${method}`);
      });

      const result = await executeSlashCommand(
        createTestGatewayClient(request),
        "main",
        "model",
        model,
      );

      expect(request).toHaveBeenCalledWith("sessions.patch", {
        key: "main",
        model,
      });
      expect(result.modelChanged).toBe(true);
      expectNoRequestCall(request, "models.list");
    },
  );

  it("passes selected-agent scope for global model changes", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("gpt-5-mini", "openai");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await executeSlashCommand(createTestGatewayClient(request), "global", "model", "gpt-5-mini", {
      agentId: "work",
      chatModelCatalog: [{ id: "gpt-5-mini", name: "gpt-5-mini", provider: "openai" }],
    });

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "global",
      agentId: "work",
      model: "gpt-5-mini",
    });
  });

  it("refreshes successful compaction without a duplicate command message", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.compact") {
        return { ok: true, compacted: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "global",
      "compact",
      "",
      {
        agentId: "work",
      },
    );
    expect(result).toEqual({ action: "refresh" });

    expect(request).toHaveBeenCalledWith("sessions.compact", {
      key: "global",
      agentId: "work",
    });
  });

  it("surfaces terminal compaction failures instead of reporting a skip", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.compact") {
        return {
          ok: false,
          compacted: false,
          reason: "codex app-server compaction timed out",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "main",
      "compact",
      "",
    );

    expect(result).toEqual({
      content: t("chat.commandResults.compaction.failedWithReason", {
        reason: "codex app-server compaction timed out",
      }),
      failed: true,
    });
  });

  it("resolves the legacy main alias for /usage", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              model: "gpt-4.1-mini",
              inputTokens: 1200,
              outputTokens: 300,
              totalTokens: 1500,
              contextTokens: 4000,
            }),
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(createTestGatewayClient(request), "main", "usage", "");

    expect(result.content).toBe(
      [
        `**${t("chat.commandResults.usage.title")}**`,
        t("chat.commandResults.usage.inputTokens", { count: "**1.2k**" }),
        t("chat.commandResults.usage.outputTokens", { count: "**300**" }),
        t("chat.commandResults.usage.totalTokens", { count: "**1.5k**" }),
        t("chat.commandResults.usage.context", { percent: "**38%**", total: "4k" }),
        t("chat.commandResults.usage.model", { model: "`gpt-4.1-mini`" }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("keeps /usage context hidden when the context snapshot is stale", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              model: "gpt-4.1-mini",
              inputTokens: 1200,
              outputTokens: 300,
              totalTokens: 1500,
              totalTokensFresh: false,
              contextTokens: 4000,
            }),
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "usage",
      "",
    );

    expect(result.content).toBe(
      [
        `**${t("chat.commandResults.usage.title")}**`,
        t("chat.commandResults.usage.inputTokens", { count: "**1.2k**" }),
        t("chat.commandResults.usage.outputTokens", { count: "**300**" }),
        t("chat.commandResults.usage.totalTokens", { count: "**~1.5k**" }),
        t("chat.commandResults.usage.model", { model: "`gpt-4.1-mini`" }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("uses the context snapshot for /usage while preserving cumulative total display", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              model: "gpt-4.1-mini",
              inputTokens: 1200,
              outputTokens: 300,
              totalTokens: 1250,
              contextTokens: 4000,
            }),
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "usage",
      "",
    );

    expect(result.content).toBe(
      [
        `**${t("chat.commandResults.usage.title")}**`,
        t("chat.commandResults.usage.inputTokens", { count: "**1.2k**" }),
        t("chat.commandResults.usage.outputTokens", { count: "**300**" }),
        t("chat.commandResults.usage.totalTokens", { count: "**1.5k**" }),
        t("chat.commandResults.usage.context", { percent: "**31%**", total: "4k" }),
        t("chat.commandResults.usage.model", { model: "`gpt-4.1-mini`" }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("reports the current thinking level for bare /think", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              modelProvider: "openai",
              model: "gpt-4.1-mini",
            }),
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "",
      {
        chatModelCatalog: [
          {
            id: "gpt-4.1-mini",
            name: "GPT-4.1 Mini",
            provider: "openai",
            reasoning: true,
          },
        ],
      },
    );

    expect(result.content).toBe(
      [
        t("chat.commandResults.thinking.current", { level: "low" }),
        t("chat.commandResults.options", {
          options: "default, off, minimal, low, medium, high",
        }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", { agentId: "main" });
    expectNoRequestCall(request, "models.list");
  });

  it("scopes bare /think session reads to the selected agent", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:work:main", {
              modelProvider: "openai",
              model: "work-model",
            }),
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await executeSlashCommand(createTestGatewayClient(request), "agent:work:main", "think", "", {
      agentId: "work",
      chatModelCatalog: [
        {
          id: "work-model",
          name: "Work Model",
          provider: "openai",
          reasoning: true,
        },
      ],
    });

    expect(request).toHaveBeenCalledWith("sessions.list", { agentId: "work" });
  });

  it("does not report global thinking defaults for an agent without a session row", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          defaults: {
            modelProvider: "anthropic",
            model: "global-default",
            thinkingDefault: "high",
            thinkingOptions: ["off", "high", "xhigh"],
          },
          sessions: [],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:work:main",
      "think",
      "",
      {
        agentId: "work",
        chatModelCatalog: [
          { id: "work-model", name: "Work Model", provider: "openai", reasoning: true },
        ],
      },
    );

    expect(result.content).toBe(
      [
        t("chat.commandResults.thinking.current", { level: "off" }),
        t("chat.commandResults.options", {
          options: "default, off, minimal, low, medium, high",
        }),
      ].join("\n"),
    );
  });

  it("reports global thinking defaults for a configured default agent", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          defaults: {
            modelProvider: "openai",
            model: "work-default",
            thinkingDefault: "high",
            thinkingOptions: ["off", "low", "high"],
          },
          sessions: [],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:work:main",
      "think",
      "",
      {
        agentId: "work",
        defaultAgentId: "work",
        chatModelCatalog: [
          { id: "work-default", name: "Work Default", provider: "openai", reasoning: true },
        ],
      },
    );

    expect(result.content).toBe(
      [
        t("chat.commandResults.thinking.current", { level: "high" }),
        t("chat.commandResults.options", { options: "default, off, low, high" }),
      ].join("\n"),
    );
  });

  it("accepts minimal and xhigh thinking levels", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              thinkingOptions: ["off", "minimal", "low", "medium", "high", "xhigh"],
            }),
          ],
        };
      }
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const minimal = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "minimal",
    );
    const xhigh = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "xhigh",
    );

    expect(minimal.content).toBe(t("chat.commandResults.thinking.set", { level: "**minimal**" }));
    expect(xhigh.content).toBe(t("chat.commandResults.thinking.set", { level: "**xhigh**" }));
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", { agentId: "main" });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "minimal",
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.list", { agentId: "main" });
    expect(request).toHaveBeenNthCalledWith(4, "sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "xhigh",
    });
  });

  it("accepts a thinking level advertised only by the active model catalog", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              model: "gpt-5.6-sol",
              modelProvider: "openai",
            }),
          ],
        };
      }
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "ultra",
      {
        chatModelCatalog: [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            provider: "openai",
            reasoning: true,
            thinkingLevels: [{ id: "ultra", label: "ultra" }],
          },
        ],
      },
    );

    expect(result.content).toBe(t("chat.commandResults.thinking.set", { level: "**ultra**" }));
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "ultra",
    });
    expectNoRequestCall(request, "models.list");
  });

  it("clears thinking override for /think default", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "default",
    );

    expect(result.content).toBe(t("chat.commandResults.thinking.reset"));
    expect(result.action).toBe("refresh");
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: null,
    });
  });

  it("uses default thinking options when the active session is absent", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: {
            modelProvider: "openai",
            model: "gpt-5.5",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "minimal", label: "minimal" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "adaptive", label: "adaptive" },
              { id: "high", label: "high" },
              { id: "xhigh", label: "xhigh" },
              { id: "max", label: "maximum" },
            ],
            thinkingOptions: [
              "off",
              "minimal",
              "low",
              "medium",
              "adaptive",
              "high",
              "xhigh",
              "maximum",
            ],
            thinkingDefault: "adaptive",
          },
          sessions: [],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-5.5", provider: "openai", reasoning: true }],
        };
      }
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const status = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "",
    );
    const setXhigh = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "xhigh",
    );
    const setMax = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "max",
    );
    const setMaximum = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "maximum",
    );
    const setAdaptive = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "auto",
    );

    expect(status.content).toBe(
      [
        t("chat.commandResults.thinking.current", { level: "adaptive" }),
        t("chat.commandResults.options", {
          options: "default, off, minimal, low, medium, adaptive, high, xhigh, maximum",
        }),
      ].join("\n"),
    );
    expect(setXhigh.content).toBe(t("chat.commandResults.thinking.set", { level: "**xhigh**" }));
    expect(setMax.content).toBe(t("chat.commandResults.thinking.set", { level: "**max**" }));
    expect(setMaximum.content).toBe(t("chat.commandResults.thinking.set", { level: "**max**" }));
    expect(setAdaptive.content).toBe(
      t("chat.commandResults.thinking.set", { level: "**adaptive**" }),
    );
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "xhigh",
    });
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "max",
    });
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "adaptive",
    });
  });

  it("prefers session model over defaults when models differ (#76482)", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: {
            modelProvider: "anthropic",
            model: "claude-sonnet-4-6",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "minimal", label: "minimal" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
            thinkingOptions: ["off", "minimal", "low", "medium", "high"],
            thinkingDefault: "off",
          },
          sessions: [
            row("agent:main:main", {
              modelProvider: "deepseek",
              model: "deepseek-v4-pro",
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "minimal", label: "minimal" },
                { id: "low", label: "low" },
                { id: "medium", label: "medium" },
                { id: "high", label: "high" },
                { id: "xhigh", label: "xhigh" },
                { id: "max", label: "max" },
              ],
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "deepseek-v4-pro", provider: "deepseek", reasoning: true }],
        };
      }
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const status = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "",
    );
    const setMax = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "max",
    );

    expect(status.content).toBe(
      [
        t("chat.commandResults.thinking.current", { level: "low" }),
        t("chat.commandResults.options", {
          options: "default, off, minimal, low, medium, high, xhigh, max",
        }),
      ].join("\n"),
    );
    expect(setMax.content).toBe(t("chat.commandResults.thinking.set", { level: "**max**" }));
  });

  it("does not use extended defaults for session with different model when thinkingLevels is empty (#76482)", async () => {
    // Regression: when session model differs from defaults and session has no thinkingLevels,
    // we should NOT blindly use defaults (which could have extra levels like xhigh/max
    // from a different model). The client-side fallback uses the base thinking levels.
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: {
            modelProvider: "deepseek",
            model: "deepseek-v4-pro",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "minimal", label: "minimal" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
              { id: "xhigh", label: "xhigh" },
              { id: "max", label: "max" },
            ],
            thinkingOptions: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
            thinkingDefault: "high",
          },
          sessions: [
            row("agent:main:main", {
              modelProvider: "anthropic",
              model: "claude-sonnet-4-6",
              // thinkingLevels intentionally absent — lightweight row
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "claude-sonnet-4-6", provider: "anthropic", reasoning: true }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const status = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "",
    );

    expect(status.content).toBe(
      [
        t("chat.commandResults.thinking.current", { level: "low" }),
        t("chat.commandResults.options", {
          options: "default, off, minimal, low, medium, high",
        }),
      ].join("\n"),
    );
  });

  it("does not report global thinkingDefault for a session with a different model", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: {
            modelProvider: "minimax",
            model: "MiniMax-M2.7",
            thinkingDefault: "off",
          },
          sessions: [
            row("agent:main:main", {
              modelProvider: "deepseek",
              model: "deepseek-v4-flash",
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "deepseek-v4-flash", provider: "deepseek", reasoning: true }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const status = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "",
    );

    expect(status.content).toBe(
      [
        t("chat.commandResults.thinking.current", { level: "low" }),
        t("chat.commandResults.options", {
          options: "default, off, minimal, low, medium, high",
        }),
      ].join("\n"),
    );
  });

  it("reports the current verbose level for bare /verbose", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [row("agent:main:main", { verboseLevel: "full" })],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "verbose",
      "",
    );

    expect(result.content).toBe(
      [
        t("chat.commandResults.verbose.current", { level: "full" }),
        t("chat.commandResults.options", { options: "on, full, off" }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", { agentId: "main" });
  });

  it("reports the current fast mode for bare /fast", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [row("agent:main:main", { fastMode: true })],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "",
    );

    expect(result.content).toBe(
      [
        `${t("chat.commandResults.fast.current", {
          value: t("chat.commandResults.fast.on"),
        })}.`,
        t("chat.commandResults.options", {
          options: t("chat.commandResults.fast.options", { seconds: "60" }),
        }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", { agentId: "main" });
  });

  it("reports auto fast mode for bare /fast", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [row("agent:main:main", { fastMode: "auto" })],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "",
    );

    expect(result.content).toBe(
      [
        `${t("chat.commandResults.fast.current", {
          value: t("chat.commandResults.fast.autoValue", { seconds: "60" }),
        })}.`,
        t("chat.commandResults.options", {
          options: t("chat.commandResults.fast.options", { seconds: "60" }),
        }),
      ].join("\n"),
    );
  });

  it("reports effective model-default auto fast mode for bare /fast", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              effectiveFastMode: "auto",
              effectiveFastModeSource: "config",
              fastAutoOnSeconds: 30,
            }),
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "",
    );

    expect(result.content).toBe(
      [
        `${t("chat.commandResults.fast.current", {
          value: t("chat.commandResults.fast.autoValue", { seconds: "30" }),
        })}${t("chat.commandResults.fast.sourceModel")}.`,
        t("chat.commandResults.options", {
          options: t("chat.commandResults.fast.options", { seconds: "30" }),
        }),
      ].join("\n"),
    );
  });

  it("patches fast mode for /fast on", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "on",
    );

    expect(result.content).toBe(t("chat.commandResults.fast.enabled"));
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      fastMode: true,
    });
  });

  it("patches fast mode for /fast auto", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "auto",
    );

    expect(result.content).toBe(t("chat.commandResults.fast.setAuto"));
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      fastMode: "auto",
    });
  });

  it("clears fast mode override for /fast default", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "default",
    );

    expect(result.content).toBe(t("chat.commandResults.fast.reset"));
    expect(result.action).toBe("refresh");
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      fastMode: null,
    });
  });
});

describe("executeSlashCommand /steer (soft inject)", () => {
  it("sends the selected session without resolving a run or leaf", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started", runId: "run-1" };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "steer",
      "try a different approach",
    );

    expect(result.content).toBe(t("chat.commandResults.steer.succeeded"));
    expect(result.pendingCurrentRun).toBe(true);
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload).toMatchObject({
      sessionKey: "agent:main:main",
      message: "try a different approach",
      deliver: false,
      queueMode: "steer",
      idempotencyKey: expect.any(String),
    });
    expect(chatSend.payload).not.toHaveProperty("expectedRunId");
    expect(chatSend.payload).not.toHaveProperty("expectedLeafEntryId");
    expectNoRequestCall(request, "sessions.list");
  });

  it("does not mark the current run pending when chat.send returns terminal ok", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main", { status: "running" })] };
      }
      if (method === "chat.send") {
        return { status: "ok", runId: "run-ok", messageSeq: 2 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "steer",
      "try a different approach",
    );

    expect(result.content).toBe(t("chat.commandResults.steer.succeeded"));
    expect(result.pendingCurrentRun).toBeUndefined();
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload.deliver).toBe(false);
  });

  it.each([
    ["timeout", "chat.commandResults.steer.timeout"],
    ["error", "chat.commandResults.steer.failed"],
  ] as const)(
    "reports terminal %s ACK without marking the current run pending",
    async (status, expectedKey) => {
      const request = vi.fn(async (method: string, _payload?: unknown) => {
        if (method === "chat.send") {
          return { status, runId: `run-${status}`, summary: "aborted" };
        }
        throw new Error(`unexpected method: ${method}`);
      });

      const result = await executeSlashCommand(
        createTestGatewayClient(request),
        "agent:main:main",
        "steer",
        "try a different approach",
      );

      expect(result.content).toBe(t(expectedKey));
      expect(result.content).not.toBe(t("chat.commandResults.steer.succeeded"));
      expect(result.pendingCurrentRun).toBeUndefined();
      const chatSend = requireRequestCall(request, "chat.send");
      expect(chatSend.payload.deliver).toBe(false);
    },
  );

  it("passes selected-agent scope when steering the selected global session", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "chat.send") {
        return { status: "started", runId: "run-global", messageSeq: 2 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "global",
      "steer",
      "try a different approach",
      { agentId: "work" },
    );

    expect(result.content).toBe(t("chat.commandResults.steer.succeeded"));
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload).toMatchObject({
      sessionKey: "global",
      agentId: "work",
      message: "try a different approach",
      deliver: false,
    });
  });

  it("returns steer usage when no message is provided", async () => {
    const request = vi.fn();

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "steer",
      "",
    );

    expect(result.content).toBe(t("chat.commandResults.steer.usage"));
    expect(request).not.toHaveBeenCalled();
  });

  it("returns steer error message on RPC failure", async () => {
    const request = vi.fn(async () => {
      throw new Error("connection lost");
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "steer",
      "try again",
    );

    expect(result.content).toBe(
      t("chat.commandResults.steer.requestFailed", { error: "connection lost" }),
    );
  });
});

describe("executeSlashCommand /redirect (hard kill-and-restart)", () => {
  it("calls chat.send interrupt to abort and restart the current session", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main")] };
      }
      if (method === "chat.send") {
        return { status: "started", runId: "run-1", messageSeq: 2, interruptedActiveRun: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "redirect",
      "start over with a new plan",
    );

    expect(result.content).toBe(t("chat.commandResults.redirect.succeeded"));
    expect(result.trackRunId).toBe("run-1");
    expect(request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "agent:main:main",
      message: "start over with a new plan",
      queueMode: "interrupt",
      idempotencyKey: expect.any(String),
    });
  });

  it("does not track a pending run when chat.send returns terminal ok", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "chat.send") {
        return { status: "ok", runId: "run-ok", messageSeq: 2 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "redirect",
      "start over with a new plan",
    );

    expect(result.content).toBe(t("chat.commandResults.redirect.succeeded"));
    expect(result.trackRunId).toBeUndefined();
  });

  it.each([
    ["timeout", "chat.commandResults.redirect.timeout"],
    ["error", "chat.commandResults.redirect.failed"],
  ] as const)("reports terminal %s ACK from chat.send", async (status, expectedKey) => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "chat.send") {
        return { status, runId: `run-${status}`, summary: "aborted" };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "redirect",
      "start over with a new plan",
    );

    expect(result.content).toBe(t(expectedKey));
    expect(result.trackRunId).toBeUndefined();
  });

  it("passes selected-agent scope when redirecting the selected global session", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "chat.send") {
        return { status: "started", runId: "run-global", messageSeq: 2 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "global",
      "redirect",
      "start over",
      { agentId: "work" },
    );

    expect(result.content).toBe(t("chat.commandResults.redirect.succeeded"));
    expect(result.trackRunId).toBe("run-global");
    expect(request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "global",
      agentId: "work",
      message: "start over",
      queueMode: "interrupt",
      idempotencyKey: expect.any(String),
    });
  });

  it("treats subagent-looking redirect prefixes as current-session message text", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "chat.send") {
        return { status: "started", runId: "run-3", messageSeq: 1 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "redirect",
      "researcher start over completely",
    );

    expect(result.content).toBe(t("chat.commandResults.redirect.succeeded"));
    expect(result.trackRunId).toBe("run-3");
    expect(request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "agent:main:main",
      message: "researcher start over completely",
      queueMode: "interrupt",
      idempotencyKey: expect.any(String),
    });
  });

  it("returns redirect usage when no message is provided", async () => {
    const request = vi.fn();

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "redirect",
      "",
    );

    expect(result.content).toBe(t("chat.commandResults.redirect.usage"));
    expect(request).not.toHaveBeenCalled();
  });

  it("returns redirect error message on RPC failure", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main")] };
      }
      throw new Error("connection lost");
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "redirect",
      "try again",
    );

    expect(result.content).toBe(
      t("chat.commandResults.redirect.requestFailed", { error: "connection lost" }),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
