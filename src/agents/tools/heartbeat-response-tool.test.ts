import { describe, expect, it } from "vitest";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../../auto-reply/heartbeat-tool-response.js";
import { createHeartbeatResponseTool } from "./heartbeat-response-tool.js";

function readSchemaProperty(schema: unknown, key: string): Record<string, unknown> {
  const root = schema as { properties?: Record<string, unknown> };
  const property = root.properties?.[key];
  if (property === undefined) {
    throw new Error(`expected schema property ${key}`);
  }
  return property as Record<string, unknown>;
}

type HeartbeatResponseDetails = {
  status?: string;
  outcome?: string;
  notify?: boolean;
  summary?: string;
  notificationText?: string;
  priority?: string;
  nextCheck?: string;
};

describe("createHeartbeatResponseTool", () => {
  it("uses flat enum schemas for provider portability", () => {
    const tool = createHeartbeatResponseTool();

    const outcome = readSchemaProperty(tool.parameters, "outcome");
    const priority = readSchemaProperty(tool.parameters, "priority");

    expect(outcome.type).toBe("string");
    expect(outcome.enum).toEqual(["no_change", "progress", "done", "blocked", "needs_attention"]);
    expect(priority.type).toBe("string");
    expect(priority.enum).toEqual(["low", "normal", "high"]);
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
    const details = result.details as HeartbeatResponseDetails;
    expect(details.status).toBe("recorded");
    expect(details.outcome).toBe("no_change");
    expect(details.notify).toBe(false);
    expect(details.summary).toBe("Nothing needs attention.");
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

    const details = result.details as HeartbeatResponseDetails;
    expect(details.status).toBe("recorded");
    expect(details.outcome).toBe("needs_attention");
    expect(details.notify).toBe(true);
    expect(details.summary).toBe("Build is blocked.");
    expect(details.notificationText).toBe("Build is blocked on missing credentials.");
    expect(details.priority).toBe("high");
    expect(details.nextCheck).toBe("2026-05-01T17:00:00Z");
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
