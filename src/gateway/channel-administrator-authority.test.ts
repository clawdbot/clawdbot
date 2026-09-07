import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
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
  redeemChannelAdministratorGrant,
} from "./channel-administrator-authority.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
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
    const job = {
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
      const grant = f.mint();
      const changed = structuredClone(f.identity);
      if (field === "run") {
        changed.operationalRunInstance.runId = "child-run";
      }
      if (field === "instance") {
        changed.operationalRunInstance.instanceId = "other-instance";
      }
      if (field === "claim") {
        changed.delegatedAuthority.claimId = "other-claim";
      }
      if (field === "lifecycle") {
        changed.delegatedAuthority.lifecycleGeneration = "other-lifecycle";
      }
      expect(() =>
        redeemChannelAdministratorGrant(
          grant,
          changed,
          field === "method" ? "cron.remove" : "cron.get",
        ),
      ).toThrow();
      expect(() => redeemChannelAdministratorGrant(grant, f.identity, "cron.get")).not.toThrow();
    },
  );

  it.each(["policy", "turn", "operation", "claim", "lifecycle", "expiry"])(
    "fences retained commit authority after %s revocation",
    (reason) => {
      const f = fixture();
      const operation = new AbortController();
      const guard = redeemChannelAdministratorGrant(
        f.mint("cron.update", operation.signal),
        f.identity,
        "cron.update",
      );
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
    const grant = f.mint();
    redeemChannelAdministratorGrant(grant, f.identity, "cron.get");
    releaseAgentRunDelegatedAuthority(f.authority);
    const { operationalRunInstance } = createTestAdmittedRunContext(f.capability.runId);
    const replacement = claimAgentRunDelegatedAuthority(operationalRunInstance);
    expect(() => mintChannelAdministratorGrant(f.capability, replacement, "cron.remove")).toThrow();
  });

  it("rejects revocation while a minted request is awaiting dispatch", () => {
    const f = fixture();
    const grant = f.mint();
    f.revoke();
    expect(() => redeemChannelAdministratorGrant(grant, f.identity, "cron.get")).toThrow("revoked");
    expect(() => f.mint()).toThrow("revoked");
  });
});

describe("administrator Gateway dispatch", () => {
  const method = "test.administrator";
  async function dispatch(
    f: ReturnType<typeof fixture>,
    handler: GatewayRequestHandler,
    grant = true,
  ) {
    if (grant) {
      f.identity.channelAdministratorGrant = f.mint(method);
    }
    const respond = vi.fn();
    const methodRegistry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "test",
        name: method,
        handler,
        scope: "operator.admin",
      }),
    ]);
    await handleGatewayRequest({
      req: { type: "req", id: "admin-probe", method },
      respond,
      client: f.client,
      isWebchatConnect: () => false,
      methodRegistry,
      context: {
        logGateway: { info: vi.fn(), warn: vi.fn() },
        getRuntimeConfig: () => ({}),
      } as unknown as GatewayRequestContext,
    });
    return respond;
  }

  it("keeps an ordinary Discord owner denied but admits an exact authorized administrator", async () => {
    const handler = vi.fn<GatewayRequestHandler>(
      ({ client, sessionMutationCommitGuard, respond }) => {
        expect(client?.connect.scopes).toContain("operator.admin");
        expect(readCronCallerScope(client)?.manageAll).toEqual(expect.any(Function));
        sessionMutationCommitGuard?.();
        respond(true, { ok: true });
      },
    );
    const ordinary = await dispatch(fixture(), handler, false);
    expect(ordinary).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("operator.admin") }),
    );
    expect(handler).not.toHaveBeenCalled();
    const admin = await dispatch(fixture(), handler);
    expect(admin).toHaveBeenCalledWith(true, { ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not commit privileged work after revocation across an await", async () => {
    const f = fixture();
    const effect = vi.fn();
    await expect(
      dispatch(f, async ({ sessionMutationCommitGuard }) => {
        await Promise.resolve();
        f.revoke();
        sessionMutationCommitGuard?.();
        effect();
      }),
    ).rejects.toThrow("revoked");
    expect(effect).not.toHaveBeenCalled();
  });
});
