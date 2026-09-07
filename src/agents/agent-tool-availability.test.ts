import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindAgentToolAvailability,
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
import {
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  restrictToolSearchCatalog,
} from "./tool-search.js";
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

describe("execution allowlist availability", () => {
  const sparseAllow: string[] = [];
  sparseAllow.length = 1;
  it.each([
    {
      label: "aliases",
      allow: [" BASH ", "apply-PATCH", " CRON "],
      expected: ["exec", "apply_patch", "automations"],
    },
    { label: "blank names", allow: [" \t "], expected: ["", "   "] },
    {
      label: "literal names",
      allow: ["write", "web_*", "*", "group:fs"],
      expected: ["WRITE", "web_*", "*", "group:fs"],
    },
    { label: "empty list", allow: [], expected: [] },
    { label: "sparse list", allow: sparseAllow, expected: [] },
  ])("prepares callable tools from frozen $label", ({ allow, expected }) => {
    const tools = [
      "exec",
      "apply_patch",
      "automations",
      "WRITE",
      "read",
      "web_fetch",
      "web_*",
      "*",
      "group:fs",
      "",
      "   ",
    ].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } }));
    let callableNames: string[] = [];
    bindAgentToolAvailability(tools[0]!, {
      prepare: (_tool, callableTools) => {
        callableNames = [...callableTools.keys()];
      },
    });

    finalizeAgentToolAvailability(tools, { toolExecutionAllow: Object.freeze(allow) });

    expect(callableNames).toEqual(expected);
  });

  it("reads current execution caps when restricting and rebuilding a catalog", async () => {
    const catalogConfig = {
      ...config,
      tools: { toolSearch: { enabled: true, mode: "tools" as const } },
    };
    const catalogRef = createToolSearchCatalogRef();
    const controls = createToolSearchTools({ config: catalogConfig, catalogRef });
    const tool = spawnTool();
    const params = {
      tools: [...controls, tool, reader()],
      config: catalogConfig,
      catalogRef,
      toolExecutionAllow: ["sessions_spawn", "agents_wait"],
    };
    const expectUnavailable = async () => {
      await expect(tool.execute("denied", { task: "inspect", collect: true })).rejects.toThrow(
        "Collector results are unavailable",
      );
      expect(tool.parameters).not.toHaveProperty("properties.collect");
      expect(spawn).not.toHaveBeenCalled();
    };
    try {
      applyToolSearchCatalog(params);
      expect(tool.parameters).toHaveProperty("properties.collect");

      params.toolExecutionAllow[1] = "read";
      restrictToolSearchCatalog({
        catalogRef,
        allowedToolNames: new Set(["sessions_spawn", "agents_wait"]),
      });
      await expectUnavailable();

      params.toolExecutionAllow[1] = "agents_wait";
      applyToolSearchCatalog(params);
      expect(tool.parameters).toHaveProperty("properties.collect");

      params.toolExecutionAllow = ["sessions_spawn", "read"];
      applyToolSearchCatalog(params);
      await expectUnavailable();
    } finally {
      clearToolSearchCatalog({ catalogRef });
    }
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

  it.each([
    { boundary: "reuse", readerState: "same-object-denied" },
    { boundary: "reuse", readerState: "denied-wrapper" },
    { boundary: "reuse", readerState: "lookalike" },
    { boundary: "restriction", readerState: "same-object-denied" },
  ] as const)(
    "revokes collection after $boundary with a $readerState reader and unchanged descriptors",
    async ({ boundary, readerState }) => {
      const catalogConfig = {
        ...config,
        tools: { toolSearch: { enabled: true, mode: "tools" as const } },
      };
      const catalogRef = createToolSearchCatalogRef();
      const controls = createToolSearchTools({ config: catalogConfig, catalogRef });
      const tool = spawnTool();
      const wait = wrapToolWithBeforeToolCallHook(reader());
      const compact = (currentReader: typeof wait) =>
        applyToolSearchCatalog({
          tools: [...controls, tool, currentReader],
          config: catalogConfig,
          catalogRef,
        });
      try {
        compact(wait);
        const firstCatalog = catalogRef.current!;
        const firstEntries = firstCatalog.entries;
        const allowedToolNames = new Set(firstEntries.map((entry) => entry.name));
        expect(tool.parameters).toHaveProperty("properties.collect");
        if (boundary === "reuse") {
          expect(compact(wait).catalogReused).toBe(true);
        } else {
          expect(restrictToolSearchCatalog({ catalogRef, allowedToolNames })).toBe(2);
        }
        expect(catalogRef.current).toBe(firstCatalog);
        expect(catalogRef.current?.entries).toBe(firstEntries);
        expect(tool.parameters).toHaveProperty("properties.collect");

        const currentReader =
          readerState === "lookalike"
            ? { ...wait }
            : readerState === "denied-wrapper"
              ? markAgentToolExecutionUnavailable(
                  copyAgentToolMetadata(wait, {
                    ...wait,
                    execute: vi.fn(wait.execute).mockRejectedValue(new Error("executor denied")),
                  }),
                )
              : markAgentToolExecutionUnavailable(wait);
        if (boundary === "reuse") {
          compact(currentReader);
        } else {
          restrictToolSearchCatalog({ catalogRef, allowedToolNames });
        }

        // Exercise the real spawn guard before schema assertions can hide an admitted child.
        await expect(
          tool.execute("collect-after-revocation", { task: "inspect", collect: true }),
        ).rejects.toThrow("Collector results are unavailable");
        expect(spawn).not.toHaveBeenCalled();
        expect(
          firstEntries.find((item) => item.name === "sessions_spawn")?.parameters,
        ).toHaveProperty("properties.collect");
        const entry = catalogRef.current?.entries.find((item) => item.name === "sessions_spawn");
        for (const schema of [tool.parameters, entry?.parameters]) {
          expect(schema).toHaveProperty("properties.fastMode");
          for (const field of ["collect", "outputSchema", "groupId"]) {
            expect(schema).not.toHaveProperty(`properties.${field}`);
          }
        }
        expect(tool.description).not.toContain("collect=true");
        expect(entry?.description).not.toContain("collect=true");
      } finally {
        clearToolSearchCatalog({ catalogRef });
      }
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
