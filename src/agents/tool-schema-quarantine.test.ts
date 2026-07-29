// Tool schema quarantine tests cover diagnostic logging for unreadable runtime
// tool entries without touching the broken tool object again.
import { afterEach, describe, expect, it } from "vitest";
import {
  onTrustedToolExecutionEvent,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  listPersistedRuntimeToolSchemaQuarantines,
  recordPersistedRuntimeToolSchemaQuarantine,
} from "./tool-schema-quarantine-health.js";
import { logRuntimeToolSchemaQuarantine } from "./tool-schema-quarantine.js";
import type { AnyAgentTool } from "./tools/common.js";

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("runtime tool schema quarantine logging", () => {
  it("does not re-read unreadable tool entries while logging diagnostics", () => {
    const events: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => events.push(event));
    const tools = new Proxy([] as AnyAgentTool[], {
      get(target, property, receiver) {
        if (property === "0") {
          throw new Error("fuzzplugin tool entry getter exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    try {
      expect(() =>
        logRuntimeToolSchemaQuarantine({
          diagnostics: [
            {
              toolName: "tool[0]",
              toolIndex: 0,
              violations: ["tool[0] is unreadable"],
            },
          ],
          tools,
          runId: "run-fuzzplugin-unreadable-tool",
          agentId: "main",
        }),
      ).not.toThrow();
    } finally {
      stop();
    }
    expect(events).toMatchObject([
      {
        type: "tool.execution.blocked",
        runId: "run-fuzzplugin-unreadable-tool",
        agentId: "main",
        toolName: "tool[0]",
      },
    ]);
  });

  it("clears this process's persisted quarantine after the tool schema recovers", async () => {
    await withStateDirEnv("openclaw-tool-schema-quarantine-recovery-", async () => {
      recordPersistedRuntimeToolSchemaQuarantine({
        toolName: "recovered_tool",
        reason: 'recovered_tool.parameters.type must be "object"',
        failedAt: new Date(123),
      });

      logRuntimeToolSchemaQuarantine({
        diagnostics: [],
        tools: [
          {
            name: "recovered_tool",
            label: "Recovered tool",
            description: "Recovered tool",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
          },
        ],
        runId: "run-recovered-tool",
        agentId: "main",
      });

      expect(listPersistedRuntimeToolSchemaQuarantines()).toEqual([]);
    });
  });
});
