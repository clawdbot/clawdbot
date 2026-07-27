/**
 * Fast OpenClaw tool-bundle mock.
 *
 * Provides lightweight built-in tool stubs for inventory-heavy tests.
 */
import { vi } from "vitest";
import { stubTool } from "./fast-tool-stubs.js";

function stubActionTool(name: string, actions: string[]) {
  return {
    ...stubTool(name),
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: actions,
        },
      },
      required: ["action"],
    },
  };
}

const coreTools = [
  stubActionTool("canvas", ["create", "read"]),
  stubActionTool("nodes", ["list", "invoke"]),
  stubActionTool("cron", ["schedule", "cancel"]),
  stubActionTool("message", ["send", "reply"]),
  stubTool("heartbeat_respond"),
  stubActionTool("gateway", ["config.get", "config.schema.lookup"]),
  stubTool("openclaw"),
  stubActionTool("agents_list", ["list", "show"]),
  stubActionTool("sessions_list", ["list", "show"]),
  stubActionTool("sessions_history", ["read", "tail"]),
  stubActionTool("sessions_search", ["search", "find"]),
  stubTool("conversations_list"),
  stubTool("conversations_send"),
  stubTool("conversations_turn"),
  stubActionTool("sessions_send", ["send", "reply"]),
  stubActionTool("sessions_spawn", ["spawn", "handoff"]),
  stubActionTool("subagents", ["list", "show"]),
  stubActionTool("session_status", ["get", "show"]),
  stubTool("skill_workshop"),
  stubActionTool("browser", ["status", "snapshot"]),
  stubTool("tts"),
  stubTool("image_generate"),
  stubTool("video_generate"),
  stubTool("web_fetch"),
  stubTool("image"),
  stubTool("pdf"),
];

const createOpenClawToolsMock = vi.fn(
  (options?: { enableHeartbeatTool?: boolean; recordToolPrepStage?: (name: string) => void }) => {
    options?.recordToolPrepStage?.("openclaw-tools:test-helper");
    return coreTools
      .filter((tool) => tool.name !== "heartbeat_respond" || options?.enableHeartbeatTool === true)
      .map((tool) => Object.assign({}, tool));
  },
);

// Preserve action enums for tools whose tests assert schema/inventory behavior without paying the
// cost of constructing the real tool bundle. The real capability filter stays
// in place so client-caps gating behaves like production in these suites.
vi.mock("../openclaw-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openclaw-tools.js")>();
  return {
    createOpenClawTools: createOpenClawToolsMock,
    filterToolsByClientCaps: actual.filterToolsByClientCaps,
    testing: {
      setDepsForTest: () => {},
    },
  };
});
