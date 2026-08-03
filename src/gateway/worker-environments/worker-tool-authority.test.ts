import { describe, expect, it } from "vitest";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
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

function execPolicy(overrides: Partial<SessionPlacementTurnParams> = {}) {
  return resolveWorkerToolAuthority({
    modelRef: { provider: "openai", model: "gpt-test" },
    turn: turn(overrides),
  }).execPolicy;
}

describe("resolveWorkerToolAuthority", () => {
  it("keeps the deterministic complete worker surface when no policy narrows it", () => {
    expect(authority()).toEqual(["read", "write", "edit", "apply_patch", "exec", "process"]);
    expect(execPolicy()).toEqual({ mode: "full", security: "full", ask: "off" });
  });

  it("carries the effective exec mode independently of tool visibility", () => {
    expect(
      execPolicy({
        config: { tools: { exec: { security: "deny" } } },
      }),
    ).toEqual({ mode: "deny", security: "deny", ask: "off" });
    expect(
      execPolicy({
        config: { tools: { exec: { security: "full", ask: "always" } } },
      }),
    ).toEqual({ mode: "ask", security: "full", ask: "always" });
    expect(
      authority({
        config: { tools: { exec: { security: "deny" } } },
      }),
    ).toContain("exec");
  });

  it("keeps auto review distinct from ordinary ask with the same policy pair", () => {
    expect(execPolicy({ config: { tools: { exec: { mode: "auto" } } } })).toEqual({
      mode: "auto",
      security: "allowlist",
      ask: "on-miss",
    });
    expect(execPolicy({ config: { tools: { exec: { mode: "ask" } } } })).toEqual({
      mode: "ask",
      security: "allowlist",
      ask: "on-miss",
    });
  });

  it("projects runtime caps with canonical write-to-apply_patch semantics", () => {
    expect(authority({ toolsAllow: ["write"] })).toEqual(["write", "apply_patch"]);
    expect(authority({ toolsAllow: [] })).toEqual([]);
    expect(authority({ toolsAllow: ["web_search"] })).toEqual([]);
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
      expect(execPolicy(overrides)).toEqual({
        mode: "deny",
        security: "deny",
        ask: "off",
      });
    },
  );
});
