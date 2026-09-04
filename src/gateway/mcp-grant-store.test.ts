import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import {
  activateMcpLoopbackClientGrantCapture,
  bindMcpLoopbackClientGrantAdmission,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
  resolveAttachGrant,
  resolveMcpLoopbackClientGrant,
  revokeAttachGrant,
  revokeAttachGrantsForSession,
  revokeMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrantsForRuntime,
  transferMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";

const T0 = 1_000_000_000_000;
const admissions: PreparedAgentRunAdmission[] = [];

async function admitted(runId: string): Promise<AdmittedRunContext> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "mcp-grant-store-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  return await admission.admit("gateway", `gateway-${runId}`);
}

describe("mcp-grant-store", () => {
  beforeEach(async () => {
    await revokeMcpLoopbackClientGrantsForRuntime("runtime-one");
    await revokeMcpLoopbackClientGrantsForRuntime("runtime-two");
  });

  afterEach(async () => {
    for (const admission of admissions.splice(0)) {
      admission.close();
    }
    await revokeMcpLoopbackClientGrantsForRuntime("runtime-one");
    await revokeMcpLoopbackClientGrantsForRuntime("runtime-two");
  });

  it("mints a grant bound to the sessionKey with a token and a TTL window", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:main", ttlMs: 60_000, nowMs: T0 });
    expect(g.sessionKey).toBe("agent:main:main");
    expect(g.token).toMatch(/^[0-9a-f]{64}$/);
    expect(g.issuedAtMs).toBe(T0);
    expect(g.expiresAtMs).toBe(T0 + 60_000);
  });

  it("requires a non-empty sessionKey", () => {
    expect(() => mintAttachGrant({ sessionKey: "  ", nowMs: T0 })).toThrow();
  });

  it("resolves a live grant and drops it once expired (TTL)", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:x", ttlMs: 1_000, nowMs: T0 });
    expect(resolveAttachGrant(g.token, T0)?.sessionKey).toBe("agent:main:x");
    expect(resolveAttachGrant(g.token, T0 + 999)?.sessionKey).toBe("agent:main:x");
    expect(resolveAttachGrant(g.token, T0 + 1_000)).toBeUndefined();
    expect(resolveAttachGrant(g.token, T0 + 1_001)).toBeUndefined();
  });

  it("returns undefined for an unknown token (no scope without a grant)", () => {
    expect(resolveAttachGrant("deadbeef", T0)).toBeUndefined();
  });

  it("binds the sessionKey to the grant (token carries scope identity, not the caller)", () => {
    const a = mintAttachGrant({ sessionKey: "agent:main:telegram:1", nowMs: T0 });
    const b = mintAttachGrant({ sessionKey: "agent:main:telegram:2", nowMs: T0 });
    expect(resolveAttachGrant(a.token, T0)?.sessionKey).toBe("agent:main:telegram:1");
    expect(resolveAttachGrant(b.token, T0)?.sessionKey).toBe("agent:main:telegram:2");
    expect(a.token).not.toBe(b.token);
  });

  it("binds a separate agent owner only to the canonical global session", () => {
    const global = mintAttachGrant({ sessionKey: "global", agentId: " ops ", nowMs: T0 });
    const scoped = mintAttachGrant({
      sessionKey: "agent:main:telegram:1",
      agentId: "ops",
      nowMs: T0,
    });

    expect(global.agentId).toBe("ops");
    expect(scoped.agentId).toBeUndefined();
  });

  it("revokes by token", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:x", nowMs: T0 });
    expect(revokeAttachGrant(g.token)).toBe(true);
    expect(resolveAttachGrant(g.token, T0)).toBeUndefined();
    expect(revokeAttachGrant(g.token)).toBe(false);
  });

  it("revokes every attach grant for one session", () => {
    const first = mintAttachGrant({ sessionKey: "agent:main:first", nowMs: T0 });
    const second = mintAttachGrant({ sessionKey: "agent:main:first", nowMs: T0 });
    const other = mintAttachGrant({ sessionKey: "agent:main:other", nowMs: T0 });

    expect(revokeAttachGrantsForSession(" agent:main:first ")).toBe(2);
    expect(resolveAttachGrant(first.token, T0)).toBeUndefined();
    expect(resolveAttachGrant(second.token, T0)).toBeUndefined();
    expect(resolveAttachGrant(other.token, T0)?.sessionKey).toBe("agent:main:other");
  });

  it("clamps TTL: default for non-positive, ceiling at 12h", () => {
    const def = mintAttachGrant({ sessionKey: "s", nowMs: T0 });
    expect(def.expiresAtMs).toBe(T0 + 60 * 60 * 1000);
    const zero = mintAttachGrant({ sessionKey: "s", ttlMs: 0, nowMs: T0 });
    expect(zero.expiresAtMs).toBe(T0 + 60 * 60 * 1000);
    const huge = mintAttachGrant({ sessionKey: "s", ttlMs: 999 * 60 * 60 * 1000, nowMs: T0 });
    expect(huge.expiresAtMs).toBe(T0 + 12 * 60 * 60 * 1000);
  });

  it("binds an immutable Gateway-selected context to a loopback client grant", async () => {
    const context = {
      sessionKey: " agent:main:telegram:group:1 ",
      sessionId: "session-1",
      messageProvider: "telegram",
      clientCaps: ["tool-events"],
      currentChannelId: "telegram:-1001",
      currentThreadTs: "42",
      currentMessageId: "message-1",
      currentInboundAudio: true,
      accountId: "account-1",
      inboundEventKind: "room_event" as const,
      sourceReplyDeliveryMode: "message_tool_only" as const,
      sourceReplyOnly: true,
      toolsAllow: ["message"],
      taskSuggestionDeliveryMode: "gateway" as const,
      requireExplicitMessageTarget: true,
      senderIsOwner: false,
    };
    const grant = mintMcpLoopbackClientGrant({
      context,
      runtimeOwnerToken: "runtime-one",
      admittedRunContext: await admitted("run-immutable-context"),
    });
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        expectedOwner: grant,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-one",
      }),
    ).toMatchObject({ key: "capture-one" });

    context.clientCaps.push("caller-mutation");
    context.sourceReplyOnly = false;
    context.toolsAllow.push("exec");
    grant.context.clientCaps?.push("return-value-mutation");
    grant.context.sourceReplyOnly = false;
    grant.context.toolsAllow?.push("write");

    expect(
      resolveMcpLoopbackClientGrant({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-one",
      })?.context,
    ).toEqual({
      ...context,
      sessionKey: "agent:main:telegram:group:1",
      clientCaps: ["tool-events"],
      sourceReplyOnly: true,
      toolsAllow: ["message"],
    });
  });

  it("admits only the active capture on the grant's Gateway runtime", async () => {
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:first", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext: await admitted("run-active-capture"),
    });
    const resolve = (runtimeOwnerToken: string, captureKey: string) =>
      resolveMcpLoopbackClientGrant({
        token: grant.token,
        runtimeOwnerToken,
        captureKey,
      });

    expect(resolve("runtime-one", "capture-a")).toBeUndefined();
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        expectedOwner: grant,
        runtimeOwnerToken: "runtime-other",
        captureKey: "capture-a",
      }),
    ).toBeUndefined();
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        expectedOwner: grant,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-a",
      }),
    ).toMatchObject({ key: "capture-a" });
    expect(resolve("runtime-other", "capture-a")).toBeUndefined();
    expect(resolve("runtime-one", "capture-forged")).toBeUndefined();
    const first = resolve("runtime-one", "capture-a");
    expect(first?.captureKey).toBe("capture-a");
    expect(first?.isCurrent()).toBe(true);

    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        expectedOwner: grant,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-b",
      }),
    ).toMatchObject({ key: "capture-b" });
    expect(resolve("runtime-one", "capture-a")).toBeUndefined();
    expect(first?.isCurrent()).toBe(false);
    await first!.capture.close("completion");
    const second = resolve("runtime-one", "capture-b");
    expect(second?.captureKey).toBe("capture-b");
    expect(second?.isCurrent()).toBe(true);
    await second!.capture.close("completion");
    expect(resolve("runtime-one", "capture-b")).toBeUndefined();
    expect(second?.isCurrent()).toBe(false);
  });

  it("retains the exact admitted host context outside child-visible grant data", async () => {
    const admittedRunContext = await admitted("run-retained-context");
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:first", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext,
    });
    activateMcpLoopbackClientGrantCapture({
      token: grant.token,
      expectedOwner: grant,
      runtimeOwnerToken: "runtime-one",
      captureKey: "capture-a",
    });

    const resolved = resolveMcpLoopbackClientGrant({
      token: grant.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "capture-a",
    });
    expect(resolved?.admittedRunContext).toBe(admittedRunContext);
    expect(grant.context).not.toHaveProperty("admittedRunContext");
  });

  it("rejects an active bearer and capture after its admitted authority closes", async () => {
    const admittedRunContext = await admitted("run-closed-grant");
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:first", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext,
    });
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        expectedOwner: grant,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-a",
      }),
    ).toMatchObject({ key: "capture-a" });
    const resolved = resolveMcpLoopbackClientGrant({
      token: grant.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "capture-a",
    });
    expect(resolved?.isCurrent()).toBe(true);
    admissions.at(-1)?.close();
    expect(resolved?.isCurrent()).toBe(false);

    expect(
      resolveMcpLoopbackClientGrant({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-a",
      }),
    ).toBeUndefined();
  });

  it("binds one exact late admission and rejects replacement authority", async () => {
    const first = await admitted("run-late-binding");
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:first", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
    });

    expect(
      bindMcpLoopbackClientGrantAdmission({
        token: grant.token,
        expectedOwner: grant,
        runtimeOwnerToken: "runtime-one",
        admittedRunContext: first,
      }),
    ).toBe(true);
    const replacement = await admitted("run-late-binding");
    expect(
      bindMcpLoopbackClientGrantAdmission({
        token: grant.token,
        expectedOwner: grant,
        runtimeOwnerToken: "runtime-one",
        admittedRunContext: replacement,
      }),
    ).toBe(false);
  });

  it("transfers fresh turn authority onto a process-stable bearer", async () => {
    const firstAdmission = await admitted("run-first-turn");
    const nextAdmission = await admitted("run-next-turn");
    const skillLibraryAuthoring: SkillLibraryAuthoringCapability = {
      target: "personal",
      defaultTarget: "personal",
      multipleProfiles: true,
      bind: () => {},
      invoke: async () => {
        throw new Error("unused");
      },
    };
    const stable = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:first", runId: "run-first-turn", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext: firstAdmission,
    });
    const next = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:next", runId: "run-next-turn", senderIsOwner: true },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext: nextAdmission,
      skillLibraryAuthoring,
      toolAuth: {
        agentDir: "/tmp/next-agent",
        store: { version: 1, profiles: {} },
      },
    });
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: stable.token,
        expectedOwner: stable,
        runtimeOwnerToken: "runtime-one",
        captureKey: "stale-capture",
      }),
    ).toMatchObject({ key: "stale-capture" });
    const first = resolveMcpLoopbackClientGrant({
      token: stable.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "stale-capture",
    });
    expect(first?.isCurrent()).toBe(true);
    // Turn cleanup revokes the process bearer while the warm child still holds its token.
    // The next admitted turn must be able to restore that exact inactive bearer.
    await expect(revokeMcpLoopbackClientGrant(stable.token, stable)).resolves.toBe(true);
    expect(first?.isCurrent()).toBe(false);
    expect(
      transferMcpLoopbackClientGrant({
        sourceToken: next.token,
        targetToken: stable.token,
        expectedOwner: next,
        runtimeOwnerToken: "runtime-two",
      }),
    ).toBe(false);
    expect(
      transferMcpLoopbackClientGrant({
        sourceToken: next.token,
        targetToken: stable.token,
        expectedOwner: next,
        runtimeOwnerToken: "runtime-one",
      }),
    ).toBe(true);

    expect(
      resolveMcpLoopbackClientGrant({
        token: stable.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "stale-capture",
      }),
    ).toBeUndefined();
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: stable.token,
        expectedOwner: next,
        runtimeOwnerToken: "runtime-one",
        captureKey: "next-capture",
      }),
    ).toMatchObject({ key: "next-capture" });
    expect(
      resolveMcpLoopbackClientGrant({
        token: stable.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "next-capture",
      }),
    ).toMatchObject({
      context: {
        sessionKey: "agent:main:next",
        runId: "run-next-turn",
        senderIsOwner: true,
      },
      admittedRunContext: nextAdmission,
      skillLibraryAuthoring,
      toolAuth: {
        agentDir: "/tmp/next-agent",
        store: { version: 1, profiles: {} },
      },
    });
    const transferred = resolveMcpLoopbackClientGrant({
      token: stable.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "next-capture",
    });
    expect(transferred?.skillLibraryAuthoring).toBe(skillLibraryAuthoring);
    expect(transferred?.isCurrent()).toBe(true);
    expect(first?.isCurrent()).toBe(false);
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: next.token,
        expectedOwner: next,
        runtimeOwnerToken: "runtime-one",
        captureKey: "forged-source-capture",
      }),
    ).toBeUndefined();
  });

  it("revokes client grants by exact owner or Gateway runtime", async () => {
    const mintForRuntime = (runtimeOwnerToken: string, sessionKey: string) =>
      mintMcpLoopbackClientGrant({
        context: { sessionKey, senderIsOwner: false },
        runtimeOwnerToken,
      });
    const first = mintForRuntime("runtime-one", "agent:main:first");
    mintForRuntime("runtime-one", "agent:main:second");
    const successor = mintForRuntime("runtime-two", "agent:main:successor");

    await revokeMcpLoopbackClientGrantsForRuntime("runtime-one");
    await expect(revokeMcpLoopbackClientGrant(first.token, first)).resolves.toBe(false);
    await expect(revokeMcpLoopbackClientGrant(successor.token, successor)).resolves.toBe(true);
    await expect(revokeMcpLoopbackClientGrant(successor.token, successor)).resolves.toBe(false);
  });

  it("requires a session key for loopback client grants", () => {
    expect(() =>
      mintMcpLoopbackClientGrant({
        context: { sessionKey: "  ", senderIsOwner: false },
        runtimeOwnerToken: "runtime-one",
      }),
    ).toThrow(/sessionKey is required/);
    expect(() =>
      mintMcpLoopbackClientGrant({
        context: { sessionKey: "agent:main:main", senderIsOwner: false },
        runtimeOwnerToken: "  ",
      }),
    ).toThrow(/runtimeOwnerToken is required/);
  });
});
