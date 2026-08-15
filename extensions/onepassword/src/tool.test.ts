import type { PluginHookToolResultPersistEvent } from "openclaw/plugin-sdk/types";
import { describe, expect, it } from "vitest";
import { redactPersistedOnePasswordResult } from "./tool.js";

function event(
  details: Record<string, unknown>,
  contentText = JSON.stringify(details),
): PluginHookToolResultPersistEvent {
  return {
    toolName: "onepassword",
    toolCallId: "call-1",
    message: {
      role: "toolResult",
      toolName: "onepassword",
      toolCallId: "call-1",
      isError: false,
      timestamp: 1,
      content: [{ type: "text", text: contentText }],
      details,
    },
  };
}

describe("redactPersistedOnePasswordResult", () => {
  it("removes a successful get value from persisted content and details", () => {
    const fixtureValue = ["fixture", "value"].join("-");
    const result = redactPersistedOnePasswordResult(
      event({
        ok: true,
        slug: "repository-token",
        value: fixtureValue,
        itemTitle: "Repository token",
        fieldLabel: "credential",
      }),
    );
    expect(result?.message).toMatchObject({
      role: "toolResult",
      details: {
        ok: true,
        redacted: true,
        slug: "repository-token",
        itemTitle: "Repository token",
        fieldLabel: "credential",
      },
    });
    expect(JSON.stringify(result)).not.toContain(fixtureValue);
  });

  it("uses the persisted message tool name when event correlation is absent", () => {
    const fixtureValue = ["uncorrelated", "fixture"].join("-");
    const persistedEvent = event({ ok: true, value: fixtureValue });
    delete persistedEvent.toolName;
    const result = redactPersistedOnePasswordResult(persistedEvent);
    expect(result?.message).toMatchObject({ details: { ok: true, redacted: true } });
    expect(JSON.stringify(result)).not.toContain(fixtureValue);
  });

  it("leaves list and error results unchanged", () => {
    expect(redactPersistedOnePasswordResult(event({ ok: true, items: [] }))).toBeUndefined();
    expect(
      redactPersistedOnePasswordResult(event({ ok: false, error: { code: "OP_ERROR" } })),
    ).toBeUndefined();
  });

  it("redacts get content after oversized details are capped", () => {
    const fixtureValue = ["oversized", "fixture"].join("-");
    const result = redactPersistedOnePasswordResult(
      event(
        { persistedDetailsTruncated: true },
        JSON.stringify({ ok: true, slug: "repository-token", value: fixtureValue }),
      ),
    );
    expect(result?.message).toMatchObject({ details: { ok: true, redacted: true } });
    expect(JSON.stringify(result)).not.toContain(fixtureValue);
  });
});
