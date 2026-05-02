import { describe, expect, it } from "vitest";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../../auto-reply/heartbeat-tool-response.js";
import { createHeartbeatResponseTool } from "./heartbeat-response-tool.js";

function readSchemaProperty(schema: unknown, key: string): Record<string, unknown> {
  const root = schema as { properties?: Record<string, unknown> };
  const property = root.properties?.[key];
  expect(property).toBeTruthy();
  return property as Record<string, unknown>;
}

describe("createHeartbeatResponseTool", () => {
  it("uses flat enum schemas for provider portability", () => {
    const tool = createHeartbeatResponseTool();

    const outcome = readSchemaProperty(tool.parameters, "outcome");
    const priority = readSchemaProperty(tool.parameters, "priority");

    expect(outcome).toMatchObject({
      type: "string",
      enum: ["no_change", "progress", "done", "blocked", "needs_attention"],
    });
    expect(priority).toMatchObject({
      type: "string",
      enum: ["low", "normal", "high"],
    });
    expect(outcome).not.toHaveProperty("anyOf");
    expect(priority).not.toHaveProperty("anyOf");
  });

  it("records a quiet heartbeat outcome", async () => {
    const tool = createHeartbeatResponseTool();

    const result = await tool.execute("call-1", {
      outcome: "no_change",
      notify: false,
      summary: "Nothing needs attention.",
    });

    expect(tool.name).toBe(HEARTBEAT_RESPONSE_TOOL_NAME);
    expect(result.details).toMatchObject({
      status: "recorded",
      outcome: "no_change",
      notify: false,
      summary: "Nothing needs attention.",
    });
  });

  it("accepts notification text and optional scheduling metadata", async () => {
    const tool = createHeartbeatResponseTool();

    const result = await tool.execute("call-1", {
      outcome: "needs_attention",
      notify: true,
      summary: "Build is blocked.",
      notificationText: "Build is blocked on missing credentials.",
      priority: "high",
      nextCheck: "2026-05-01T17:00:00Z",
    });

    expect(result.details).toMatchObject({
      status: "recorded",
      outcome: "needs_attention",
      notify: true,
      summary: "Build is blocked.",
      notificationText: "Build is blocked on missing credentials.",
      priority: "high",
      nextCheck: "2026-05-01T17:00:00Z",
    });
  });

  it("rejects missing notify because quiet vs visible delivery must be explicit", async () => {
    const tool = createHeartbeatResponseTool();

    await expect(
      tool.execute("call-1", {
        outcome: "no_change",
        summary: "Nothing needs attention.",
      }),
    ).rejects.toThrow("notify required");
  });
});
