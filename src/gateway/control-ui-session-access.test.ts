import { describe, expect, it, vi } from "vitest";
import { resolveControlUiSessionAccess } from "./control-ui-session-access.js";

const transcript = vi.hoisted(() => ({ message: {} as Record<string, unknown> }));
vi.mock("../config/sessions/session-accessor.sqlite-active-events.js", () => ({
  visitSessionTranscriptMessageEvents: (
    _scope: unknown,
    visit: (entry: { event: { message: Record<string, unknown> } }) => void,
  ) => visit({ event: { message: transcript.message } }),
}));
vi.mock("./server-methods/sessions-shared.js", () => ({
  loadSessionEntriesForTarget: () => ({
    target: { agentId: "main", canonicalKey: "agent:main:main" },
    storePath: "fixture.sqlite",
    store: {},
    entry: { sessionId: "fixture" },
  }),
}));
vi.mock("./session-request-agent.js", () => ({
  resolveRequestedSessionAgentId: () => ({ ok: true, agentId: "main" }),
}));
vi.mock("./session-sharing.js", () => ({ createSessionListEntryFilter: () => null }));
vi.mock("./session-utils.js", () => ({
  buildGatewaySessionRow: () => ({ key: "agent:main:main", agentId: "main" }),
}));

const source = "/workspace/report.png";
describe("transcript media membership", () => {
  it.each([
    {
      name: "canonical media fact",
      content: [],
      __openclaw: { media: [{ path: source }] },
      allowed: true,
    },
    { name: "image URL", content: [{ type: "image", url: source }], allowed: true },
    {
      name: "nested image URL",
      content: [{ type: "image", source: { type: "url", url: source } }],
      allowed: true,
    },
    { name: "input image", content: [{ type: "input_image", image_url: source }], allowed: true },
    {
      name: "OpenAI image URL",
      content: [{ type: "image_url", image_url: { url: source } }],
      allowed: true,
    },
    {
      name: "audio",
      content: [{ type: "audio", source: { type: "url", url: source } }],
      allowed: true,
    },
    { name: "video", content: [{ type: "video", url: source }], allowed: true },
    {
      name: "attachment",
      content: [
        { type: "attachment", attachment: { kind: "document", label: "Report", url: source } },
      ],
      allowed: true,
    },
    {
      name: "assistant media directive",
      content: [{ type: "text", text: "MEDIA:" + source }],
      allowed: true,
    },
    ...["toolResult", "tool", "tool_result", "function"].map((role) => ({
      name: role + " image",
      role,
      content: [{ type: "image", url: source }],
      allowed: true,
    })),
    { name: "top-level assistant text", text: "MEDIA:" + source, allowed: true },
    {
      name: "content overrides top-level text",
      content: "No attachment",
      text: "MEDIA:" + source,
      allowed: false,
    },
    {
      name: "empty content array overrides text",
      content: [],
      text: "MEDIA:" + source,
      allowed: false,
    },
    {
      name: "blank image URL falls back to source",
      content: [{ type: "image", url: " ", source: { type: "url", url: source } }],
      allowed: true,
    },
    ...["toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "toolName", "tool_name"].map(
      (field) => ({
        name: field + " tool envelope does not expand media text",
        [field]: "tool-fixture",
        content: "MEDIA:" + source,
        allowed: false,
      }),
    ),
    {
      name: "tool-call argument",
      content: [{ type: "toolCall", arguments: { path: source } }],
      allowed: false,
    },
    {
      name: "nested fake media block",
      content: [{ type: "toolCall", arguments: { type: "image", url: source } }],
      allowed: false,
    },
    {
      name: "tool-result details",
      role: "toolResult",
      content: [],
      details: { path: source },
      allowed: false,
    },
    ...["toolResult", "tool", "tool_result", "function"].map((role) => ({
      name: role + " media-looking text",
      role,
      content: [{ type: "text", text: "MEDIA:" + source }],
      allowed: false,
    })),
    { name: "user media-looking text", role: "user", content: "MEDIA:" + source, allowed: false },
    {
      name: "thinking text",
      content: [{ type: "thinking", text: "MEDIA:" + source }],
      allowed: false,
    },
    {
      name: "URL hidden behind inline image data",
      content: [{ type: "image", data: "inline", url: source }],
      allowed: false,
    },
    {
      name: "attachment error",
      content: [
        {
          type: "attachment_error",
          attachment: { kind: "document", label: "Report", url: source },
        },
      ],
      allowed: false,
    },
  ])("accepts only rendered media: $name", ({ name: _name, allowed, ...message }) => {
    transcript.message = { role: "assistant", ...message };
    expect(resolveControlUiSessionAccess("agent:main:main", {}, null, source) !== null).toBe(
      allowed,
    );
  });
});
