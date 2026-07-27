// System-agent TUI operation tests cover handoff and return-to-shell behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { executeSystemAgentOperation, isPersistentSystemAgentOperation } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.test-helpers.js";

describe("system-agent TUI operations", () => {
  it("refuses doctor repairs before any write or audit", async () => {
    await withTempHome(async (home) => {
      const { runtime, lines } = createSystemAgentTestRuntime();
      const runDoctor = vi.fn(async () => {});

      const result = await executeSystemAgentOperation({ kind: "doctor-fix" }, runtime, {
        approved: true,
        deps: { runDoctor },
        auditDetails: { rescue: true },
      });
      expect(result).toEqual({ applied: false });
      expect(isPersistentSystemAgentOperation({ kind: "doctor-fix" })).toBe(false);
      expect(runDoctor).not.toHaveBeenCalled();
      expect(lines.join("\n")).toContain("Exit OpenClaw");
      expect(lines.join("\n")).toContain("openclaw doctor --fix");
      expect(lines.join("\n")).not.toContain("[openclaw] running: doctor.fix");
      await expect(
        fs.access(path.join(home, ".openclaw", "audit", "system-agent.jsonl")),
      ).rejects.toThrow();
    });
  });

  it("returns from the agent TUI back to OpenClaw", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runTui = vi.fn(async () => ({
      exitReason: "return-to-system-agent" as const,
      systemAgentMessage: "restart gateway",
    }));

    const result = await executeSystemAgentOperation(
      { kind: "open-tui", agentId: "work" },
      runtime,
      { deps: { runTui } },
    );

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      session: "agent:work:main",
      deliver: false,
      historyLimit: 200,
    });
    expect(result).toMatchObject({
      applied: false,
      returnToShell: true,
      nextInput: "restart gateway",
    });
    expect(lines.join("\n")).toContain(
      "[openclaw] returned from agent with request: restart gateway",
    );
  });

  it("seeds a fresh hatch into the agent TUI", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    const runTui = vi.fn(async () => ({ exitReason: "exit" as const }));

    await executeSystemAgentOperation(
      { kind: "open-tui", agentId: "work", agentDraft: "hatch" },
      runtime,
      { deps: { runTui } },
    );

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      session: "agent:work:main",
      deliver: false,
      historyLimit: 200,
      message: "Wake up, my friend!",
    });
  });

  it("re-enters the OpenClaw shell when the agent TUI returns without a request", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runTui = vi.fn(async () => ({
      exitReason: "return-to-system-agent" as const,
    }));

    const result = await executeSystemAgentOperation({ kind: "open-tui" }, runtime, {
      deps: { runTui },
    });

    expect(result).toMatchObject({
      applied: false,
      returnToShell: true,
    });
    expect((result as { nextInput?: string }).nextInput).toBeUndefined();
    expect(lines.join("\n")).toContain("[openclaw] returned from agent");
  });
});
