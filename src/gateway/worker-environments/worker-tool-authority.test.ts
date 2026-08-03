import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import * as execApprovals from "../../infra/exec-approvals.js";
import { resolveWorkerToolAuthority } from "./worker-tool-authority.js";

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

function authority(overrides: Partial<SessionPlacementTurnParams> = {}) {
  return resolveWorkerToolAuthority({
    modelRef: { provider: "openai", model: "gpt-test" },
    turn: turn(overrides),
  }).allowedToolNames;
}

describe("resolveWorkerToolAuthority", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(execApprovals, "loadExecApprovals").mockReturnValue({
      version: 1,
      agents: {},
    });
  });

  it("keeps the deterministic complete worker surface when no policy narrows it", () => {
    expect(authority()).toEqual(["read", "write", "edit", "apply_patch", "exec", "process"]);
  });

  it("projects runtime caps with canonical write-to-apply_patch semantics", () => {
    expect(authority({ toolsAllow: ["write"] })).toEqual(["write", "apply_patch"]);
    expect(authority({ toolsAllow: [] })).toEqual([]);
    expect(authority({ toolsAllow: ["web_search"] })).toEqual([]);
  });

  it("does not load exec state when the projected authority has no shell tools", () => {
    vi.mocked(execApprovals.loadExecApprovals).mockImplementation(() => {
      throw new Error("legacy exec state requires doctor migration");
    });

    expect(authority({ toolsAllow: ["read"] })).toEqual(["read"]);
    expect(execApprovals.loadExecApprovals).not.toHaveBeenCalled();
  });

  it.each([
    ["deny", { mode: "deny" as const }],
    ["allowlist", { mode: "allowlist" as const }],
    ["ask", { mode: "ask" as const }],
    ["auto", { mode: "auto" as const }],
    ["full with approval", { security: "full" as const, ask: "always" as const }],
  ])("gates worker shell tools for restrictive exec policy: %s", (_label, exec) => {
    expect(authority({ config: { tools: { exec } } })).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
    ]);
  });

  it("gates worker shell tools when host approval state restricts full config", () => {
    vi.mocked(execApprovals.loadExecApprovals).mockReturnValue({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss" },
      agents: {},
    });

    expect(authority({ config: { tools: { exec: { host: "gateway", mode: "full" } } } })).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
    ]);
  });

  it.each([
    ["config", { config: { tools: { exec: { host: "node" as const, mode: "full" as const } } } }],
    [
      "session override",
      { execOverrides: { host: "node" as const, security: "full" as const, ask: "off" as const } },
    ],
  ])("gates worker shell tools for node-targeted exec from %s", (_label, overrides) => {
    expect(authority(overrides)).toEqual(["read", "write", "edit", "apply_patch"]);
  });

  it("gates worker shell tools when the configured sandbox host is unavailable", () => {
    expect(authority({ config: { tools: { exec: { host: "sandbox", mode: "full" } } } })).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
    ]);
  });

  it("uses the source sandbox state when resolving worker exec authority", () => {
    expect(
      authority({
        sessionKey: "agent:main:worker-sandboxed",
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
      }),
    ).toEqual(["read", "write", "edit", "apply_patch", "exec", "process"]);
    expect(
      authority({
        sessionKey: "agent:main:worker-sandboxed",
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { exec: { host: "gateway", mode: "full" } },
        },
      }),
    ).toEqual(["read", "write", "edit", "apply_patch", "exec", "process"]);
    expect(
      authority({
        sessionKey: "agent:main:worker-sandboxed",
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { exec: { host: "sandbox", mode: "full" } },
        },
      }),
    ).toEqual(["read", "write", "edit", "apply_patch", "exec", "process"]);
  });

  it.each([
    ["mode", { mode: "deny" as const }],
    ["security", { security: "deny" as const }],
  ])("gates sandbox shell tools for explicit %s denial", (_label, exec) => {
    expect(
      authority({
        sessionKey: "agent:main:worker-sandboxed-denied",
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { exec },
        },
      }),
    ).toEqual(["read", "write", "edit", "apply_patch"]);
  });

  it.each(["auto", "ask", "allowlist"] as const)(
    "keeps sandbox-local shell authority for mode %s",
    (mode) => {
      expect(
        authority({
          sessionKey: "agent:main:worker-sandboxed-local",
          config: {
            agents: { defaults: { sandbox: { mode: "all" } } },
            tools: { exec: { mode } },
          },
        }),
      ).toEqual(["read", "write", "edit", "apply_patch", "exec", "process"]);
    },
  );

  it.each(["on", "ask", "full"] as const)(
    "applies the host approval floor for sandboxed default elevation: %s",
    (defaultLevel) => {
      vi.mocked(execApprovals.loadExecApprovals).mockReturnValue({
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss" },
        agents: {},
      });

      expect(
        authority({
          sessionKey: "agent:main:worker-sandboxed-elevated",
          config: {
            agents: { defaults: { sandbox: { mode: "all" } } },
            tools: { exec: { host: "auto", mode: "full" } },
          },
          bashElevated: { enabled: true, allowed: true, defaultLevel },
        }),
      ).toEqual(["read", "write", "edit", "apply_patch"]);
    },
  );

  it.each(["on", "ask", "full"] as const)(
    "keeps unconditional shell authority after default elevation routes to the Gateway: %s",
    (defaultLevel) => {
      expect(
        authority({
          sessionKey: "agent:main:worker-sandboxed-elevated",
          config: {
            agents: { defaults: { sandbox: { mode: "all" } } },
            tools: { exec: { host: "auto", mode: "full" } },
          },
          bashElevated: { enabled: true, allowed: true, defaultLevel },
        }),
      ).toEqual(["read", "write", "edit", "apply_patch", "exec", "process"]);
    },
  );

  it.each([
    ["off", { enabled: true, allowed: true, defaultLevel: "off" as const }],
    ["disallowed", { enabled: true, allowed: false, defaultLevel: "on" as const }],
  ])("does not route sandbox-local exec through Gateway elevation when %s", (_label, elevated) => {
    expect(
      authority({
        sessionKey: "agent:main:worker-sandboxed-not-elevated",
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { exec: { host: "sandbox", mode: "full" } },
        },
        bashElevated: elevated,
      }),
    ).toEqual(["read", "write", "edit", "apply_patch", "exec", "process"]);
    expect(execApprovals.loadExecApprovals).not.toHaveBeenCalled();
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
