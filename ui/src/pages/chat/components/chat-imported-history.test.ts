import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapExternalContent } from "../../../../../src/security/external-content.js";
import { projectImportedMessageForDisplay } from "../../../lib/chat/imported-message-display.ts";
import { extractText, extractTextCached } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import {
  renderMessageActionButtons,
  resolveMessageActionDetails,
} from "./chat-message-markdown.ts";
import { resolveMessageDisplayMarkdown } from "./chat-message-text.ts";

const importKey = "example-catalog:thread:item";
const wrap = (text: string) =>
  wrapExternalContent(text, { source: "unknown", includeWarning: false }).trim();
const container = document.createElement("div");

afterEach(() => {
  render(nothing, container);
  vi.unstubAllGlobals();
});

function displayed(message: unknown) {
  return resolveMessageDisplayMarkdown(message, normalizeMessage(message));
}

describe.each(["user", "assistant"])("imported %s history presentation", (role) => {
  it.each(["string", "blocks", "text"])(
    "hides import framing in %s content without mutating history",
    (shape) => {
      const body = "A **message**\n\n---\n\nSource: External\n\n~~~ts\nconst answer = 42;\n~~~";
      const wrapped = wrap(body);
      const message = {
        role,
        ...(shape === "text"
          ? { text: wrapped }
          : { content: shape === "blocks" ? [{ type: "text", text: wrapped }] : wrapped }),
        __openclaw: { idempotencyKey: importKey },
      };
      const original = structuredClone(message);
      expect(extractText(message)).toBe(body);
      expect(extractTextCached(message)).toBe(body);
      expect(displayed(message)).toBe(body);
      expect(message).toEqual(original);
    },
  );

  it("unwraps text blocks independently and preserves other content", () => {
    const message = {
      role,
      idempotencyKey: importKey,
      content: [
        { type: "text", text: wrap("First") },
        null,
        { type: role === "user" ? "input_text" : "output_text", text: wrap("Second") },
      ],
    };
    expect(extractText(message)).toBe("First\nSecond");
    expect(displayed(message)).toBe("First\nSecond");
  });

  it("renders the body as Markdown and uses it for reply and copy actions", async () => {
    const body = "Imported **answer**\n\n~~~ts\nconst answer = 42;\n~~~";
    const message = { role, content: wrap(body), __openclaw: { idempotencyKey: importKey } };
    render(
      renderGroupedMessage(message, "imported", { isStreaming: false, showReasoning: false }),
      container,
    );
    expect(container.querySelector(".chat-text strong")?.textContent).toBe("answer");
    expect(container.querySelector("pre code")?.textContent?.trimEnd()).toBe("const answer = 42;");
    expect(container.textContent).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(container.textContent).not.toContain("Source: External");
    expect(container.querySelector("h2")).toBeNull();
    const onReply = vi.fn();
    const details = resolveMessageActionDetails({
      message,
      messageId: "imported",
      senderLabel: role,
      onReply,
    });
    expect(details?.replyTarget?.text).toBe(body);
    if (role === "assistant") {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      expect(details?.markdown).toBe(body);
      render(renderMessageActionButtons(details!, { onReply }), container);
      container.querySelector<HTMLButtonElement>(".chat-copy-btn")!.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
    }
  });

  it.each([
    ["fenced example", (text: string) => "~~~text\n" + text + "\n~~~"],
    ["inline example", (text: string) => "Example: " + text],
    ["truncated wrapper", (text: string) => text.slice(0, -10)],
    [
      "mismatched id",
      (text: string) =>
        text.replace(
          /END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]+"/,
          'END_EXTERNAL_UNTRUSTED_CONTENT id="ffffffffffffffff"',
        ),
    ],
    ["missing separator", (text: string) => text.replace("\n---\n", "\n")],
    ["extra suffix", (text: string) => text + "\nKeep this suffix"],
    ["different source", (text: string) => text.replace("Source: External", "Source: Web Fetch")],
  ] as const)("preserves %s literally", (_name, transform) => {
    const content = transform(wrap("Keep this body"));
    const message = { role, content, __openclaw: { idempotencyKey: importKey } };
    expect(extractText(message)).toBe(content);
    expect(displayed(message)).toBe(content);
  });

  it("preserves CRLF body whitespace while removing only framing", () => {
    const body = "  First\r\n\r\nSecond  ";
    const content = wrap(body).replaceAll("\n", "\r\n").replaceAll("\r\r\n", "\r\n");
    const message = { role, content, __openclaw: { idempotencyKey: importKey } };
    expect(projectImportedMessageForDisplay(message)).toEqual({ ...message, content: body });
    // Assistant media parsing already trims trailing whitespace; retain that display contract.
    expect(normalizeMessage(message).content).toEqual(
      normalizeMessage({ role, content: body }).content,
    );
    expect(displayed(message)).toBe(body.trim());
  });

  it.each(["\n", "\r\n", "Thinking\n\n\n"])(
    "preserves extra leading separators %j instead of treating them as import framing",
    (prefix) => {
      const content = prefix + wrap("Keep this body");
      const message = { role, content, __openclaw: { idempotencyKey: importKey } };
      expect(projectImportedMessageForDisplay(message)).toEqual(message);
      expect(displayed(message)).toBe(content.trim());
      expect(extractText(message)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    },
  );

  it.each(["\n", "\r\n"])("preserves extra trailing separators %j", (suffix) => {
    const content = wrap("Keep this body") + suffix;
    const message = { role, content, __openclaw: { idempotencyKey: importKey } };
    expect(projectImportedMessageForDisplay(message)).toEqual(message);
    expect(displayed(message)).toBe(content.trim());
    expect(extractText(message)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  });

  it("retains warning-bearing external content", () => {
    const content = wrapExternalContent("Evidence", { source: "unknown" }).trim();
    const message = { role, content, __openclaw: { idempotencyKey: importKey } };
    expect(extractText(message)).toBe(content);
    expect(displayed(message)).toBe(content);
  });

  it("does not reinterpret an ordinary message that quotes a complete wrapper", () => {
    const content = wrap("A literal wrapper example");
    for (const metadata of [{}, { idempotencyKey: "ordinary:user" }]) {
      const message = { role, content, __openclaw: metadata };
      expect(extractText(message)).toBe(content);
      expect(displayed(message)).toBe(content);
    }
  });

  it("preserves marker examples inside the imported body without recursively stripping", () => {
    const inner = wrap("Literal nested example");
    const content = wrap("BODY").replace("BODY", "~~~text\n" + inner + "\n~~~");
    const body = "~~~text\n" + inner + "\n~~~";
    const message = { role, content, __openclaw: { idempotencyKey: importKey } };
    expect(extractText(message)).toBe(body);
    expect(displayed(message)).toBe(body);
  });
});

it.each(["Thinking", "Tool call", "Tool result", "Other"])("keeps imported %s labels", (prefix) => {
  const message = {
    role: "assistant",
    content: prefix + "\n\n" + wrap("Original text"),
    __openclaw: { idempotencyKey: importKey },
  };
  expect(extractText(message)).toBe(prefix + "\n\nOriginal text");
  expect(displayed(message)).toBe(prefix + "\n\nOriginal text");
});

it("does not hide security framing in tool output", () => {
  const content = wrap("Tool evidence");
  expect(
    extractText({ role: "toolResult", content, __openclaw: { idempotencyKey: importKey } }),
  ).toBe(content);
});
