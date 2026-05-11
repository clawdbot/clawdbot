import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationRef,
  SessionBindingAdapter,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const tempRoot = makeTrackedTempDir("openclaw-plugin-binding", tempDirs);
const approvalsPath = path.join(tempRoot, "plugin-binding-approvals.json");

const sessionBindingState = vi.hoisted(() => {
  const records = new Map<string, SessionBindingRecord>();
  let nextId = 1;

  function normalizeRef(ref: ConversationRef): ConversationRef {
    return {
      channel: ref.channel.trim().toLowerCase(),
      accountId: ref.accountId.trim() || "default",
      conversationId: ref.conversationId.trim(),
      parentConversationId: ref.parentConversationId?.trim() || undefined,
    };
  }

  function toKey(ref: ConversationRef): string {
    const normalized = normalizeRef(ref);
    return JSON.stringify(normalized);
  }

  return {
    records,
    bind: vi.fn(
      async (input: {
        targetSessionKey: string;
        targetKind: "session" | "subagent";
        conversation: ConversationRef;
        metadata?: Record<string, unknown>;
      }) => {
        const normalized = normalizeRef(input.conversation);
        const record: SessionBindingRecord = {
          bindingId: `binding-${nextId++}`,
          targetSessionKey: input.targetSessionKey,
          targetKind: input.targetKind,
          conversation: normalized,
          status: "active",
          boundAt: Date.now(),
          metadata: input.metadata,
        };
        records.set(toKey(normalized), record);
        return record;
      },
    ),
    resolveByConversation: vi.fn((ref: ConversationRef) => {
      return records.get(toKey(ref)) ?? null;
    }),
    touch: vi.fn(),
    unbind: vi.fn(async (input: { bindingId?: string }) => {
      const removed: SessionBindingRecord[] = [];
      for (const [key, record] of records.entries()) {
        if (record.bindingId !== input.bindingId) {
          continue;
        }
        removed.push(record);
        records.delete(key);
      }
      return removed;
    }),
    reset() {
      records.clear();
      nextId = 1;
      this.bind.mockClear();
      this.resolveByConversation.mockClear();
      this.touch.mockClear();
      this.unbind.mockClear();
    },
    setRecord(record: SessionBindingRecord) {
      records.set(toKey(record.conversation), record);
    },
  };
});

const pluginRuntimeState = vi.hoisted(
  () =>
    ({
      // The runtime mock is initialized before imports; beforeEach installs the real shared stub.
      registry: null as unknown as PluginRegistry,
    }) satisfies { registry: PluginRegistry },
);

vi.mock("../infra/home-dir.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/home-dir.js")>("../infra/home-dir.js");
  return {
    ...actual,
    expandHomePrefix: (value: string) => {
      if (value === "~/.openclaw/plugin-binding-approvals.json") {
        return approvalsPath;
      }
      return actual.expandHomePrefix(value);
    },
  };
});

vi.mock("./runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
  return {
    ...actual,
    getActivePluginRegistry: () => pluginRuntimeState.registry,
    getActivePluginChannelRegistry: () => pluginRuntimeState.registry,
    setActivePluginRegistry: (registry: PluginRegistry) => {
      pluginRuntimeState.registry = registry;
    },
  };
});

let __testing: typeof import("./conversation-binding.js").__testing;
let buildPluginBindingApprovalCustomId: typeof import("./conversation-binding.js").buildPluginBindingApprovalCustomId;
let detachPluginConversationBinding: typeof import("./conversation-binding.js").detachPluginConversationBinding;
let getCurrentPluginConversationBinding: typeof import("./conversation-binding.js").getCurrentPluginConversationBinding;
let parsePluginBindingApprovalCustomId: typeof import("./conversation-binding.js").parsePluginBindingApprovalCustomId;
let requestPluginConversationBinding: typeof import("./conversation-binding.js").requestPluginConversationBinding;
let resolvePluginConversationBindingApproval: typeof import("./conversation-binding.js").resolvePluginConversationBindingApproval;
let registerSessionBindingAdapter: typeof import("../infra/outbound/session-binding-service.js").registerSessionBindingAdapter;
let unregisterSessionBindingAdapter: typeof import("../infra/outbound/session-binding-service.js").unregisterSessionBindingAdapter;
let setActivePluginRegistry: typeof import("./runtime.js").setActivePluginRegistry;

type PluginBindingRequest = Awaited<ReturnType<typeof requestPluginConversationBinding>>;
type PluginBindingRequestInput = Parameters<typeof requestPluginConversationBinding>[0];
type PluginBindingDecision = Parameters<
  typeof resolvePluginConversationBindingApproval
>[0]["decision"];
type ConversationBindingModule = typeof import("./conversation-binding.js");

const conversationBindingModuleUrl = new URL("./conversation-binding.ts", import.meta.url).href;

async function importConversationBindingModule(
  cacheBust: string,
): Promise<ConversationBindingModule> {
  return (await import(
    `${conversationBindingModuleUrl}?t=${cacheBust}`
  )) as ConversationBindingModule;
}

function createAdapter(channel: string, accountId: string): SessionBindingAdapter {
  return {
    channel,
    accountId,
    capabilities: {
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    bind: sessionBindingState.bind,
    listBySession: () => [],
    resolveByConversation: sessionBindingState.resolveByConversation,
    touch: sessionBindingState.touch,
    unbind: sessionBindingState.unbind,
  };
}

afterAll(() => {
  cleanupTrackedTempDirs(tempDirs);
});

beforeAll(async () => {
  ({
    __testing,
    buildPluginBindingApprovalCustomId,
    detachPluginConversationBinding,
    getCurrentPluginConversationBinding,
    parsePluginBindingApprovalCustomId,
    requestPluginConversationBinding,
    resolvePluginConversationBindingApproval,
  } = await import("./conversation-binding.js"));
  ({ registerSessionBindingAdapter, unregisterSessionBindingAdapter } =
    await import("../infra/outbound/session-binding-service.js"));
  ({ setActivePluginRegistry } = await import("./runtime.js"));
});

function createDiscordCodexBindRequest(
  conversationId: string,
  summary: string,
  accountId = "isolated",
): PluginBindingRequestInput {
  return {
    pluginId: "codex",
    pluginName: "Codex App Server",
    pluginRoot: "/plugins/codex-a",
    requestedBySenderId: "user-1",
    conversation: {
      channel: "discord",
      accountId,
      conversationId,
    },
    binding: { summary },
  };
}

function createTelegramCodexBindRequest(
  conversationId: string,
  threadId: string,
  summary: string,
  pluginRoot = "/plugins/codex-a",
): PluginBindingRequestInput {
  return {
    pluginId: "codex",
    pluginName: "Codex App Server",
    pluginRoot,
    requestedBySenderId: "user-1",
    conversation: {
      channel: "telegram",
      accountId: "default",
      conversationId,
      parentConversationId: "-10099",
      threadId,
    },
    binding: { summary },
  };
}

function createCodexBindRequest(params: {
  channel: "discord" | "telegram";
  accountId: string;
  conversationId: string;
  summary: string;
  pluginRoot?: string;
  pluginId?: string;
  parentConversationId?: string;
  threadId?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
}) {
  return {
    pluginId: params.pluginId ?? "codex",
    pluginName: "Codex App Server",
    pluginRoot: params.pluginRoot ?? "/plugins/codex-a",
    requestedBySenderId: "user-1",
    conversation: {
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
      ...(params.parentConversationId ? { parentConversationId: params.parentConversationId } : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
    },
    binding: {
      summary: params.summary,
      ...(params.detachHint ? { detachHint: params.detachHint } : {}),
      ...(params.data ? { data: params.data } : {}),
    },
  } satisfies PluginBindingRequestInput;
}

async function requestPendingBinding(
  input: PluginBindingRequestInput,
  requestBinding = requestPluginConversationBinding,
) {
  const request = await requestBinding(input);
  expect(request.status).toBe("pending");
  if (request.status !== "pending") {
    throw new Error("expected pending bind request");
  }
  return request;
}

async function approveBindingRequest(
  approvalId: string,
  decision: PluginBindingDecision,
  resolveApproval = resolvePluginConversationBindingApproval,
) {
  return await resolveApproval({
    approvalId,
    decision,
    senderId: "user-1",
  });
}

async function importDuplicateConversationBindingModules() {
  const first = await importConversationBindingModule(`first-${Date.now()}`);
  const second = await importConversationBindingModule(`second-${Date.now()}`);
  first.__testing.reset();
  return { first, second };
}

async function resolveRequestedBinding(request: PluginBindingRequest) {
  expect(["pending", "bound"]).toContain(request.status);
  if (request.status === "pending") {
    const approved = await approveBindingRequest(request.approvalId, "allow-once");
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") {
      throw new Error("expected approved bind result");
    }
    return approved.binding;
  }
  if (request.status === "bound") {
    return request.binding;
  }
  throw new Error("expected pending or bound bind result");
}

async function requestResolvedBinding(input: PluginBindingRequestInput) {
  return await resolveRequestedBinding(await requestPluginConversationBinding(input));
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function requireMockCallArg(mock: ReturnType<typeof vi.fn>, index = 0): unknown {
  const call = mock.mock.calls[index] as [unknown] | undefined;
  if (!call) {
    throw new Error(`mock call ${index} missing`);
  }
  return call[0];
}

function createResolvedHandlerRegistry(params: {
  pluginRoot: string;
  handler: (input: unknown) => Promise<void>;
}) {
  const registry = createEmptyPluginRegistry();
  registry.conversationBindingResolvedHandlers.push({
    pluginId: "codex",
    pluginRoot: params.pluginRoot,
    handler: params.handler,
    source: `${params.pluginRoot}/index.ts`,
    rootDir: params.pluginRoot,
  });
  setActivePluginRegistry(registry);
  return registry;
}

async function expectResolutionCallback(params: {
  pluginRoot: string;
  requestInput: PluginBindingRequestInput;
  decision: PluginBindingDecision;
  expectedStatus: "approved" | "denied";
  expectCallback: (payload: unknown) => void;
}) {
  const onResolved = vi.fn(async () => undefined);
  createResolvedHandlerRegistry({
    pluginRoot: params.pluginRoot,
    handler: onResolved,
  });

  const request = await requestPluginConversationBinding(params.requestInput);
  expect(request.status).toBe("pending");
  if (request.status !== "pending") {
    throw new Error("expected pending bind request");
  }

  const result = await resolvePluginConversationBindingApproval({
    approvalId: request.approvalId,
    decision: params.decision,
    senderId: "user-1",
  });

  expect(result.status).toBe(params.expectedStatus);
  await flushMicrotasks();
  expect(onResolved).toHaveBeenCalledTimes(1);
  params.expectCallback(requireMockCallArg(onResolved));
}

async function expectResolutionDoesNotWait(params: {
  pluginRoot: string;
  requestInput: PluginBindingRequestInput;
  decision: PluginBindingDecision;
  expectedStatus: "approved" | "denied";
}) {
  const callbackGate = createDeferredVoid();
  const onResolved = vi.fn(async () => callbackGate.promise);
  createResolvedHandlerRegistry({
    pluginRoot: params.pluginRoot,
    handler: onResolved,
  });

  const request = await requestPluginConversationBinding(params.requestInput);
  expect(request.status).toBe("pending");
  if (request.status !== "pending") {
    throw new Error("expected pending bind request");
  }

  let settled = false;
  const resolutionPromise = resolvePluginConversationBindingApproval({
    approvalId: request.approvalId,
    decision: params.decision,
    senderId: "user-1",
  }).then((result) => {
    settled = true;
    return result;
  });

  await flushMicrotasks();

  expect(settled).toBe(true);
  expect(onResolved).toHaveBeenCalledTimes(1);

  callbackGate.resolve();
  const result = await resolutionPromise;
  expect(result.status).toBe(params.expectedStatus);
}

describe("plugin conversation binding approvals", () => {
  beforeEach(() => {
    sessionBindingState.reset();
    __testing.reset();
    setActivePluginRegistry(createEmptyPluginRegistry());
    fs.rmSync(approvalsPath, { force: true });
    unregisterSessionBindingAdapter({ channel: "discord", accountId: "default" });
    unregisterSessionBindingAdapter({ channel: "discord", accountId: "work" });
    unregisterSessionBindingAdapter({ channel: "discord", accountId: "isolated" });
    unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default" });
    registerSessionBindingAdapter(createAdapter("discord", "default"));
    registerSessionBindingAdapter(createAdapter("discord", "work"));
    registerSessionBindingAdapter(createAdapter("discord", "isolated"));
    registerSessionBindingAdapter(createAdapter("telegram", "default"));
  });

  it("keeps Telegram bind approval callback_data within Telegram's limit", () => {
    const allowOnce = buildPluginBindingApprovalCustomId("abcdefghijkl", "allow-once");
    const allowAlways = buildPluginBindingApprovalCustomId("abcdefghijkl", "allow-always");
    const deny = buildPluginBindingApprovalCustomId("abcdefghijkl", "deny");

    expect(Buffer.byteLength(allowOnce, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(allowAlways, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(deny, "utf8")).toBeLessThanOrEqual(64);
    expect(parsePluginBindingApprovalCustomId(allowAlways)).toEqual({
      approvalId: "abcdefghijkl",
      decision: "allow-always",
    });
  });

  it("requires a fresh approval again after allow-once is consumed", async () => {
    const firstRequest = await requestPendingBinding(
      createDiscordCodexBindRequest("channel:1", "Bind this conversation to Codex thread 123."),
    );
    const approved = await approveBindingRequest(firstRequest.approvalId, "allow-once");

    expect(approved.status).toBe("approved");

    const secondRequest = await requestPluginConversationBinding(
      createDiscordCodexBindRequest("channel:2", "Bind this conversation to Codex thread 456."),
    );

    expect(secondRequest.status).toBe("pending");
  });

  it("persists always-allow by plugin root plus channel/account only", async () => {
    const firstRequest = await requestPendingBinding(
      createDiscordCodexBindRequest("channel:1", "Bind this conversation to Codex thread 123."),
    );
    const approved = await approveBindingRequest(firstRequest.approvalId, "allow-always");

    expect(approved.status).toBe("approved");

    const sameScope = await requestPluginConversationBinding(
      createDiscordCodexBindRequest("channel:2", "Bind this conversation to Codex thread 456."),
    );

    expect(sameScope.status).toBe("bound");

    const differentAccount = await requestPluginConversationBinding(
      createDiscordCodexBindRequest(
        "channel:3",
        "Bind this conversation to Codex thread 789.",
        "work",
      ),
    );

    expect(differentAccount.status).toBe("pending");
  });

  it("shares pending bind approvals across duplicate module instances", async () => {
    const { first, second } = await importDuplicateConversationBindingModules();
    const request = await requestPendingBinding(
      createTelegramCodexBindRequest(
        "-10099:topic:77",
        "77",
        "Bind this conversation to Codex thread abc.",
      ),
      first.requestPluginConversationBinding,
    );

    const approved = await approveBindingRequest(
      request.approvalId,
      "allow-once",
      second.resolvePluginConversationBindingApproval,
    );
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") {
      throw new Error("expected approved bind result");
    }
    expect(approved.binding.pluginId).toBe("codex");
    expect(approved.binding.pluginRoot).toBe("/plugins/codex-a");
    expect(approved.binding.conversationId).toBe("-10099:topic:77");

    second.__testing.reset();
  });

  it("shares persistent approvals across duplicate module instances", async () => {
    const { first, second } = await importDuplicateConversationBindingModules();
    const request = await requestPendingBinding(
      createTelegramCodexBindRequest(
        "-10099:topic:77",
        "77",
        "Bind this conversation to Codex thread abc.",
      ),
      first.requestPluginConversationBinding,
    );

    const approved = await approveBindingRequest(
      request.approvalId,
      "allow-always",
      second.resolvePluginConversationBindingApproval,
    );
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") {
      throw new Error("expected approved bind result");
    }
    expect(approved.decision).toBe("allow-always");

    const rebound = await first.requestPluginConversationBinding(
      createTelegramCodexBindRequest(
        "-10099:topic:78",
        "78",
        "Bind this conversation to Codex thread def.",
      ),
    );

    expect(rebound.status).toBe("bound");

    first.__testing.reset();
    fs.rmSync(approvalsPath, { force: true });
  });

  it("does not share persistent approvals across plugin roots even with the same plugin id", async () => {
    const request = await requestPluginConversationBinding(
      createCodexBindRequest({
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: "77",
        summary: "Bind this conversation to Codex thread abc.",
      }),
    );

    expect(request.status).toBe("pending");
    if (request.status !== "pending") {
      throw new Error("expected pending bind request");
    }

    await resolvePluginConversationBindingApproval({
      approvalId: request.approvalId,
      decision: "allow-always",
      senderId: "user-1",
    });

    const samePluginNewPath = await requestPluginConversationBinding(
      createCodexBindRequest({
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:78",
        parentConversationId: "-10099",
        threadId: "78",
        summary: "Bind this conversation to Codex thread def.",
        pluginRoot: "/plugins/codex-b",
      }),
    );

    expect(samePluginNewPath.status).toBe("pending");
  });

  it("persists detachHint on approved plugin bindings", async () => {
    const binding = await requestResolvedBinding(
      createCodexBindRequest({
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:detach-hint",
        summary: "Bind this conversation to Codex thread 999.",
        detachHint: "/codex_detach",
      }),
    );

    expect(binding.detachHint).toBe("/codex_detach");

    const currentBinding = await getCurrentPluginConversationBinding({
      pluginRoot: "/plugins/codex-a",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:detach-hint",
      },
    });

    expect(currentBinding?.detachHint).toBe("/codex_detach");
  });

  it("persists plugin-owned binding data on approved plugin bindings", async () => {
    const data = {
      kind: "codex-app-server-session",
      version: 1,
      sessionFile: "/tmp/openclaw/session.jsonl",
      workspaceDir: "/workspace/openclaw",
    };
    const binding = await requestResolvedBinding(
      createCodexBindRequest({
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:binding-data",
        summary: "Bind this conversation to Codex thread 999.",
        data,
      }),
    );

    expect(binding.data).toEqual(data);

    const currentBinding = await getCurrentPluginConversationBinding({
      pluginRoot: "/plugins/codex-a",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:binding-data",
      },
    });

    expect(currentBinding?.data).toEqual(data);
  });

  it.each([
    {
      name: "notifies the owning plugin when a bind approval is approved",
      pluginRoot: "/plugins/callback-test",
      requestInput: {
        pluginId: "codex",
        pluginName: "Codex App Server",
        pluginRoot: "/plugins/callback-test",
        requestedBySenderId: "user-1",
        conversation: {
          channel: "discord",
          accountId: "isolated",
          conversationId: "channel:callback-test",
        },
        binding: { summary: "Bind this conversation to Codex thread abc." },
      },
      decision: "allow-once" as const,
      expectedStatus: "approved" as const,
      expectCallback: (payload: unknown) => {
        const callback = payload as {
          status: string;
          binding?: {
            pluginId: string;
            pluginRoot: string;
            conversationId: string;
          };
          decision: string;
          request: {
            summary: string;
            detachHint?: string;
            requestedBySenderId: string;
            conversation: {
              channel: string;
              accountId: string;
              conversationId: string;
            };
          };
        };
        expect(callback.status).toBe("approved");
        expect(callback.binding?.pluginId).toBe("codex");
        expect(callback.binding?.pluginRoot).toBe("/plugins/callback-test");
        expect(callback.binding?.conversationId).toBe("channel:callback-test");
        expect(callback.decision).toBe("allow-once");
        expect(callback.request.summary).toBe("Bind this conversation to Codex thread abc.");
        expect(callback.request.detachHint).toBeUndefined();
        expect(callback.request.requestedBySenderId).toBe("user-1");
        expect(callback.request.conversation).toEqual({
          channel: "discord",
          accountId: "isolated",
          conversationId: "channel:callback-test",
        });
      },
    },
    {
      name: "notifies the owning plugin when a bind approval is denied",
      pluginRoot: "/plugins/callback-deny",
      requestInput: {
        pluginId: "codex",
        pluginName: "Codex App Server",
        pluginRoot: "/plugins/callback-deny",
        requestedBySenderId: "user-1",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "8460800771",
        },
        binding: { summary: "Bind this conversation to Codex thread deny." },
      },
      decision: "deny" as const,
      expectedStatus: "denied" as const,
      expectCallback: (payload: unknown) => {
        const callback = payload as {
          status: string;
          binding?: unknown;
          decision: string;
          request: {
            summary: string;
            detachHint?: string;
            requestedBySenderId: string;
            conversation: {
              channel: string;
              accountId: string;
              conversationId: string;
            };
          };
        };
        expect(callback.status).toBe("denied");
        expect(callback.binding).toBeUndefined();
        expect(callback.decision).toBe("deny");
        expect(callback.request.summary).toBe("Bind this conversation to Codex thread deny.");
        expect(callback.request.detachHint).toBeUndefined();
        expect(callback.request.requestedBySenderId).toBe("user-1");
        expect(callback.request.conversation).toEqual({
          channel: "telegram",
          accountId: "default",
          conversationId: "8460800771",
        });
      },
    },
  ] as const)("$name", async (testCase) => {
    await expectResolutionCallback(testCase);
  });

  it.each([
    {
      name: "does not wait for an approved bind callback before returning",
      pluginRoot: "/plugins/callback-slow-approve",
      requestInput: {
        pluginId: "codex",
        pluginName: "Codex App Server",
        pluginRoot: "/plugins/callback-slow-approve",
        requestedBySenderId: "user-1",
        conversation: {
          channel: "discord",
          accountId: "isolated",
          conversationId: "channel:slow-approve",
        },
        binding: { summary: "Bind this conversation to Codex thread slow-approve." },
      },
      decision: "allow-once" as const,
      expectedStatus: "approved" as const,
    },
    {
      name: "does not wait for a denied bind callback before returning",
      pluginRoot: "/plugins/callback-slow-deny",
      requestInput: {
        pluginId: "codex",
        pluginName: "Codex App Server",
        pluginRoot: "/plugins/callback-slow-deny",
        requestedBySenderId: "user-1",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "slow-deny",
        },
        binding: { summary: "Bind this conversation to Codex thread slow-deny." },
      },
      decision: "deny" as const,
      expectedStatus: "denied" as const,
    },
  ] as const)("$name", async (testCase) => {
    await expectResolutionDoesNotWait(testCase);
  });

  it("returns and detaches only bindings owned by the requesting plugin root", async () => {
    await requestResolvedBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:1",
      },
      binding: { summary: "Bind this conversation to Codex thread 123." },
    });

    const current = await getCurrentPluginConversationBinding({
      pluginRoot: "/plugins/codex-a",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:1",
      },
    });

    expect(current?.pluginId).toBe("codex");
    expect(current?.pluginRoot).toBe("/plugins/codex-a");
    expect(current?.conversationId).toBe("channel:1");

    const otherPluginView = await getCurrentPluginConversationBinding({
      pluginRoot: "/plugins/codex-b",
      conversation: {
        channel: "discord",
        accountId: "isolated",
        conversationId: "channel:1",
      },
    });

    expect(otherPluginView).toBeNull();

    expect(
      await detachPluginConversationBinding({
        pluginRoot: "/plugins/codex-b",
        conversation: {
          channel: "discord",
          accountId: "isolated",
          conversationId: "channel:1",
        },
      }),
    ).toEqual({ removed: false });

    expect(
      await detachPluginConversationBinding({
        pluginRoot: "/plugins/codex-a",
        conversation: {
          channel: "discord",
          accountId: "isolated",
          conversationId: "channel:1",
        },
      }),
    ).toEqual({ removed: true });
  });

  it("refuses to claim a conversation already bound by core", async () => {
    sessionBindingState.setRecord({
      bindingId: "binding-core",
      targetSessionKey: "agent:main:discord:channel:1",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1",
      },
      status: "active",
      boundAt: Date.now(),
      metadata: { owner: "core" },
    });

    const result = await requestPluginConversationBinding({
      pluginId: "codex",
      pluginName: "Codex App Server",
      pluginRoot: "/plugins/codex-a",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1",
      },
      binding: { summary: "Bind this conversation to Codex thread 123." },
    });

    expect(result).toEqual({
      status: "error",
      message:
        "This conversation is already bound by core routing and cannot be claimed by a plugin.",
    });
  });

  it.each([
    {
      name: "migrates a legacy plugin binding record through the new approval flow even if the old plugin id differs",
      existingRecord: {
        bindingId: "binding-legacy",
        targetSessionKey: "plugin-binding:old-codex-plugin:legacy123",
        targetKind: "session" as const,
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-10099:topic:77",
        },
        status: "active" as const,
        metadata: {
          label: "legacy plugin bind",
        },
      },
      requestInput: createCodexBindRequest({
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: "77",
        summary: "Bind this conversation to Codex thread abc.",
      }),
      expectedBinding: {
        pluginId: "codex",
        pluginRoot: "/plugins/codex-a",
        conversationId: "-10099:topic:77",
      },
    },
    {
      name: "migrates a legacy codex thread binding session key through the new approval flow",
      existingRecord: {
        bindingId: "binding-legacy-codex-thread",
        targetSessionKey: "openclaw-app-server:thread:019ce411-6322-7db2-a821-1a61c530e7d9",
        targetKind: "session" as const,
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "8460800771",
        },
        status: "active" as const,
        metadata: {
          label: "legacy codex thread bind",
        },
      },
      requestInput: createCodexBindRequest({
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
        summary: "Bind this conversation to Codex thread 019ce411-6322-7db2-a821-1a61c530e7d9.",
        pluginId: "openclaw-codex-app-server",
      }),
      expectedBinding: {
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/codex-a",
        conversationId: "8460800771",
      },
    },
  ] as const)("$name", async ({ existingRecord, requestInput, expectedBinding }) => {
    sessionBindingState.setRecord({
      ...existingRecord,
      boundAt: Date.now(),
    });

    const request = await requestPluginConversationBinding(requestInput);
    const binding = await resolveRequestedBinding(request);

    expect(binding.pluginId).toBe(expectedBinding.pluginId);
    expect(binding.pluginRoot).toBe(expectedBinding.pluginRoot);
    expect(binding.conversationId).toBe(expectedBinding.conversationId);
  });
});
