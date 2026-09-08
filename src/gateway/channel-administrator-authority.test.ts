import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import type { CronJob, CronJobCreate } from "../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import {
  admitChannelAdministratorRequest,
  createChannelAdministratorAuthority,
  getChannelAdministratorRequestAuthority,
  mintChannelAdministratorGrant,
} from "./channel-administrator-authority.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry, type GatewayMethodRegistry } from "./methods/registry.js";
import { coreGatewayHandlers, handleGatewayRequest } from "./server-methods.js";
import {
  readCronCallerScope,
  cronCreateMatchesCallerScope,
  applyCronCreateCallerScopeDefault,
  resolveCronScheduledToolPolicyForCaller,
} from "./server-methods/cron-caller-scope.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "./server-methods/types.js";

afterEach(() => {
  vi.useRealTimers();
  resetAgentRunRegistryForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

function fixture() {
  const { operationalRunInstance } = createTestAdmittedRunContext("discord-admin-run");
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const lifetime = new AbortController();
  let permitted = true;
  const capability = createChannelAdministratorAuthority(
    operationalRunInstance.runId,
    lifetime.signal,
    () => {
      if (!permitted) {
        throw new Error("grant revoked");
      }
    },
  );
  onTestFinished(() => lifetime.abort());
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:discord:channel:234567890123456789",
    operationalRunInstance,
    delegatedAuthority: { ...authority, kind: "local" },
    turnSourceChannel: "discord",
    turnSourceAccountId: "default",
  };
  const client: GatewayClient = {
    connId: "test-discord-administrator",
    connect: {
      role: "operator",
      scopes: ["operator.read"],
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", version: "1", platform: "test", mode: "test" },
    },
    internal: { agentRuntimeIdentity: identity },
  } as GatewayClient;
  return {
    authority,
    capability,
    identity,
    client,
    lifetime,
    revoke: () => {
      permitted = false;
    },
    mint: (method = "cron.get", signal?: AbortSignal) =>
      mintChannelAdministratorGrant(capability, authority, method, signal),
  };
}

describe("trusted channel administrator request grants", () => {
  it("does not accept a copied public capability or owner/source metadata", () => {
    const f = fixture();
    expect(() =>
      mintChannelAdministratorGrant({ ...f.capability }, f.authority, "cron.get"),
    ).toThrow();
    expect(admitChannelAdministratorRequest(f.client, "cron.get")).toBeUndefined();
    expect(readCronCallerScope(f.client)?.manageAll).toBeUndefined();
  });

  it("grants administrator scope only to the admitted request, preserving external provenance", () => {
    const f = fixture();
    f.identity.channelAdministratorGrant = f.mint();
    const admitted = admitChannelAdministratorRequest(f.client, "cron.get")!;
    expect(admitted.client.connect.scopes).toContain("operator.admin");
    expect(f.client.connect.scopes).toEqual(["operator.read"]);
    expect(admitted.client.internal?.agentRuntimeIdentity).toBe(f.identity);
    expect(admitted.client.internal?.isLocalClient).not.toBe(true);
    expect(admitted.client.internal?.controlUiAdmin).not.toBe(true);
    expect(admitted.client.authenticatedUserProfile).toBeUndefined();
    expect(readCronCallerScope(admitted.client)?.manageAll).toEqual(expect.any(Function));
    expect(getChannelAdministratorRequestAuthority({ ...admitted.client })).toBeUndefined();
    expect(() => admitChannelAdministratorRequest(f.client, "cron.get")).toThrow();
  });

  it("allows an explicit cross-agent automation target without giving its scheduled run administrator authority", () => {
    const f = fixture();
    f.identity.channelAdministratorGrant = f.mint("cron.add");
    const client = admitChannelAdministratorRequest(f.client, "cron.add")!.client;
    const callerScope = readCronCallerScope(client)!;
    const job: CronJobCreate = {
      agentId: "research",
      name: "research update",
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "Summarize the research." },
    };
    expect(cronCreateMatchesCallerScope({ job, callerScope })).toBe(true);
    expect(cronCreateMatchesCallerScope({ job, callerScope: readCronCallerScope(f.client) })).toBe(
      false,
    );
    expect(applyCronCreateCallerScopeDefault(job, callerScope)).toMatchObject({
      agentId: "research",
      owner: { agentId: "main", sessionKey: f.identity.sessionKey },
    });
    expect(resolveCronScheduledToolPolicyForCaller(callerScope)).toMatchObject({
      mode: "account",
      ownerSessionKey: f.identity.sessionKey,
    });
    f.revoke();
    expect(() => cronCreateMatchesCallerScope({ job, callerScope })).toThrow("revoked");
  });

  it.each(["method", "run", "instance", "claim", "lifecycle"])(
    "rejects %s substitution without spending the valid grant",
    (field) => {
      const f = fixture();
      f.identity.channelAdministratorGrant = f.mint();
      let changed = structuredClone(f.identity);
      if (field === "run") {
        changed = {
          ...changed,
          operationalRunInstance: { ...changed.operationalRunInstance, runId: "child-run" },
        };
      }
      if (field === "instance") {
        changed = {
          ...changed,
          operationalRunInstance: {
            ...changed.operationalRunInstance,
            instanceId: "other-instance",
          },
        };
      }
      if (field === "claim") {
        changed = {
          ...changed,
          delegatedAuthority: { ...changed.delegatedAuthority, claimId: "other-claim" },
        };
      }
      if (field === "lifecycle") {
        changed = {
          ...changed,
          delegatedAuthority: {
            ...changed.delegatedAuthority,
            lifecycleGeneration: "other-lifecycle",
          },
        };
      }
      expect(() =>
        admitChannelAdministratorRequest(
          { ...f.client, internal: { ...f.client.internal, agentRuntimeIdentity: changed } },
          field === "method" ? "cron.remove" : "cron.get",
        ),
      ).toThrow();
      expect(admitChannelAdministratorRequest(f.client, "cron.get")).toMatchObject({
        assertActive: expect.any(Function),
      });
    },
  );

  it.each(["policy", "turn", "operation", "claim", "lifecycle", "expiry"])(
    "fences retained commit authority after %s revocation",
    (reason) => {
      const f = fixture();
      const operation = new AbortController();
      f.identity.channelAdministratorGrant = f.mint("cron.update", operation.signal);
      const admitted = admitChannelAdministratorRequest(f.client, "cron.update")!;
      const guard = getChannelAdministratorRequestAuthority(admitted.client)!;
      guard();
      if (reason === "policy") {
        f.revoke();
      }
      if (reason === "turn") {
        f.lifetime.abort();
      }
      if (reason === "operation") {
        operation.abort();
      }
      if (reason === "claim") {
        releaseAgentRunDelegatedAuthority(f.authority);
      }
      if (reason === "lifecycle") {
        rotateAgentRunRegistryLifecycleGeneration();
      }
      if (reason === "expiry") {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 60_001);
      }
      expect(guard).toThrow();
    },
  );

  it("does not transfer a retained capability to a replacement with the same run id", () => {
    const f = fixture();
    f.identity.channelAdministratorGrant = f.mint();
    admitChannelAdministratorRequest(f.client, "cron.get")!.assertActive();
    releaseAgentRunDelegatedAuthority(f.authority);
    const { operationalRunInstance } = createTestAdmittedRunContext(f.capability.runId);
    const replacement = claimAgentRunDelegatedAuthority(operationalRunInstance);
    expect(() => mintChannelAdministratorGrant(f.capability, replacement, "cron.remove")).toThrow();
  });

  it("rejects revocation while a minted request is awaiting dispatch", () => {
    const f = fixture();
    f.identity.channelAdministratorGrant = f.mint();
    f.revoke();
    expect(() => admitChannelAdministratorRequest(f.client, "cron.get")).toThrow("revoked");
    expect(() => f.mint()).toThrow("revoked");
  });
});

describe("administrator Gateway dispatch", () => {
  async function dispatch(
    f: ReturnType<typeof fixture>,
    method: string,
    options: {
      grant?: boolean;
      params?: Record<string, unknown>;
      methodRegistry?: GatewayMethodRegistry;
      extraHandlers?: GatewayRequestHandlers;
      context?: Partial<GatewayRequestContext>;
    } = {},
  ) {
    if (options.grant !== false) {
      f.identity.channelAdministratorGrant = f.mint(method);
    }
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "admin-probe", method, params: options.params },
      respond,
      client: f.client,
      isWebchatConnect: () => false,
      methodRegistry: options.methodRegistry,
      extraHandlers: options.extraHandlers,
      context: {
        logGateway: { info: vi.fn(), warn: vi.fn() },
        getRuntimeConfig: () => ({}),
        ...options.context,
      } as unknown as GatewayRequestContext,
    });
    return respond;
  }

  function expectUnsupported(respond: ReturnType<typeof vi.fn>) {
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("not supported for this handler"),
      }),
    );
  }

  it.each(["test.administrator", "plugins.sessionAction", "plugins.install", "agents.files.set"])(
    "does not grant unreviewed %s authority even when the transport requested admin scope",
    async (method) => {
      const f = fixture();
      f.client.connect.scopes = ["operator.admin"];
      const handler = vi.fn<GatewayRequestHandler>();
      const respond = await dispatch(f, method, { extraHandlers: { [method]: handler } });
      expectUnsupported(respond);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(["plugin", "aux", "core"] as const)(
    "does not let a %s descriptor borrow a reviewed core name",
    async (kind) => {
      const f = fixture();
      const method = "config.patch";
      const handler = vi.fn<GatewayRequestHandler>();
      const methodRegistry = createGatewayMethodRegistry([
        {
          name: method,
          handler,
          scope: "operator.admin",
          owner: kind === "plugin" ? { kind, pluginId: "test" } : { kind, area: "test" },
        },
      ]);
      expectUnsupported(await dispatch(f, method, { methodRegistry }));
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("does not elevate a classified core extra-handler override", async () => {
    const handler = vi.fn<GatewayRequestHandler>();
    expectUnsupported(
      await dispatch(fixture(), "config.patch", { extraHandlers: { "config.patch": handler } }),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not elevate a plugin descriptor wrapping the actual core handler", async () => {
    const method = "config.patch";
    const methodRegistry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "test",
        name: method,
        handler: coreGatewayHandlers[method]!,
        scope: "operator.admin",
      }),
    ]);
    expectUnsupported(await dispatch(fixture(), method, { methodRegistry }));
  });

  it("preserves ordinary plugin authorization when no administrator grant is supplied", async () => {
    const f = fixture();
    const method = "test.administrator";
    const handler = vi.fn<GatewayRequestHandler>(({ client, respond }) => {
      expect(readCronCallerScope(client)?.manageAll).toBeUndefined();
      respond(true, { ok: true });
    });
    const extraHandlers = { [method]: handler };
    const denied = await dispatch(f, method, { grant: false, extraHandlers });
    expect(denied).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("operator.admin") }),
    );
    expect(handler).not.toHaveBeenCalled();
    f.client.connect.scopes = ["operator.admin"];
    const allowed = await dispatch(f, method, { grant: false, extraHandlers });
    expect(allowed).toHaveBeenCalledWith(true, { ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  const job: CronJob = {
    id: "other-session-job",
    agentId: "research",
    name: "Research monitor",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Summarize research." },
    state: {},
  };
  const scratch = { content: "Other session scratch", revision: 1, updatedAtMs: 1 };

  function scratchContext(
    overrides: Partial<GatewayRequestContext["cron"]> = {},
  ): Partial<GatewayRequestContext> {
    return {
      cron: {
        getDefaultAgentId: () => "main",
        getJob: () => job,
        readJob: async () => job,
        readScratch: async () => ({ scratch, currentRevision: 1 }),
        ...overrides,
      } as GatewayRequestContext["cron"],
    };
  }

  it("admits the canonical cron handler for another session without elevating the connection", async () => {
    const f = fixture();
    const options = { params: { id: job.id }, context: scratchContext() };
    const ordinary = await dispatch(f, "cron.scratch.get", { ...options, grant: false });
    expect(ordinary).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("operator.admin") }),
    );
    const admin = await dispatch(f, "cron.scratch.get", options);
    expect(admin).toHaveBeenCalledWith(true, expect.objectContaining({ scratch }), undefined);
    expect(f.client.connect.scopes).toEqual(["operator.read"]);
    expect(readCronCallerScope(f.client)?.manageAll).toBeUndefined();
  });

  it("fences an admin-scoped read response after policy revocation during the read", async () => {
    const f = fixture();
    const respond = await dispatch(f, "cron.scratch.get", {
      params: { id: job.id },
      context: scratchContext({
        readScratch: async () => {
          await Promise.resolve();
          f.revoke();
          return { scratch, currentRevision: 1 };
        },
      }),
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("revoked") }),
    );
  });

  it("carries canonical cron mutation authority through awaited store preparation", async () => {
    const f = fixture();
    const effect = vi.fn();
    const respond = await dispatch(f, "cron.scratch.set", {
      params: { id: job.id, content: "New scratch" },
      context: scratchContext({
        writeScratch: async (_id, params) => {
          await Promise.resolve();
          f.revoke();
          params.commitGuard?.();
          effect();
          return { ok: true, scratch, currentRevision: 1 };
        },
      }),
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("revoked") }),
    );
    expect(effect).not.toHaveBeenCalled();
  });
});
