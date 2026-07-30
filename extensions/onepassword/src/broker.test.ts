import type { PluginHookBeforeToolCallResult } from "openclaw/plugin-sdk/types";
import { describe, expect, it, vi } from "vitest";
import {
  OnePasswordBroker,
  type AuditRow,
  type PendingAuthorization,
  type StandingGrant,
} from "./broker.js";
import type { OnePasswordConfig, OnePasswordItemConfig } from "./config.js";
import { MemoryKeyedStore, MemorySyncKeyedStore } from "./memory-store.test-support.js";
import { AUTHORIZATION_NONCE_PARAM } from "./pending-authorization.js";

const invocation = {
  agentId: "agent-a",
  sessionKey: "session-a",
  sessionId: "conversation-a",
} as const;

function config(): OnePasswordConfig {
  return {
    vault: "Automation",
    defaultPolicy: "approve",
    cacheTtlSeconds: 300,
    grantTtlHours: 1,
    opTimeoutMs: 15_000,
    items: {
      automatic: {
        item: "Automatic",
        vault: "Automation",
        field: "credential",
        policy: "auto",
        description: "Automatic item",
      },
      approval: {
        item: "Approval",
        vault: "Automation",
        field: "credential",
        policy: "approve",
      },
      blocked: {
        item: "Blocked",
        vault: "Automation",
        field: "credential",
        policy: "deny",
      },
    },
  };
}

function configuredItem(configured: OnePasswordConfig, slug: string): OnePasswordItemConfig {
  const item = configured.items[slug];
  if (!item) {
    throw new Error(`Missing test config item: ${slug}`);
  }
  return item;
}

function setup(nowValue = 1_000, configured = config()) {
  let now = nowValue;
  let currentConfig: OnePasswordConfig | undefined = configured;
  const audit = new MemoryKeyedStore<AuditRow>(() => now);
  const grants = new MemoryKeyedStore<StandingGrant>(() => now);
  const pending = new MemorySyncKeyedStore<PendingAuthorization>(() => now);
  const stores = { audit, grants, pending };
  const getItem = vi.fn(async () => ({
    value: ["fixture", "value"].join("-"),
    itemTitle: "Item title",
    fieldLabel: "credential",
  }));
  const createBroker = () =>
    new OnePasswordBroker({
      resolveConfig: () => currentConfig,
      opClient: { getItem },
      stores,
      now: () => now,
    });
  const broker = createBroker();
  return {
    broker,
    createBroker,
    audit,
    grants,
    pending,
    getItem,
    setConfig: (next: OnePasswordConfig | undefined) => {
      currentConfig = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function before(
  broker: OnePasswordBroker,
  toolCallId: string,
  params: Record<string, unknown>,
): Promise<PluginHookBeforeToolCallResult | void> {
  return broker.beforeToolCall(
    { toolName: "onepassword", params, toolCallId },
    { toolName: "onepassword", toolCallId, ...invocation },
  );
}

function nonceOf(result: PluginHookBeforeToolCallResult | void): string | undefined {
  const nonce = result?.params?.[AUTHORIZATION_NONCE_PARAM];
  return typeof nonce === "string" ? nonce : undefined;
}

describe("OnePasswordBroker validation and policy", () => {
  it("lists only registry metadata and active grant state", async () => {
    const { broker, getItem } = setup();
    const approval = await before(broker, "list-grant", {
      action: "get",
      slug: "approval",
      reason: "create listing fixture",
    });
    await approval?.requireApproval?.onResolution?.("allow-always");
    await broker.get(
      "list-grant",
      { action: "get", slug: "approval", reason: "create listing fixture" },
      invocation,
      nonceOf(approval),
    );
    getItem.mockClear();

    const items = await broker.list(invocation);
    expect(items).toEqual([
      {
        slug: "approval",
        description: "",
        policy: "approve",
        standingGrantActive: true,
      },
      {
        slug: "automatic",
        description: "Automatic item",
        policy: "auto",
        standingGrantActive: false,
      },
      {
        slug: "blocked",
        description: "",
        policy: "deny",
        standingGrantActive: false,
      },
    ]);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("requires a non-empty bounded reason before policy evaluation", async () => {
    const { broker, audit, getItem } = setup();
    const missing = await before(broker, "call-1", { action: "get", slug: "blocked" });
    const empty = await before(broker, "call-2", {
      action: "get",
      slug: "blocked",
      reason: "   ",
    });
    const long = await before(broker, "call-3", {
      action: "get",
      slug: "blocked",
      reason: "x".repeat(301),
    });
    expect(missing).toMatchObject({ block: true });
    expect(empty).toMatchObject({ block: true });
    expect(long).toMatchObject({ block: true });
    expect(getItem).not.toHaveBeenCalled();
    expect((await audit.entries()).map((entry) => entry.value.errorCode)).toEqual([
      "INVALID_REASON",
      "INVALID_REASON",
      "INVALID_REASON",
    ]);
  });

  it("rejects invalid and unknown slugs", async () => {
    const { broker, audit } = setup();
    expect(
      await before(broker, "call-1", { action: "get", slug: "Bad", reason: "test" }),
    ).toMatchObject({ block: true });
    expect(
      await before(broker, "call-2", { action: "get", slug: "unknown", reason: "test" }),
    ).toMatchObject({ block: true });
    expect(
      await before(broker, "call-3", { action: "get", slug: "constructor", reason: "test" }),
    ).toMatchObject({ block: true });
    expect((await audit.entries()).map((entry) => entry.value.errorCode)).toEqual([
      "INVALID_SLUG",
      "UNKNOWN_SLUG",
      "UNKNOWN_SLUG",
    ]);
  });

  it("allows auto, blocks deny, and audits one row per attempt", async () => {
    const { broker, audit, getItem } = setup();
    const automatic = await before(broker, "auto-1", {
      action: "get",
      slug: "automatic",
      reason: "test",
    });
    expect(automatic?.requireApproval).toBeUndefined();
    await expect(
      broker.get(
        "auto-1",
        { action: "get", slug: "automatic", reason: "test" },
        invocation,
        nonceOf(automatic),
      ),
    ).resolves.toMatchObject({ value: ["fixture", "value"].join("-") });
    expect(
      await before(broker, "deny-1", { action: "get", slug: "blocked", reason: "test" }),
    ).toMatchObject({ block: true });
    expect(getItem).toHaveBeenCalledTimes(1);
    expect((await audit.entries()).map((entry) => entry.value.outcome)).toEqual([
      "auto",
      "policy-denied",
    ]);
  });

  it("handles allow-once, deny, and timeout decisions", async () => {
    const { broker, audit, getItem } = setup();
    const approved = await before(broker, "approve-1", {
      action: "get",
      slug: "approval",
      reason: "one use",
    });
    expect(approved?.requireApproval).toMatchObject({
      title: "1Password: approval",
      description: "Agent agent-a requests approval. Reason: one use",
      severity: "warning",
      timeoutMs: 600_000,
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    await approved?.requireApproval?.onResolution?.("allow-once");
    await broker.get(
      "approve-1",
      { action: "get", slug: "approval", reason: "one use" },
      invocation,
      nonceOf(approved),
    );

    const denied = await before(broker, "approve-2", {
      action: "get",
      slug: "approval",
      reason: "deny",
    });
    await denied?.requireApproval?.onResolution?.("deny");
    const timedOut = await before(broker, "approve-3", {
      action: "get",
      slug: "approval",
      reason: "timeout",
    });
    await timedOut?.requireApproval?.onResolution?.("timeout");

    expect(getItem).toHaveBeenCalledTimes(1);
    expect((await audit.entries()).map((entry) => entry.value.outcome)).toEqual([
      "approved",
      "denied",
      "timeout",
    ]);
  });

  it("authorizes when hook and execute contexts disagree on session fields", async () => {
    // Production regression: the hook's PluginHookToolContext and the tool
    // execute invocation context are sourced independently by core and can
    // carry different session fields for the same call. Correlation is
    // nonce-based so those differences cannot cause POLICY_NOT_EVALUATED.
    const { broker, audit } = setup();
    const result = await broker.beforeToolCall(
      {
        toolName: "onepassword",
        params: { action: "get", slug: "automatic", reason: "asymmetric contexts" },
        toolCallId: "call_x|fc_y",
      },
      {
        toolName: "onepassword",
        toolCallId: "call_x|fc_y",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "hook-run-uuid",
      },
    );
    await expect(
      broker.get(
        "call_x|fc_y",
        { action: "get", slug: "automatic", reason: "asymmetric contexts" },
        { agentId: "main", sessionKey: "agent:main:main" },
        nonceOf(result),
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
    const rows = await audit.entries();
    expect(rows.map((entry) => entry.value.outcome)).toEqual(["auto"]);
  });

  it("shares pending authorizations across broker instances", async () => {
    const { broker: hookBroker, createBroker } = setup();
    const executeBroker = createBroker();
    const issued = await before(hookBroker, "duplicate-instance-1", {
      action: "get",
      slug: "automatic",
      reason: "cross-instance authorization",
    });

    await expect(
      executeBroker.get(
        "duplicate-instance-1",
        { action: "get", slug: "automatic", reason: "cross-instance authorization" },
        invocation,
        nonceOf(issued),
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
  });

  it("isolates concurrent sessions that reuse a provider tool call id", async () => {
    const { broker, audit } = setup();
    const firstInvocation = {
      agentId: "agent-a",
      sessionKey: "session-a",
      sessionId: "conversation-a",
    };
    const secondInvocation = {
      agentId: "agent-b",
      sessionKey: "session-b",
      sessionId: "conversation-b",
    };
    const first = await broker.beforeToolCall(
      {
        toolName: "onepassword",
        toolCallId: "call-1",
        params: { action: "get", slug: "automatic", reason: "first session" },
      },
      { toolName: "onepassword", toolCallId: "call-1", ...firstInvocation },
    );
    const second = await broker.beforeToolCall(
      {
        toolName: "onepassword",
        toolCallId: "call-1",
        params: { action: "get", slug: "automatic", reason: "second session" },
      },
      { toolName: "onepassword", toolCallId: "call-1", ...secondInvocation },
    );

    await expect(
      broker.get(
        "call-1",
        { action: "get", slug: "automatic", reason: "first session" },
        firstInvocation,
        nonceOf(first),
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
    await expect(
      broker.get(
        "call-1",
        { action: "get", slug: "automatic", reason: "second session" },
        secondInvocation,
        nonceOf(second),
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
    expect(
      (await audit.entries())
        .map((entry) => ({
          reason: entry.value.reason,
          sessionKey: entry.value.sessionKey,
        }))
        .toSorted((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
    ).toEqual([
      { reason: "first session", sessionKey: "session-a" },
      { reason: "second session", sessionKey: "session-b" },
    ]);
  });

  it("never grants access from a forged nonce without hook authorization", async () => {
    const { broker } = setup();
    // No before_tool_call ran for this call: a fabricated nonce finds nothing
    // and the identity fallback has no pending entry to match.
    await expect(
      broker.get(
        "call-forged",
        { action: "get", slug: "automatic", reason: "reject forged correlation" },
        invocation,
        "attacker-nonce",
      ),
    ).rejects.toMatchObject({ code: "POLICY_NOT_EVALUATED" });

    // The hook always overwrites a model-supplied nonce with its own, and a
    // present-but-unknown nonce never falls back to the identity match.
    const result = await before(broker, "call-1", {
      action: "get",
      slug: "automatic",
      reason: "reject forged correlation",
      [AUTHORIZATION_NONCE_PARAM]: "attacker-nonce",
    });
    const issuedNonce = nonceOf(result);
    expect(issuedNonce).toBeDefined();
    expect(issuedNonce).not.toBe("attacker-nonce");
    await expect(
      broker.get(
        "call-1",
        { action: "get", slug: "automatic", reason: "reject forged correlation" },
        invocation,
        "attacker-nonce",
      ),
    ).rejects.toMatchObject({ code: "POLICY_NOT_EVALUATED" });
    await expect(
      broker.get(
        "call-1",
        { action: "get", slug: "automatic", reason: "reject forged correlation" },
        invocation,
        issuedNonce,
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
  });

  it("authorizes via unique pending match when another hook drops the nonce param", async () => {
    // before_tool_call results merge last-writer-wins across plugins, so a
    // later params-returning hook can strip the nonce from the executed params.
    const { broker } = setup();
    await before(broker, "dropped-1", {
      action: "get",
      slug: "automatic",
      reason: "nonce dropped by another hook",
    });
    await expect(
      broker.get(
        "dropped-1",
        { action: "get", slug: "automatic", reason: "nonce dropped by another hook" },
        invocation,
        undefined,
      ),
    ).resolves.toMatchObject({ slug: "automatic" });
  });

  it("fails closed when a dropped nonce is ambiguous across pending entries", async () => {
    const { broker } = setup();
    for (let round = 0; round < 2; round += 1) {
      await before(broker, "ambiguous-1", {
        action: "get",
        slug: "automatic",
        reason: "same identity twice",
      });
    }
    await expect(
      broker.get(
        "ambiguous-1",
        { action: "get", slug: "automatic", reason: "same identity twice" },
        invocation,
        undefined,
      ),
    ).rejects.toMatchObject({ code: "POLICY_NOT_EVALUATED" });
  });

  it("persists allow-always grants and expires them", async () => {
    const { broker, audit, grants, getItem, advance } = setup();
    const first = await before(broker, "grant-1", {
      action: "get",
      slug: "approval",
      reason: "standing access",
    });
    await first?.requireApproval?.onResolution?.("allow-always");
    await broker.get(
      "grant-1",
      {
        action: "get",
        slug: "approval",
        reason: "standing access",
      },
      invocation,
      nonceOf(first),
    );
    expect((await grants.entries()).map((entry) => entry.value.agentId)).toEqual(["agent-a"]);

    advance(300_001);
    const second = await before(broker, "grant-2", {
      action: "get",
      slug: "approval",
      reason: "second access",
    });
    expect(second?.requireApproval).toBeUndefined();
    await broker.get(
      "grant-2",
      { action: "get", slug: "approval", reason: "second access" },
      invocation,
      nonceOf(second),
    );
    expect(getItem).toHaveBeenCalledTimes(2);

    advance(60 * 60 * 1000 + 1);
    const expired = await before(broker, "grant-3", {
      action: "get",
      slug: "approval",
      reason: "expired access",
    });
    expect(expired?.requireApproval).toBeDefined();
    expect((await audit.entries()).map((entry) => entry.value.outcome)).toEqual([
      "approved",
      "grant",
    ]);
  });

  it("scopes standing grants and list state to the approved agent", async () => {
    const { broker } = setup();
    const approved = await before(broker, "agent-grant-1", {
      action: "get",
      slug: "approval",
      reason: "agent a access",
    });
    await approved?.requireApproval?.onResolution?.("allow-always");
    await broker.get(
      "agent-grant-1",
      { action: "get", slug: "approval", reason: "agent a access" },
      invocation,
      nonceOf(approved),
    );

    const otherAgent = {
      agentId: "agent-b",
      sessionKey: "session-b",
      sessionId: "conversation-b",
    };
    const otherRequest = await broker.beforeToolCall(
      {
        toolName: "onepassword",
        toolCallId: "agent-grant-2",
        params: { action: "get", slug: "approval", reason: "agent b access" },
      },
      { toolName: "onepassword", toolCallId: "agent-grant-2", ...otherAgent },
    );
    expect(otherRequest?.requireApproval).toBeDefined();
    expect((await broker.list(invocation)).find((item) => item.slug === "approval")).toMatchObject({
      standingGrantActive: true,
    });
    expect((await broker.list(otherAgent)).find((item) => item.slug === "approval")).toMatchObject({
      standingGrantActive: false,
    });
  });

  it("does not offer a durable grant without an agent identity", async () => {
    const { broker } = setup();
    const result = await broker.beforeToolCall(
      {
        toolName: "onepassword",
        toolCallId: "unknown-agent",
        params: { action: "get", slug: "approval", reason: "one call only" },
      },
      { toolName: "onepassword", toolCallId: "unknown-agent" },
    );
    expect(result?.requireApproval?.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("invalidates a standing grant when its configured target changes", async () => {
    const configured = config();
    const { broker } = setup(1_000, configured);
    const first = await before(broker, "grant-remap-1", {
      action: "get",
      slug: "approval",
      reason: "approve original target",
    });
    await first?.requireApproval?.onResolution?.("allow-always");
    await broker.get(
      "grant-remap-1",
      { action: "get", slug: "approval", reason: "approve original target" },
      invocation,
      nonceOf(first),
    );

    configuredItem(configured, "approval").item = "Replacement target";
    const remapped = await before(broker, "grant-remap-2", {
      action: "get",
      slug: "approval",
      reason: "request remapped target",
    });
    expect(remapped?.requireApproval).toBeDefined();
  });

  it("fails closed when live policy changes after authorization", async () => {
    const configured = config();
    const { broker, audit, getItem, setConfig } = setup(1_000, configured);
    const authorized = await before(broker, "live-deny-1", {
      action: "get",
      slug: "automatic",
      reason: "authorized before reload",
    });
    const reloaded = structuredClone(configured);
    configuredItem(reloaded, "automatic").policy = "deny";
    setConfig(reloaded);

    await expect(
      broker.get(
        "live-deny-1",
        { action: "get", slug: "automatic", reason: "authorized before reload" },
        invocation,
        nonceOf(authorized),
      ),
    ).rejects.toMatchObject({ code: "POLICY_CHANGED" });
    expect(getItem).not.toHaveBeenCalled();
    expect((await audit.entries()).at(-1)?.value).toMatchObject({
      outcome: "policy-denied",
    });
  });

  it("rejects a retargeted authorization and never reuses its cached value", async () => {
    const configured = config();
    const { broker, getItem, setConfig } = setup(1_000, configured);
    const primed = await before(broker, "live-target-1", {
      action: "get",
      slug: "automatic",
      reason: "prime original target",
    });
    await broker.get(
      "live-target-1",
      { action: "get", slug: "automatic", reason: "prime original target" },
      invocation,
      nonceOf(primed),
    );

    const authorized = await before(broker, "live-target-2", {
      action: "get",
      slug: "automatic",
      reason: "authorized before retarget",
    });
    const reloaded = structuredClone(configured);
    configuredItem(reloaded, "automatic").item = "Replacement target";
    setConfig(reloaded);
    await expect(
      broker.get(
        "live-target-2",
        { action: "get", slug: "automatic", reason: "authorized before retarget" },
        invocation,
        nonceOf(authorized),
      ),
    ).rejects.toMatchObject({ code: "POLICY_CHANGED" });

    const replacement = await before(broker, "live-target-3", {
      action: "get",
      slug: "automatic",
      reason: "authorize replacement target",
    });
    await broker.get(
      "live-target-3",
      { action: "get", slug: "automatic", reason: "authorize replacement target" },
      invocation,
      nonceOf(replacement),
    );
    expect(getItem).toHaveBeenCalledTimes(2);
    expect(getItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ item: "Replacement target" }),
    );
  });

  it("blocks access after live plugin config removal", async () => {
    const { broker, audit, getItem, setConfig } = setup();
    setConfig(undefined);
    await expect(
      before(broker, "live-remove-1", {
        action: "get",
        slug: "automatic",
        reason: "after removal",
      }),
    ).resolves.toMatchObject({ block: true });
    expect(getItem).not.toHaveBeenCalled();
    expect((await audit.entries()).at(-1)?.value).toMatchObject({
      outcome: "error",
      errorCode: "POLICY_CHANGED",
    });
  });

  it("prunes grants for removed slugs before persisting a replacement", async () => {
    const { broker, grants } = setup();
    for (const slug of ["removed-a", "removed-b"]) {
      await grants.register(slug, {
        agentId: "agent-a",
        slug,
        grantedAtMs: 900,
        expiresAtMs: 10_000,
        targetFingerprint: "removed-target",
      });
    }
    const approval = await before(broker, "grant-prune-1", {
      action: "get",
      slug: "approval",
      reason: "replace removed grants",
    });
    await approval?.requireApproval?.onResolution?.("allow-always");
    await broker.get(
      "grant-prune-1",
      { action: "get", slug: "approval", reason: "replace removed grants" },
      invocation,
      nonceOf(approval),
    );
    expect((await grants.entries()).map((entry) => entry.value.slug)).toEqual(["approval"]);
  });

  it("rechecks a standing grant before serving a cached value", async () => {
    const configured = config();
    configured.grantTtlHours = 0.001;
    const { broker, audit, getItem, advance } = setup(1_000, configured);
    const first = await before(broker, "grant-cache-1", {
      action: "get",
      slug: "approval",
      reason: "create grant",
    });
    await first?.requireApproval?.onResolution?.("allow-always");
    await broker.get(
      "grant-cache-1",
      {
        action: "get",
        slug: "approval",
        reason: "create grant",
      },
      invocation,
      nonceOf(first),
    );

    const second = await before(broker, "grant-cache-2", {
      action: "get",
      slug: "approval",
      reason: "use grant",
    });
    expect(second?.requireApproval).toBeUndefined();
    advance(3_601);
    await expect(
      broker.get(
        "grant-cache-2",
        {
          action: "get",
          slug: "approval",
          reason: "use grant",
        },
        invocation,
        nonceOf(second),
      ),
    ).rejects.toMatchObject({ code: "GRANT_EXPIRED" });
    expect(getItem).toHaveBeenCalledTimes(1);
    expect((await audit.entries()).at(-1)?.value).toMatchObject({
      outcome: "error",
      errorCode: "GRANT_EXPIRED",
    });
  });
});

describe("OnePasswordBroker cache and audit", () => {
  it("honors cache TTL, audits hits, and refetches after expiry", async () => {
    const { broker, audit, getItem, advance } = setup();
    for (const [id, reason] of [
      ["cache-1", "first"],
      ["cache-2", "second"],
    ] as const) {
      const result = await before(broker, id, { action: "get", slug: "automatic", reason });
      await broker.get(
        id,
        { action: "get", slug: "automatic", reason },
        invocation,
        nonceOf(result),
      );
    }
    expect(getItem).toHaveBeenCalledTimes(1);
    advance(300_001);
    const third = await before(broker, "cache-3", {
      action: "get",
      slug: "automatic",
      reason: "third",
    });
    await broker.get(
      "cache-3",
      { action: "get", slug: "automatic", reason: "third" },
      invocation,
      nonceOf(third),
    );
    expect(getItem).toHaveBeenCalledTimes(2);
    expect((await audit.entries()).map((entry) => entry.value.outcome)).toEqual([
      "auto",
      "cache-hit",
      "auto",
    ]);
  });

  it("never lets a cache entry bypass a changed deny policy", async () => {
    const cfg = config();
    const audit = new MemoryKeyedStore<AuditRow>();
    const grants = new MemoryKeyedStore<StandingGrant>();
    const pending = new MemorySyncKeyedStore<PendingAuthorization>();
    const getItem = vi.fn(async () => ({
      value: ["fixture", "value"].join("-"),
      itemTitle: "Item",
      fieldLabel: "credential",
    }));
    const broker = new OnePasswordBroker({
      resolveConfig: () => cfg,
      opClient: { getItem },
      stores: { audit, grants, pending },
    });
    const primed = await before(broker, "deny-cache-1", {
      action: "get",
      slug: "automatic",
      reason: "prime cache",
    });
    await broker.get(
      "deny-cache-1",
      {
        action: "get",
        slug: "automatic",
        reason: "prime cache",
      },
      invocation,
      nonceOf(primed),
    );
    const automatic = cfg.items.automatic;
    if (!automatic) {
      throw new Error("automatic test item missing");
    }
    automatic.policy = "deny";
    expect(
      await before(broker, "deny-cache-2", {
        action: "get",
        slug: "automatic",
        reason: "blocked",
      }),
    ).toMatchObject({ block: true });
    expect(getItem).toHaveBeenCalledTimes(1);
    expect((await audit.entries()).map((entry) => entry.value.outcome)).toEqual([
      "auto",
      "policy-denied",
    ]);
  });
});
