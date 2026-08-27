// Heartbeat response tool tests cover the one-shot heartbeat contract and
// provider-portable schema shape.
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
  scratch?: string;
};

describe("createHeartbeatResponseTool", () => {
  it("uses flat enum schemas for provider portability", () => {
    // Some providers reject anyOf literal unions in tool schemas; flat enums are
    // the portable contract for heartbeat status fields.
    const tool = createHeartbeatResponseTool();

    const outcome = readSchemaProperty(tool.parameters, "outcome");
    const priority = readSchemaProperty(tool.parameters, "priority");
    const scratch = readSchemaProperty(tool.parameters, "scratch");

    expect(tool.catalogMode).toBe("direct-only");
    expect(tool.description).toContain("Scratch is monitor prose only.");
    expect(tool.description).not.toMatch(/\b(?:cron|automations)\b/);
    expect(JSON.stringify(tool.parameters)).not.toMatch(/\b(?:cron|automations)\b/);
    expect(scratch.description).toContain("not a recurring schedule");
    expect(outcome.type).toBe("string");
    expect(outcome.enum).toEqual(["no_change", "progress", "done", "blocked", "needs_attention"]);
    expect(priority.type).toBe("string");
    expect(priority.enum).toEqual(["low", "normal", "high"]);
    expect(outcome).not.toHaveProperty("anyOf");
    expect(priority).not.toHaveProperty("anyOf");
  });

  it("accepts a quiet no-change outcome without claiming persistence", async () => {
    const tool = createHeartbeatResponseTool();

    const result = await tool.execute("call-1", {
      outcome: "no_change",
      notify: false,
      summary: "Nothing needs attention.",
    });

    expect(tool.name).toBe(HEARTBEAT_RESPONSE_TOOL_NAME);
    const details = result.details as HeartbeatResponseDetails;
    expect(details.status).toBe("accepted");
    expect(details.outcome).toBe("no_change");
    expect(details.notify).toBe(false);
    expect(details.summary).toBe("Nothing needs attention.");
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"status": "accepted"') }),
    ]);
  });

  it("rejects repeated heartbeat responses from the same tool instance", async () => {
    // A heartbeat turn has one final outcome; accepting multiple writes would
    // make notification delivery ambiguous.
    const tool = createHeartbeatResponseTool();

    await tool.execute("call-1", {
      outcome: "no_change",
      notify: false,
      summary: "Nothing needs attention.",
    });

    await expect(
      tool.execute("call-2", {
        outcome: "no_change",
        notify: false,
        summary: "Nothing needs attention.",
      }),
    ).rejects.toThrow("heartbeat_respond already accepted");
  });

  it("captures scratch without echoing future prompt content to the model", async () => {
    const tool = createHeartbeatResponseTool();
    const scratch = "Private monitor context that must not enter tool output.";

    const result = await tool.execute("call-1", {
      outcome: "progress",
      notify: false,
      summary: "Updated monitor context.",
      scratch,
    });

    const details = result.details as HeartbeatResponseDetails;
    expect(details.scratch).toBe(scratch);
    expect(JSON.stringify(result.content)).not.toContain(scratch);
    expect(JSON.stringify(details)).not.toContain(scratch);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"scratchPending": true') }),
    ]);
  });

  it("accepts an urgent notification without claiming persistence", async () => {
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
    expect(details.status).toBe("accepted");
    expect(details.outcome).toBe("needs_attention");
    expect(details.notify).toBe(true);
    expect(details.summary).toBe("Build is blocked.");
    expect(details.notificationText).toBe("Build is blocked on missing credentials.");
    expect(details.priority).toBe("high");
    expect(details.nextCheck).toBe("2026-05-01T17:00:00Z");
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"status": "accepted"') }),
    ]);
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
