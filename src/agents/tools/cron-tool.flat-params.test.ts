// Cron flat-parameter tests cover model-friendly shorthand recovery before
// gateway cron RPC dispatch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayToolMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
}));

vi.mock("../agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-scope.js")>("../agent-scope.js");
  return {
    ...actual,
    resolveSessionAgentId: actual.resolveSessionAgentId,
  };
});

import { getToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { createCronTool } from "./cron-tool.js";

describe("cron tool flat-params", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
    callGatewayToolMock.mockResolvedValue({ ok: true });
  });

  function firstGatewayToolCall<TParams>(): [string, unknown, TParams] {
    const call = callGatewayToolMock.mock.calls[0];
    if (!call) {
      throw new Error("expected callGatewayTool to be called");
    }
    return call as [string, unknown, TParams];
  }

  it("presents read-only cron metadata without job content", () => {
    const tool = createCronTool();
    const terminalPresentation = getToolTerminalPresentation(tool);
    if (!terminalPresentation) {
      throw new Error("expected cron terminal presentation");
    }

    expect(
      terminalPresentation(
        { action: "list" },
        {
          content: [],
          details: {
            total: 2,
            jobs: [
              { id: "one", name: "private reminder", payload: { text: "secret" } },
              { id: "two", name: "another reminder" },
            ],
          },
        },
      ),
    ).toEqual({ text: "Cron jobs listed.\nCount: 2" });
    expect(
      terminalPresentation(
        { action: "list" },
        {
          content: [],
          details: {
            total: 250,
            jobs: [{ id: "one" }, { id: "two" }],
          },
        },
      ),
    ).toEqual({ text: "Cron jobs listed.\nCount: 250" });
    expect(
      terminalPresentation(
        { action: "add" },
        { content: [], details: { id: "three", name: "private reminder" } },
      ),
    ).toBeUndefined();
  });

  it("preserves explicit top-level sessionKey during flat-params recovery", async () => {
    const tool = createCronTool(
      { agentSessionKey: "agent:main:discord:channel:ops" },
      { callGatewayTool: callGatewayToolMock },
    );
    await tool.execute("call-flat-session-key", {
      action: "add",
      sessionKey: "agent:main:telegram:group:-100123:topic:99",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      message: "do stuff",
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{ sessionKey?: string }>();
    expect(method).toBe("cron.add");
    expect(params.sessionKey).toBe("agent:main:telegram:group:-100123:topic:99");
  });

  it("recovers flat cron schedule shorthand for add", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-flat-cron-add", {
      action: "add",
      name: "hourly report",
      cron: "0 * * * *",
      tz: "UTC",
      staggerMs: 5000,
      message: "send report",
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      schedule?: unknown;
      payload?: unknown;
    }>();
    expect(method).toBe("cron.add");
    expect(params.schedule).toEqual({
      kind: "cron",
      expr: "0 * * * *",
      tz: "UTC",
      staggerMs: 5000,
    });
    expect(params.payload).toEqual({
      kind: "agentTurn",
      message: "send report",
    });
  });

  it("recovers a flat trigger when adding a job", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-flat-trigger-add", {
      action: "add",
      name: "watcher",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "report the change",
      trigger: { script: "json({ fire: false })", once: true },
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      trigger?: { script?: string; once?: boolean };
    }>();
    expect(method).toBe("cron.add");
    expect(params.trigger).toEqual({ script: "json({ fire: false })", once: true });
  });

  it("rejects flat on-exit schedule shorthand for add", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await expect(
      tool.execute("call-flat-onexit-add", {
        action: "add",
        name: "rebuild on exit",
        kind: "on-exit",
        command: "pnpm build",
        cwd: "/repo",
        message: "rebuilt",
      }),
    ).rejects.toThrow("cron on-exit schedules cannot be created or edited");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects flat command schedule shorthand for add", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await expect(
      tool.execute("call-flat-onexit-infer", {
        action: "add",
        name: "watch build",
        command: "make",
        message: "done",
      }),
    ).rejects.toThrow("cron on-exit schedules cannot be created or edited");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects flat on-exit schedule shorthand for update", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await expect(
      tool.execute("call-flat-onexit-update", {
        action: "update",
        jobId: "job-onexit",
        kind: "on-exit",
        command: "pnpm build",
        cwd: "/repo",
      }),
    ).rejects.toThrow("cron on-exit schedules cannot be created or edited");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects flat command schedule shorthand for update", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await expect(
      tool.execute("call-flat-onexit-update-infer", {
        action: "update",
        jobId: "job-infer",
        command: "make",
      }),
    ).rejects.toThrow("cron on-exit schedules cannot be created or edited");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("passes local cron wall-clock expression and timezone through add", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-local-cron-add", {
      action: "add",
      name: "shanghai reminder",
      cron: "0 18 * * *",
      tz: "Asia/Shanghai",
      message: "send reminder",
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      schedule?: unknown;
    }>();
    expect(method).toBe("cron.add");
    expect(params.schedule).toEqual({
      kind: "cron",
      expr: "0 18 * * *",
      tz: "Asia/Shanghai",
    });
  });

  it("leaves out-of-range flat atMs for gateway validation", async () => {
    // The gateway owns final schedule validation; flat recovery should preserve
    // the supplied value instead of silently coercing an invalid date.
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });
    const invalidAtMs = 8_640_000_000_000_001;

    await tool.execute("call-flat-invalid-atms-add", {
      action: "add",
      name: "bad date",
      atMs: invalidAtMs,
      message: "send reminder",
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      schedule?: { at?: unknown; kind?: unknown };
    }>();
    expect(method).toBe("cron.add");
    expect(params.schedule).toEqual({ kind: "at", at: invalidAtMs });
  });

  it("recovers flat cron schedule shorthand for update", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-flat-cron-update", {
      action: "update",
      jobId: "job-123",
      cron: "15 8 * * 1-5",
      tz: "America/Los_Angeles",
      staggerMs: 30_000,
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      id?: string;
      patch?: { schedule?: unknown };
    }>();
    expect(method).toBe("cron.update");
    expect(params.id).toBe("job-123");
    expect(params.patch?.schedule).toEqual({
      kind: "cron",
      expr: "15 8 * * 1-5",
      tz: "America/Los_Angeles",
      staggerMs: 30_000,
    });
  });

  it("recovers a flat trigger when updating a job", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-flat-trigger-update", {
      action: "update",
      jobId: "job-trigger",
      trigger: { script: "json({ fire: true })", once: false },
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      id?: string;
      patch?: { trigger?: { script?: string; once?: boolean } };
    }>();
    expect(method).toBe("cron.update");
    expect(params).toEqual({
      id: "job-trigger",
      patch: { trigger: { script: "json({ fire: true })", once: false } },
    });
  });

  it("recovers a flat trigger clear when updating a job", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-flat-trigger-clear", {
      action: "update",
      jobId: "job-trigger",
      trigger: null,
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      id?: string;
      patch?: { trigger?: null };
    }>();
    expect(method).toBe("cron.update");
    expect(params).toEqual({ id: "job-trigger", patch: { trigger: null } });
  });

  it("trims trailing whitespace from recognized job object keys (#95407)", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-trailing-space", {
      action: "add",
      job: {
        name: "Holiday Check-in",
        description: "Casual check-in",
        "schedule ": { kind: "cron", expr: "30 10,20 * * *", tz: "Europe/Madrid" },
        "sessionTarget ": "isolated",
        "payload ": { kind: "agentTurn", message: "How's it going?" },
        "enabled ": true,
      },
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      name?: string;
      schedule?: unknown;
      sessionTarget?: string;
      payload?: unknown;
      enabled?: boolean;
    }>();
    expect(method).toBe("cron.add");
    expect(params.name).toBe("Holiday Check-in");
    expect(params.schedule).toBeDefined();
    expect(params.sessionTarget).toBe("isolated");
    expect(params.payload).toBeDefined();
    expect(params.enabled).toBe(true);
    expect(params).not.toHaveProperty("schedule ");
    expect(params).not.toHaveProperty("sessionTarget ");
    expect(params).not.toHaveProperty("payload ");
    expect(params).not.toHaveProperty("enabled ");
  });

  it("trims trailing whitespace from recognized patch object keys (#95407)", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-patch-trailing-space", {
      action: "update",
      jobId: "job-123",
      patch: {
        "schedule ": { kind: "cron", expr: "0 9 * * 1-5", tz: "America/New_York" },
        "enabled ": false,
      },
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<{
      id?: string;
      patch?: { schedule?: unknown; enabled?: boolean };
    }>();
    expect(method).toBe("cron.update");
    expect(params.id).toBe("job-123");
    expect(params.patch?.schedule).toBeDefined();
    expect((params.patch?.schedule as Record<string, unknown>)?.kind).toBe("cron");
    expect(params.patch?.enabled).toBe(false);
    expect(params.patch).not.toHaveProperty("schedule ");
    expect(params.patch).not.toHaveProperty("enabled ");
  });

  it("does not trim unrecognized keys to prevent prototype pollution (#95407)", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-unsafe-keys", {
      action: "add",
      job: {
        name: "Safe trim",
        schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
        payload: { kind: "agentTurn", message: "work" },
        // Non-recognized keys with trailing spaces should NOT be trimmed
        // (prevents "__proto__ " → "__proto__" style attacks)
        "__proto__ ": { malicious: true },
        "constructor ": "should not be trimmed",
      },
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<Record<string, unknown>>();
    expect(method).toBe("cron.add");
    // Non-recognized padded keys should remain as-is
    expect(params).toHaveProperty("__proto__ ");
    expect(params).toHaveProperty("constructor ");
  });

  it("preserves padded duplicate when canonical key already exists (#95407)", async () => {
    // When both canonical and padded forms exist, the padded key is preserved
    // so strict gateway validation rejects the ambiguous input rather than
    // silently picking one value.
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-duplicate-keys", {
      action: "add",
      job: {
        name: "Duplicate test",
        schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" },
        // Both "schedule" and "schedule " exist — padded preserved for rejection
        "schedule ": { kind: "every", everyMs: 60000 },
        payload: { kind: "agentTurn", message: "work" },
        "enabled ": true,
        enabled: false,
      },
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<Record<string, unknown>>();
    expect(method).toBe("cron.add");
    // Canonical key is untouched
    expect((params.schedule as Record<string, unknown>)?.kind).toBe("cron");
    expect(params.enabled).toBe(false);
    // Padded keys are preserved so gateway schema validation sees the conflict
    // and rejects with "unexpected property 'schedule '" instead of silently
    // accepting one of the two conflicting values.
    expect(params).toHaveProperty("schedule ");
    expect(params).toHaveProperty("enabled ");
  });

  it("preserves normal keys without any whitespace", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: callGatewayToolMock });

    await tool.execute("call-clean-keys", {
      action: "add",
      job: {
        name: "Clean keys",
        schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
        payload: { kind: "agentTurn", message: "test" },
        enabled: true,
        description: "All keys should be preserved as-is",
      },
    });

    const [method, _gatewayOpts, params] = firstGatewayToolCall<Record<string, unknown>>();
    expect(method).toBe("cron.add");
    expect(params.name).toBe("Clean keys");
    expect(params.schedule).toBeDefined();
    expect(params.payload).toBeDefined();
    expect(params.enabled).toBe(true);
    expect(params.description).toBe("All keys should be preserved as-is");
  });
});
