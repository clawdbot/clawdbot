import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequesterToolPolicies } from "./requester-tool-policy.js";
import { attachToolAllowlistIntersection } from "./tool-policy.js";
import { resolveWebSearchToolPolicy } from "./web-search-tool-policy.js";

describe("resolveRequesterToolPolicies", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-requester-policy-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function writeSession(sessionKey: string, patch: Partial<SessionEntry>) {
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: `${sessionKey}-session`,
      updatedAt: Date.now(),
      ...patch,
    } as SessionEntry);
  }

  function config(overrides: OpenClawConfig = {}): OpenClawConfig {
    return {
      ...overrides,
      session: { ...overrides.session, store: storePath },
      tools: {
        ...overrides.tools,
        toolsBySender: {
          "*": { deny: ["group:runtime", "group:fs"] },
          "id:alice": {},
          ...overrides.tools?.toolsBySender,
        },
      },
    };
  }

  function completionHandoffFacts(sourceSessionKey: string, targetSessionKey: string) {
    const targetSessionId = `${targetSessionKey}-session`;
    return {
      trustedInternalHandoff: {
        kind: "subagent-completion" as const,
        sourceSessionKey,
        targetSessionKey,
        targetSessionId,
        provider: "openai",
        model: "gpt-test",
      },
      sessionId: targetSessionId,
      modelProvider: "openai",
      modelId: "gpt-test",
    };
  }

  it("resolves exact sender policy for an external requester", () => {
    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: "agent:main:discord:direct:alice",
      messageProvider: "discord",
      senderId: "alice",
    });

    expect(result.delegated).toBe(false);
    expect(result.requesterPolicySource).toBe("current-request");
    expect(result.senderPolicy).toBeUndefined();
  });

  it("uses a persisted child projection without re-resolving sender policy", async () => {
    const childSessionKey = "agent:main:subagent:child";
    await writeSession(childSessionKey, {
      spawnedBy: "agent:main:discord:direct:alice",
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["message"],
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: childSessionKey,
    });

    expect(result.delegated).toBe(true);
    expect(result.requesterPolicySource).toBe("persisted-child");
    expect(result.senderPolicy).toBeUndefined();
    expect(result.groupPolicy).toBeUndefined();
    expect(result.inheritedToolPolicy).toEqual({ deny: ["message"] });
    expect(result.subagentPolicy).toBeDefined();
  });

  it("uses a persisted projection for a spawn-owned dashboard child", async () => {
    const parentSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:dashboard:visible-child";
    await writeSession(childSessionKey, {
      spawnedBy: parentSessionKey,
      parentSessionKey,
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "sessions_spawn"],
      inheritedToolDeny: ["exec"],
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: childSessionKey,
      spawnedBy: parentSessionKey,
    });

    expect(result.delegated).toBe(true);
    expect(result.requesterPolicySource).toBe("persisted-child");
    expect(result.senderPolicy).toBeUndefined();
    expect(result.groupPolicy).toBeUndefined();
    expect(result.inheritedToolPolicy).toEqual({
      allow: ["read", "sessions_spawn"],
      deny: ["exec"],
    });
    expect(result.subagentPolicy).toBeDefined();
  });

  it("keeps the sender snapshot while applying current non-sender restrictions", async () => {
    const childSessionKey = "agent:main:subagent:web-search";
    await writeSession(childSessionKey, {
      spawnedBy: "agent:main:discord:direct:alice",
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
    });
    const cfg = config({
      tools: {
        toolsBySender: {
          "*": { deny: ["web_search"] },
          "id:alice": {},
        },
      },
    });

    expect(
      resolveWebSearchToolPolicy({
        config: cfg,
        agentId: "main",
        sessionKey: childSessionKey,
      }),
    ).toEqual({ allowed: true, persistentAllowed: true });
    expect(
      resolveWebSearchToolPolicy({
        config: config({
          tools: {
            deny: ["web_search"],
            toolsBySender: {
              "*": { deny: ["web_search"] },
              "id:alice": {},
            },
          },
        }),
        agentId: "main",
        sessionKey: childSessionKey,
      }),
    ).toEqual({ allowed: false, persistentAllowed: false });
    expect(
      resolveWebSearchToolPolicy({
        config: cfg,
        agentId: "main",
        sessionKey: "agent:main:subagent:forged",
      }),
    ).toEqual({ allowed: false, persistentAllowed: false });
  });

  it.each([
    { label: "default", runtimeToolAllowlist: undefined, allowed: true },
    { label: "no tools", runtimeToolAllowlist: [], allowed: false },
    { label: "message only", runtimeToolAllowlist: ["message"], allowed: false },
    { label: "wildcard", runtimeToolAllowlist: ["*"], allowed: true },
    { label: "explicit web search", runtimeToolAllowlist: ["web_search"], allowed: true },
    { label: "web tool group", runtimeToolAllowlist: ["group:web"], allowed: true },
    {
      label: "intersected wildcard",
      runtimeToolAllowlist: attachToolAllowlistIntersection(["*", "message"], [["*"], ["message"]]),
      allowed: false,
    },
  ])(
    "enforces $label web-search authority for the current turn",
    ({ runtimeToolAllowlist, allowed }) => {
      expect(resolveWebSearchToolPolicy({ runtimeToolAllowlist })).toEqual({
        allowed,
        persistentAllowed: true,
      });
    },
  );

  it("does not re-resolve group sender policy for a verified child", async () => {
    const parentSessionKey = "agent:main:telegram:group:dev";
    const childSessionKey = "agent:main:subagent:group-child";
    await writeSession(childSessionKey, {
      spawnedBy: parentSessionKey,
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
    });
    const cfg = config({
      channels: {
        telegram: {
          groups: {
            dev: {
              toolsBySender: {
                "*": { deny: ["read"] },
                "id:alice": {},
              },
            },
          },
        },
      },
    });

    const child = resolveRequesterToolPolicies({
      config: cfg,
      agentId: "main",
      sessionKey: childSessionKey,
      spawnedBy: parentSessionKey,
      messageProvider: "telegram",
      groupId: "dev",
    });
    const forged = resolveRequesterToolPolicies({
      config: cfg,
      agentId: "main",
      sessionKey: "agent:main:subagent:forged",
      spawnedBy: parentSessionKey,
      messageProvider: "telegram",
      groupId: "dev",
    });

    expect(child.delegated).toBe(true);
    expect(child.groupPolicy).toBeUndefined();
    expect(forged.delegated).toBe(false);
    expect(forged.groupPolicy).toEqual({ deny: ["read"] });
  });

  it("does not trust a subagent-shaped key without a persisted envelope", () => {
    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: "agent:main:subagent:forged",
    });

    expect(result.delegated).toBe(false);
    expect(result.requesterPolicySource).toBe("current-request");
    expect(result.senderPolicy).toEqual({ deny: ["group:runtime", "group:fs"] });
    expect(result.subagentPolicy).toBeDefined();
  });

  it("does not trust partial persisted lineage as an authority envelope", async () => {
    const childSessionKey = "agent:main:subagent:partial";
    await writeSession(childSessionKey, {
      spawnedBy: "agent:main:discord:direct:alice",
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: childSessionKey,
    });

    expect(result.delegated).toBe(false);
    expect(result.requesterPolicySource).toBe("current-request");
    expect(result.senderPolicy).toEqual({ deny: ["group:runtime", "group:fs"] });
  });

  it("re-resolves sender policy for an unversioned legacy child envelope", async () => {
    const childSessionKey = "agent:main:subagent:legacy";
    await writeSession(childSessionKey, {
      spawnedBy: "agent:main:discord:direct:alice",
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolDeny: ["message"],
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: childSessionKey,
    });

    expect(result.delegated).toBe(false);
    expect(result.requesterPolicySource).toBe("current-request");
    expect(result.senderPolicy).toEqual({ deny: ["group:runtime", "group:fs"] });
    expect(result.inheritedToolPolicy).toEqual({ deny: ["message"] });
  });

  it.each([
    ["sender identity", { senderId: "bob" }],
    ["external provenance", { inputProvenance: { kind: "external_user" as const } }],
  ])("applies current policy to an existing child with %s", async (_label, externalFacts) => {
    const childSessionKey = "agent:main:subagent:external-turn";
    await writeSession(childSessionKey, {
      spawnedBy: "agent:main:discord:direct:alice",
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["message"],
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: childSessionKey,
      messageProvider: "discord",
      ...externalFacts,
    });

    expect(result.delegated).toBe(false);
    expect(result.requesterPolicySource).toBe("current-request");
    expect(result.senderPolicy).toEqual({ deny: ["group:runtime", "group:fs"] });
    expect(result.inheritedToolPolicy).toEqual({ deny: ["message"] });
  });

  it("treats an empty projection as valid only for verified lineage", async () => {
    const childSessionKey = "agent:main:subagent:unrestricted";
    await writeSession(childSessionKey, {
      spawnedBy: "agent:main:discord:direct:alice",
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: childSessionKey,
    });

    expect(result.delegated).toBe(true);
    expect(result.requesterPolicySource).toBe("persisted-child");
    expect(result.inheritedToolPolicy).toBeUndefined();
    expect(result.senderPolicy).toBeUndefined();
  });

  it("restores a verified completion handoff from the direct child projection", async () => {
    const requesterSessionKey = "agent:main:discord:direct:alice";
    const childSessionKey = "agent:main:subagent:child";
    await writeSession(childSessionKey, {
      spawnedBy: requesterSessionKey,
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "message"],
      inheritedToolDeny: ["exec"],
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: requesterSessionKey,
      ...completionHandoffFacts(childSessionKey, requesterSessionKey),
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: childSessionKey,
        sourceTool: "subagent_announce",
      },
    });

    expect(result.delegated).toBe(true);
    expect(result.requesterPolicySource).toBe("completion-handoff");
    expect(result.senderPolicy).toBeUndefined();
    expect(result.inheritedToolPolicy).toEqual({
      allow: ["read", "message"],
      deny: ["exec"],
    });
  });

  it("fails closed when a trusted internal handoff has no configuration", () => {
    expect(() =>
      resolveRequesterToolPolicies({
        agentId: "ops",
        sessionKey: "agent:ops:main",
        ...completionHandoffFacts("agent:ops:subagent:child", "agent:ops:main"),
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:ops:subagent:child",
          sourceTool: "subagent_announce",
        },
      }),
    ).toThrow("Trusted internal handoff policy resolution requires configuration.");
  });

  it("restores a verified completion handoff to a distinct immutable completion owner", async () => {
    const controllerSessionKey = "agent:main:discord:direct:alice";
    const completionOwnerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:child";
    await writeSession(childSessionKey, {
      spawnedBy: controllerSessionKey,
      completionOwnerSessionKey,
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "exec"],
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: completionOwnerSessionKey,
      ...completionHandoffFacts(childSessionKey, completionOwnerSessionKey),
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: childSessionKey,
        sourceTool: "subagent_announce",
      },
    });

    expect(result.delegated).toBe(true);
    expect(result.requesterPolicySource).toBe("completion-handoff");
    expect(result.senderPolicy).toBeUndefined();
    expect(result.inheritedToolPolicy).toEqual({ allow: ["read", "exec"] });

    const controllerResult = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: controllerSessionKey,
      ...completionHandoffFacts(childSessionKey, completionOwnerSessionKey),
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: childSessionKey,
        sourceTool: "subagent_announce",
      },
    });
    expect(controllerResult.delegated).toBe(false);
    expect(controllerResult.requesterPolicySource).toBe("current-request");
  });

  it("restores a visible dashboard child completion to its immutable owner", async () => {
    const controllerSessionKey = "agent:main:discord:direct:alice";
    const completionOwnerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:dashboard:visible-child";
    await writeSession(childSessionKey, {
      spawnedBy: controllerSessionKey,
      completionOwnerSessionKey,
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "message"],
      inheritedToolDeny: ["exec"],
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: completionOwnerSessionKey,
      ...completionHandoffFacts(childSessionKey, completionOwnerSessionKey),
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: childSessionKey,
        sourceTool: "subagent_announce",
      },
    });

    expect(result).toMatchObject({
      delegated: true,
      requesterPolicySource: "completion-handoff",
      inheritedToolPolicy: {
        allow: ["read", "message"],
        deny: ["exec"],
      },
    });
  });

  it("does not treat an ordinary dashboard key as a completion authority", async () => {
    const childSessionKey = "agent:main:dashboard:operator-thread";
    await writeSession(childSessionKey, { spawnDepth: 0 });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: "agent:main:main",
      ...completionHandoffFacts(childSessionKey, "agent:main:main"),
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: childSessionKey,
        sourceTool: "subagent_announce",
      },
    });

    expect(result.delegated).toBe(false);
    expect(result.requesterPolicySource).toBe("current-request");
  });

  it("walks nested lineage to the projection captured from the target requester", async () => {
    const requesterSessionKey = "agent:main:discord:direct:alice";
    const parentChildSessionKey = "agent:main:subagent:parent-child";
    const leafSessionKey = "agent:main:subagent:leaf";
    await writeSession(parentChildSessionKey, {
      spawnedBy: requesterSessionKey,
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["exec"],
    });
    await writeSession(leafSessionKey, {
      spawnedBy: parentChildSessionKey,
      spawnDepth: 2,
      subagentRole: "leaf",
      subagentControlScope: "none",
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["exec", "read"],
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: requesterSessionKey,
      ...completionHandoffFacts(leafSessionKey, requesterSessionKey),
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: leafSessionKey,
        sourceTool: "subagent_announce",
      },
    });

    expect(result.delegated).toBe(true);
    expect(result.requesterPolicySource).toBe("completion-handoff");
    expect(result.inheritedToolPolicy).toEqual({ deny: ["exec"] });
  });

  it("prioritizes a verified nested completion over the target subagent resume envelope", async () => {
    const requesterSessionKey = "agent:main:discord:direct:alice";
    const parentChildSessionKey = "agent:main:subagent:parent-child";
    const leafSessionKey = "agent:main:subagent:leaf";
    await writeSession(parentChildSessionKey, {
      spawnedBy: requesterSessionKey,
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["exec"],
    });
    await writeSession(leafSessionKey, {
      spawnedBy: parentChildSessionKey,
      spawnDepth: 2,
      subagentRole: "leaf",
      subagentControlScope: "none",
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["exec", "read"],
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: parentChildSessionKey,
      subagentSessionKey: parentChildSessionKey,
      ...completionHandoffFacts(leafSessionKey, parentChildSessionKey),
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: leafSessionKey,
        sourceTool: "subagent_announce",
      },
    });

    expect(result.delegated).toBe(true);
    expect(result.requesterPolicySource).toBe("completion-handoff");
    expect(result.inheritedToolPolicy).toEqual({ deny: ["exec", "read"] });
  });

  it("fails closed for untrusted or mismatched completion handoffs", async () => {
    const childSessionKey = "agent:main:subagent:child";
    await writeSession(childSessionKey, {
      spawnedBy: "agent:main:discord:direct:alice",
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
    });
    const provenance = {
      kind: "inter_session" as const,
      sourceSessionKey: childSessionKey,
      sourceTool: "subagent_announce",
    };

    const untrusted = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: "agent:main:discord:direct:alice",
      inputProvenance: provenance,
    });
    const mismatched = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: "agent:main:discord:direct:bob",
      ...completionHandoffFacts(childSessionKey, "agent:main:discord:direct:alice"),
      inputProvenance: provenance,
    });
    const mismatchedCompletionOwner = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: "agent:main:main",
      ...completionHandoffFacts(childSessionKey, "agent:main:discord:direct:alice"),
      inputProvenance: provenance,
    });

    expect(untrusted.delegated).toBe(false);
    expect(untrusted.requesterPolicySource).toBe("current-request");
    expect(untrusted.senderPolicy).toEqual({ deny: ["group:runtime", "group:fs"] });
    expect(mismatched.delegated).toBe(false);
    expect(mismatched.requesterPolicySource).toBe("current-request");
    expect(mismatched.senderPolicy).toEqual({ deny: ["group:runtime", "group:fs"] });
    expect(mismatchedCompletionOwner.delegated).toBe(false);
    expect(mismatchedCompletionOwner.requesterPolicySource).toBe("current-request");
  });

  it("re-resolves sender policy for completion from an unversioned legacy child", async () => {
    const requesterSessionKey = "agent:main:discord:direct:alice";
    const childSessionKey = "agent:main:subagent:legacy-completion";
    await writeSession(childSessionKey, {
      spawnedBy: requesterSessionKey,
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolAllow: ["read", "exec"],
    });

    const result = resolveRequesterToolPolicies({
      config: config(),
      agentId: "main",
      sessionKey: requesterSessionKey,
      ...completionHandoffFacts(childSessionKey, requesterSessionKey),
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: childSessionKey,
        sourceTool: "subagent_announce",
      },
    });

    expect(result.delegated).toBe(false);
    expect(result.requesterPolicySource).toBe("current-request");
    expect(result.senderPolicy).toEqual({ deny: ["group:runtime", "group:fs"] });
  });
});
