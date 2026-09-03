import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNodeExecutionTarget } from "../../agents/bash-tools.exec-host-node-phases.js";
import type { ExecuteNodeHostCommandParams } from "../../agents/bash-tools.exec-host-node.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { resolveWorkerToolAuthority } from "./worker-tool-authority.js";

const gatewayMocks = vi.hoisted(() => ({ callGatewayTool: vi.fn() }));

vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
}));

function turn(overrides: Partial<SessionPlacementTurnParams> = {}): SessionPlacementTurnParams {
  return {
    sessionId: "session-worker-authority",
    sessionKey: "agent:main:cron:job:run:session",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "run",
    timeoutMs: 1_000,
    runId: "run-worker-authority",
    provider: "openai",
    model: "gpt-test",
    agentId: "main",
    ...overrides,
  } as SessionPlacementTurnParams;
}

function authority(overrides: Partial<SessionPlacementTurnParams> = {}, portalAvailable = false) {
  return resolveWorkerToolAuthority({
    modelRef: { provider: "openai", model: "gpt-test" },
    turn: turn(overrides),
    portalAvailable,
  }).allowedToolNames;
}

function resolvedAuthority(overrides: Partial<SessionPlacementTurnParams> = {}) {
  return resolveWorkerToolAuthority({
    modelRef: { provider: "openai", model: "gpt-test" },
    turn: turn(overrides),
  });
}

afterEach(() => {
  gatewayMocks.callGatewayTool.mockReset();
});

describe("resolveWorkerToolAuthority", () => {
  it.each([
    { modelHasVision: true, allowed: true },
    { modelHasVision: false, allowed: false },
    { modelHasVision: undefined, allowed: true },
  ])(
    "applies prepared model vision capability ($modelHasVision)",
    ({ modelHasVision, allowed }) => {
      const tools = resolveWorkerToolAuthority({
        modelRef: { provider: "openai", model: "gpt-test" },
        turn: turn({ modelHasVision, toolsAllow: ["computer", "browser"] }),
        availableOptionalToolNames: ["computer", "browser"],
      }).allowedToolNames;
      expect(tools.includes("computer")).toBe(allowed);
      expect(tools).toContain("browser");
    },
  );

  it.each([
    { name: "default", tools: {}, allowed: true },
    {
      name: "additive sandbox tools",
      tools: { sandbox: { tools: { alsoAllow: ["web_fetch"] } } },
      allowed: true,
    },
    {
      name: "explicit sandbox allow",
      tools: { sandbox: { tools: { allow: ["read"] } } },
      allowed: false,
    },
    {
      name: "explicit sandbox deny",
      tools: { sandbox: { tools: { deny: ["computer"] } } },
      allowed: false,
    },
    { name: "global deny", tools: { deny: ["computer"] }, allowed: false },
    { name: "coding profile", tools: { profile: "coding" as const }, allowed: false },
  ])("respects $name policy for a prepared sandbox-contained desktop", ({ tools, allowed }) => {
    const turnParams = turn({
      sessionKey: "agent:main:worker-sandboxed",
      config: { agents: { defaults: { sandbox: { mode: "all" } } }, tools },
    });
    const params = { modelRef: { provider: "openai", model: "gpt-test" }, turn: turnParams };
    expect(resolveWorkerToolAuthority(params).allowedToolNames).not.toContain("computer");
    expect(
      resolveWorkerToolAuthority({
        ...params,
        availableOptionalToolNames: ["computer"],
      }).allowedToolNames.includes("computer"),
    ).toBe(allowed);
  });

  it.each([
    {
      name: "explicit deny",
      exec: { security: "deny" as const, ask: "off" as const },
      expected: { security: "deny", ask: "off" },
    },
    {
      name: "allowlist mode",
      exec: { mode: "allowlist" as const },
      expected: { security: "allowlist", ask: "off" },
    },
  ])(
    "carries effective exec authority for $name instead of only the tool name",
    ({ exec, expected }) => {
      const resolved = resolvedAuthority({
        config: { tools: { exec } },
        toolsAllow: ["exec", "process"],
      });

      expect(resolved.allowedToolNames).toEqual(["exec", "process"]);
      expect(resolved.exec).toMatchObject(expected);
    },
  );

  it.each(["sandbox", "node"] as const)(
    "emits reachable %s-host authority that the worker consumer must honor",
    (host) => {
      expect(
        resolvedAuthority({
          config: { tools: { exec: { host, mode: "full" } } },
          toolsAllow: ["exec", "process"],
        }),
      ).toMatchObject({
        allowedToolNames: ["exec", "process"],
        exec: { host, security: "full", ask: "off" },
      });
    },
  );

  it.each([
    {
      name: "deny",
      execSession: { permissionMode: "read-only" as const },
      expected: { host: "gateway", security: "deny", ask: "off" },
    },
    {
      name: "approval",
      execSession: { permissionMode: "guarded" as const },
      expected: { host: "gateway", security: "allowlist", ask: "on-miss" },
    },
    {
      name: "node binding",
      execSession: {
        execHost: "node" as const,
        execNode: "session-node",
        execCwd: " /remote/session/workspace ",
      },
      expected: {
        host: "node",
        security: "full",
        ask: "off",
        node: "session-node",
        nodeCwd: "/remote/session/workspace",
      },
    },
  ])("preserves session-owned exec $name at the worker boundary", ({ execSession, expected }) => {
    expect(
      resolvedAuthority({
        config: { tools: { exec: { host: "gateway", mode: "full" } } },
        execSession,
        toolsAllow: ["exec", "process"],
      }).exec,
    ).toEqual(expected);
  });

  it.each([
    {
      name: "resolved node differs from the session binding",
      execOverrides: { host: "node" as const, node: "other-node" },
      expectedHost: "node",
    },
    {
      name: "resolved host is not node",
      execOverrides: { host: "gateway" as const },
      expectedHost: "gateway",
    },
  ])("omits the session node cwd when $name", ({ execOverrides, expectedHost }) => {
    const exec = resolvedAuthority({
      execSession: {
        execHost: "node",
        execNode: "session-node",
        execCwd: "/remote/session/workspace",
      },
      execOverrides,
    }).exec;

    expect(exec?.host).toBe(expectedHost);
    expect(exec).not.toHaveProperty("nodeCwd");
  });

  it("keeps the resolved node binding authoritative when a worker request names another node", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      nodes: [
        {
          nodeId: "bound-node",
          displayName: "Bound Node",
          platform: process.platform,
          commands: ["system.run"],
        },
        {
          nodeId: "other-node",
          displayName: "Other Node",
          platform: process.platform,
          commands: ["system.run"],
        },
      ],
    });
    const resolved = resolvedAuthority({
      config: { tools: { exec: { host: "node", mode: "full", node: "bound-node" } } },
      toolsAllow: ["exec", "process"],
    });
    if (resolved.exec?.host !== "node") {
      throw new Error("expected node-host worker authority");
    }
    const request = {
      command: "echo worker-node-binding",
      workdir: undefined,
      env: {},
      requestedNode: "other-node",
      boundNode: resolved.exec.node,
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
    } satisfies ExecuteNodeHostCommandParams;

    await expect(resolveNodeExecutionTarget(request)).rejects.toThrow(
      "exec node not allowed (bound to bound-node, requested resolved to other-node)",
    );
  });

  it("still carries exec authority when every tool is withheld", () => {
    expect(resolvedAuthority({ disableTools: true })).toMatchObject({
      allowedToolNames: [],
      exec: { security: "full", ask: "off" },
    });
  });

  it("keeps the deterministic complete worker surface when no policy narrows it", () => {
    expect(authority()).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
      "sessions_spawn",
      "sessions_send",
    ]);
  });

  it("adds the optional browser surface only when the launcher makes it available", () => {
    expect(
      resolveWorkerToolAuthority({
        modelRef: { provider: "openai", model: "gpt-test" },
        turn: turn(),
        availableOptionalToolNames: ["browser"],
      }).allowedToolNames,
    ).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
      "browser",
      "sessions_spawn",
      "sessions_send",
    ]);
    expect(
      resolveWorkerToolAuthority({
        modelRef: { provider: "openai", model: "gpt-test" },
        turn: turn({ toolsAllow: ["browser"] }),
        availableOptionalToolNames: ["browser"],
      }).allowedToolNames,
    ).toEqual(["browser"]);
    expect(authority({ toolsAllow: ["browser"] })).toEqual([]);
  });

  it("projects runtime caps with canonical write-to-apply_patch semantics", () => {
    expect(authority({ toolsAllow: ["write"] })).toEqual(["write", "apply_patch"]);
    expect(authority({ toolsAllow: [] })).toEqual([]);
    expect(authority({ toolsAllow: ["web_search"] })).toEqual([]);
    expect(authority({ toolsAllow: ["sessions_send"] })).toEqual(["sessions_send"]);
    expect(authority({ toolsAllow: ["portal"] })).toEqual([]);
    expect(authority({ toolsAllow: ["portal"] }, true)).toEqual(["portal"]);
  });

  it("exposes portals only for SSH-backed placements and allowed capability policy", () => {
    expect(authority()).not.toContain("portal");
    expect(authority({}, true)).toContain("portal");
    expect(authority({ config: { tools: { deny: ["portal"] } } }, true)).not.toContain("portal");
    expect(
      authority(
        {
          sessionKey: "agent:main:worker-sandboxed",
          config: {
            agents: { defaults: { sandbox: { mode: "all" } } },
            tools: { sandbox: { tools: { deny: ["portal"] } } },
          },
        },
        true,
      ),
    ).not.toContain("portal");
  });

  it("uses scheduled owner group policy without reapplying fresh sender overlays", () => {
    const config = {
      tools: {
        deny: ["exec"],
        toolsBySender: { "*": { deny: ["write", "apply_patch"] } },
      },
      channels: {
        whatsapp: {
          groups: {
            team: {
              tools: { allow: ["read", "write", "exec"] },
              toolsBySender: { "*": { deny: ["write", "apply_patch"] } },
            },
          },
        },
      },
    } as SessionPlacementTurnParams["config"];

    expect(
      authority({
        config,
        messageProvider: "whatsapp",
        senderId: "guest",
        toolsAllow: ["read", "write", "exec"],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:whatsapp:group:team",
          ownerAccountId: "default",
        },
      }),
    ).toEqual(["read", "write", "apply_patch"]);
    expect(
      authority({
        config,
        messageProvider: "whatsapp",
        senderId: "guest",
        toolsAllow: ["read", "write", "exec"],
      }),
    ).toEqual(["read"]);
  });

  it("re-resolves current owner-group restrictions for every scheduled turn", () => {
    expect(
      authority({
        config: {
          channels: {
            whatsapp: {
              groups: { team: { tools: { deny: ["write", "apply_patch"] } } },
            },
          },
        },
        messageProvider: "whatsapp",
        toolsAllow: ["write"],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:whatsapp:group:team",
          ownerAccountId: "default",
        },
      }),
    ).toEqual([]);
  });

  it("applies sandbox tool policy when the session is configured for sandboxing", () => {
    expect(
      authority({
        sessionKey: "agent:main:worker-sandboxed",
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { sandbox: { tools: { allow: ["read"] } } },
        },
      }),
    ).toEqual(["read"]);
  });

  it.each([{ disableTools: true }, { modelRun: true }, { promptMode: "none" as const }])(
    "exposes no tools for non-tool run mode %#",
    (overrides) => {
      expect(authority(overrides)).toEqual([]);
    },
  );
});
