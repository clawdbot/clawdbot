import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  finalizeAgentToolAvailability,
  markAgentToolExecutionUnavailable,
} from "./agent-tool-availability.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import {
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { SWARM_CODE_MODE_IDEMPOTENCY_KEY } from "./subagents/swarm/swarm-code-mode.js";
import { createAgentsWaitTool } from "./tools/agents-wait-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("./subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: spawn,
}));
const config = { agents: { entries: { main: { default: true } } } };
function spawnTool(signal?: AbortSignal) {
  return createSessionsSpawnTool({
    config,
    agentSessionKey: "agent:main:main",
    requesterRunId: "parent",
    signal,
  });
}
function reader() {
  return createAgentsWaitTool({ config, agentSessionKey: "agent:main:main", agentId: "main" });
}

beforeEach(() => {
  spawn.mockReset().mockResolvedValue({
    status: "accepted",
    childSessionKey: "agent:main:subagent:child",
    runId: "child",
    context: "isolated",
  });
});

describe("collector tool availability", () => {
  it.each(["missing", "lookalike", "quarantined", "denied", "execution-denied"] as const)(
    "hides and refuses collection with a %s reader, without disabling ordinary spawning or fastMode",
    async (kind) => {
      const tool = spawnTool();
      const wait = reader();
      const candidate = kind === "lookalike" ? { ...wait } : wait;
      if (kind === "quarantined") {
        candidate.parameters = { type: "array", items: { type: "string" } };
      }
      if (kind === "execution-denied") {
        markAgentToolExecutionUnavailable(candidate);
      }
      finalizeAgentToolAvailability(
        [tool, ...(kind === "missing" ? [] : [candidate])],
        kind === "denied" ? { toolExecutionAllow: ["sessions_spawn"] } : undefined,
      );
      expect(tool.parameters).toHaveProperty("properties.fastMode");
      expect(tool.description).not.toContain("collect=true");
      for (const field of ["collect", "outputSchema", "groupId"]) {
        expect(tool.parameters).not.toHaveProperty(`properties.${field}`);
      }
      await expect(
        tool.execute("collect", {
          task: "inspect",
          collect: true,
          [SWARM_CODE_MODE_IDEMPOTENCY_KEY]: "copied",
        }),
      ).rejects.toThrow("Collector results are unavailable");
      expect(spawn).not.toHaveBeenCalled();
      await tool.execute("ordinary", { task: "inspect", fastMode: "auto" });
      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          collect: undefined,
          fastMode: "auto",
          expectsCompletionMessage: true,
        }),
        expect.anything(),
      );
    },
  );

  it("keeps its binding through hook rebuilds and metadata copies without replacing a later denial", async () => {
    const original = spawnTool();
    const wrapped = rewrapToolWithBeforeToolCallHook(wrapToolWithBeforeToolCallHook(original));
    const wait = rewrapToolWithBeforeToolCallHook(wrapToolWithBeforeToolCallHook(reader()));
    const denied = copyAgentToolMetadata(wrapped, {
      ...wrapped,
      execute: vi.fn(wrapped.execute).mockRejectedValue(new Error("later executor policy")),
    });
    const executor = denied.execute;
    finalizeAgentToolAvailability([denied, wait]);
    expect(denied.parameters).toHaveProperty("properties.collect");
    expect(denied.execute).toBe(executor);
    await expect(denied.execute("denied", { task: "inspect", collect: true })).rejects.toThrow(
      "later executor policy",
    );
    expect(spawn).not.toHaveBeenCalled();
    await wrapped.execute("allowed", { task: "inspect", collect: true });
    expect(spawn).toHaveBeenCalledOnce();
    finalizeAgentToolAvailability([denied]);
    await expect(wrapped.execute("narrowed", { task: "inspect", collect: true })).rejects.toThrow(
      "Collector results are unavailable",
    );
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("cannot reactivate a closed generation through copied definitions", async () => {
    const controller = new AbortController();
    const old = wrapToolWithAbortSignal(spawnTool(controller.signal), controller.signal);
    const retained = copyAgentToolMetadata(old, { ...old });
    finalizeAgentToolAvailability([retained, reader()]);
    controller.abort(new Error("generation closed"));
    finalizeAgentToolAvailability([retained, reader()]);
    await expect(retained.execute("stale", { task: "inspect", collect: true })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    const current = spawnTool();
    finalizeAgentToolAvailability([current, reader()]);
    await current.execute("current", { task: "inspect", collect: true });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("does not override an explicit Swarm opt-out when a native reader is supplied", async () => {
    const tool = createSessionsSpawnTool({ config: { ...config, tools: { swarm: false } } });
    finalizeAgentToolAvailability([tool, reader()]);
    expect(tool.parameters).not.toHaveProperty("properties.collect");
    expect(tool.parameters).not.toHaveProperty("properties.fastMode");
    await expect(tool.execute("disabled", { task: "inspect", collect: true })).rejects.toThrow(
      "tools.swarm.enabled=true",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
