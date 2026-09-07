import { describe, expect, it } from "vitest";
import { applyLoggingConfig, resetLogger } from "../logging/logger.js";
import { renderPublicSessionDocument } from "./control-ui-public-session-render.js";

function render(
  messages: unknown[],
  overrides: Partial<Parameters<typeof renderPublicSessionDocument>[0]> = {},
) {
  return renderPublicSessionDocument({
    messages,
    title: "A shared conversation",
    truncated: false,
    latestUrl: "/share/session?token=v1.opaque",
    canonicalUrl: "https://example.test/share/session/demo",
    cardUrl: "https://example.test/share/card.png",
    ...overrides,
  });
}

describe("public session document", () => {
  it("publishes only user and assistant conversation text without internal input or metadata", () => {
    const html = render([
      { role: "system", content: "private system instructions" },
      { role: "developer", content: "private developer instructions" },
      { role: "user", display: false, content: "hidden user input" },
      { role: "user", provenance: { kind: "internal_system" }, content: "internal handoff" },
      { role: "user", provenance: { kind: "inter_session" }, content: "private other session" },
      { role: "user", provenance: { kind: "unknown" }, content: "unknown source" },
      {
        role: "user",
        content: "[Inter-session message] sourceSession=private\nprivate legacy handoff",
      },
      { role: "toolResult", content: "private tool output" },
      { role: "assistant", phase: "commentary", content: "private commentary" },
      {
        role: "assistant",
        content: "<think>private tagged reasoning</think>Public visible answer",
      },
      { role: "assistant", content: "<think>private unfinished reasoning" },
      {
        role: "assistant",
        content:
          '<tool_call>{"name":"read","arguments":{"text":"private inline tool payload"}}</tool_call>',
      },
      { role: "assistant", content: "NO_REPLY" },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "[OpenClaw heartbeat poll]" },
      {
        role: "user",
        provenance: { kind: "external_user" },
        content: [
          { type: "input_text", text: "First public question" },
          { type: "image", data: "private image bytes" },
          { type: "text", text: "Second public question" },
        ],
        __openclaw: { senderIdentity: "private sender identity" },
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private reasoning" },
          {
            type: "toolCall",
            text: "private tool call",
            arguments: { secret: "private tool arguments" },
          },
          {
            type: "text",
            text: "Private phased commentary",
            textSignature: '{"v":1,"phase":"commentary"}',
          },
          {
            type: "text",
            text: "**Public final answer**",
            textSignature: '{"v":1,"phase":"final_answer"}',
          },
          { type: "canvas", text: "private widget" },
        ],
      },
    ]);
    expect(html).toContain("First public question");
    expect(html).toContain("Public visible answer");
    expect(html).toContain("Second public question");
    expect(html).toContain("<strong>Public final answer</strong>");
    expect(html).not.toMatch(
      /private|Private|hidden user input|internal handoff|unknown source|NO_REPLY|HEARTBEAT_OK|heartbeat poll/,
    );
  });

  it("strips generated envelopes and applies built-in and operator redaction", () => {
    const token = `sk-${"a".repeat(48)}`;
    const operatorSecret = "internal-ticket-8315";
    applyLoggingConfig({ redactPatterns: [String.raw`/internal-ticket-\d+/g`] });
    try {
      const html = render(
        [
          {
            role: "user",
            content: `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nprivate runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nVisible user request ${token}`,
          },
          { role: "assistant", content: `Visible response ${token} ${operatorSecret}` },
        ],
        { title: `Shared ${token} ${operatorSecret}` },
      );
      expect(html).toContain("Visible user request");
      expect(html).toContain("Visible response");
      expect(html).not.toContain("private runtime context");
      expect(html).not.toContain("OPENCLAW_INTERNAL_CONTEXT");
      expect(html).not.toContain(token);
      expect(html).not.toContain(operatorSecret);
    } finally {
      resetLogger();
    }
  });

  it("omits local and remote media directives while preserving fenced examples", () => {
    const relativePath = "./Private/customer-board.pdf";
    const signedUrl = "https://media.example.test/private.png?sig=private-signed-value";
    const html = render([
      {
        role: "assistant",
        content: [
          "Visible response",
          `MEDIA:${relativePath}`,
          `MEDIA:${signedUrl}`,
          "```text",
          "MEDIA:./example.png",
          "```",
        ].join("\n"),
      },
    ]);
    expect(html).toContain("Visible response");
    expect(html).toContain("MEDIA:./example.png");
    expect(html).not.toContain(relativePath);
    expect(html).not.toContain(signedUrl);
  });

  it("renders inert Markdown without executable markup, automatic image loads, or unsafe links", () => {
    const html = render(
      [
        {
          role: "assistant",
          content: [
            "<script>alert('unsafe')</script>",
            "![remote image](https://remote.test/tracker.png)",
            "[Safe link](https://example.test/docs)",
            "[Unsafe link](javascript:alert%281%29)",
            "[Local link](/api/private)",
            "```html\n<iframe src='https://remote.test/embed'></iframe>\n```",
          ].join("\n\n"),
        },
      ],
      { title: '<img src=x onerror="unsafe">' },
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;iframe");
    expect(html).toContain("[Image omitted]");
    expect(html).toContain('href="https://example.test/docs" rel="noreferrer noopener nofollow"');
    expect(html).not.toContain("tracker.png");
    expect(html).not.toMatch(/<(script|iframe|img)\b/);
    expect(html).not.toMatch(/href="(?:javascript:|\/api\/private)/);
  });

  it("bounds the newest public messages and visibly marks omitted history or text", () => {
    const messages = Array.from({ length: 105 }, (_, index) => ({
      role: "user",
      content: `Message number ${index}.`,
    }));
    messages.push({
      role: "assistant",
      content: `Long message ${"x".repeat(40_000)} private-overflow-marker`,
    });
    const html = render(messages);
    expect(html).not.toContain("Message number 0.");
    expect(html).toContain("Message number 104.");
    expect(html).toContain("Long message");
    expect(html).not.toContain("private-overflow-marker");
    expect(html).toContain("Some messages or long text are omitted");
    expect(html).toContain("Message shortened for this public view");
    expect(html.indexOf("Message number 104.")).toBeLessThan(html.indexOf("Long message"));
  });

  it("keeps older pages still and offers chronological navigation back to the live view", () => {
    const html = render([{ role: "user", content: "An earlier question" }], {
      isLatest: false,
      olderUrl: "/share/session?token=v1.opaque&offset=100",
    });
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain("Earlier conversation");
    expect(html).toContain("Back to latest");
    expect(html).toContain('href="/share/session?token=v1.opaque&amp;offset=100" rel="prev"');
    expect(html).toContain('href="/share/session?token=v1.opaque">Back to latest</a>');
    expect(html).not.toContain("within its size limit");
  });

  it("keeps bearer navigation relative when no trusted absolute origin is available", () => {
    const html = render([{ role: "user", content: "Public question" }], {
      canonicalUrl: undefined,
    });
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('property="og:url"');
    expect(html).toContain('href="/share/session?token=v1.opaque">Refresh now</a>');
  });

  it("renders an accessible empty live view with disclosure and crawler metadata", () => {
    const html = render([], { truncated: true });
    expect(html).toContain("No public conversation text yet");
    expect(html).toContain("Public · Read-only");
    expect(html).toContain(
      "Tool output, files, images, reasoning, and interactive content are omitted",
    );
    expect(html).toContain('http-equiv="refresh" content="15"');
    expect(html).toContain('property="og:title" content="A shared conversation"');
    expect(html).toContain('aria-label="Conversation"');
    expect(html).toContain('name="referrer" content="no-referrer"');
  });
});
