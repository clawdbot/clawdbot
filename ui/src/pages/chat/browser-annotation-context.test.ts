// @vitest-environment node
import { describe, expect, it } from "vitest";
import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.ts";
import { composeBrowserAnnotationContext } from "./browser-annotation-context.ts";
import { createBrowserAnnotationAttachment } from "./chat-host.test-support.ts";

function expectAnnotationPrompt(message: unknown, contexts: string[], userText: string): void {
  expect(message).toContain(JSON.stringify({ annotations: contexts }));
  expect(stripInboundMetadata(String(message))).toBe(userText);
}

describe("composeBrowserAnnotationContext", () => {
  it("materializes an annotation-only message", () => {
    const attachment = createBrowserAnnotationAttachment("only", "Inspect the marked region.");

    expectAnnotationPrompt(
      composeBrowserAnnotationContext("", [attachment]),
      ["Inspect the marked region."],
      "",
    );
  });

  it("prepends annotation context to the user's draft", () => {
    const attachment = createBrowserAnnotationAttachment("mixed", "Browser context");

    expectAnnotationPrompt(
      composeBrowserAnnotationContext("Please fix this", [attachment]),
      ["Browser context"],
      "Please fix this",
    );
  });

  it("preserves attachment order across two annotations", () => {
    const first = createBrowserAnnotationAttachment("first", "First context");
    const second = createBrowserAnnotationAttachment("second", "Second context");

    expectAnnotationPrompt(
      composeBrowserAnnotationContext("Compare them", [first, second]),
      ["First context", "Second context"],
      "Compare them",
    );
  });

  it("omits context for an annotation removed before submit", () => {
    const removed = createBrowserAnnotationAttachment("removed", "Removed context");
    const remaining = createBrowserAnnotationAttachment("remaining", "Remaining context");
    const attachments = [removed, remaining];
    attachments.splice(0, 1);

    expectAnnotationPrompt(
      composeBrowserAnnotationContext("Continue", attachments),
      ["Remaining context"],
      "Continue",
    );
  });
});
