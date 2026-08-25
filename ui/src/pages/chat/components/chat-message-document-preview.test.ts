import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import {
  parseDelimitedPreview,
  resolveDocumentPreviewKind,
} from "./chat-message-document-preview.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

function documentAttachment(label: string, mimeType: string, url?: string): AttachmentItem {
  return {
    type: "attachment",
    attachment: {
      kind: "document",
      label,
      mimeType,
      url: url ?? `https://example.com/${label}`,
    },
  };
}

describe("parseDelimitedPreview", () => {
  it("bounds columns and total cells for a wide CSV row", () => {
    const wideRow = Array.from({ length: 8_192 }, () => "x").join(",");
    const preview = parseDelimitedPreview(Array.from({ length: 8 }, () => wideRow).join("\n"));
    const cellCount = preview.rows.reduce((total, row) => total + row.length, 0);

    expect(Math.max(...preview.rows.map((row) => row.length))).toBeLessThanOrEqual(24);
    expect(cellCount).toBeLessThanOrEqual(128);
    expect(preview.truncated).toBe(true);
  });

  it("retains the bounded inline preview for text documents", () => {
    expect(resolveDocumentPreviewKind({ label: "notes.txt", mimeType: "text/plain" })).toBe(
      "text",
    );
  });

  it.each([
    ["preview.html", "text/html", ""],
    ["brief.pdf", "application/pdf", "allow-scripts"],
  ])("does not load %s until the preview is requested", (label, mimeType, sandbox) => {
    const container = document.createElement("div");
    render(
      renderAssistantAttachments([documentAttachment(label, mimeType)], {}, undefined, vi.fn()),
      container,
    );

    const iframe = container.querySelector<HTMLIFrameElement>("iframe");
    const trigger = container.querySelector<HTMLButtonElement>(
      ".chat-assistant-attachment-card__preview-load",
    );
    expect(iframe?.hasAttribute("src")).toBe(false);
    expect(iframe?.getAttribute("sandbox")).toBe(sandbox);
    expect(trigger).not.toBeNull();

    trigger?.click();

    expect(iframe?.getAttribute("src")).toContain(label);
    expect(trigger?.hidden).toBe(true);
  });

  it("resets an activated frame when its resolved source changes", () => {
    const container = document.createElement("div");
    const renderSource = (source: string) =>
      render(
        renderAssistantAttachments(
          [documentAttachment("preview.html", "text/html", source)],
          {},
          undefined,
          vi.fn(),
        ),
        container,
      );

    renderSource("https://example.com/ticket-A/preview.html");
    container
      .querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__preview-load")
      ?.click();
    const activatedFrame = container.querySelector<HTMLIFrameElement>("iframe");
    expect(activatedFrame?.getAttribute("src")).toContain("ticket-A");

    renderSource("https://example.com/ticket-B/preview.html");

    const renewedFrame = container.querySelector<HTMLIFrameElement>("iframe");
    const renewedTrigger = container.querySelector<HTMLButtonElement>(
      ".chat-assistant-attachment-card__preview-load",
    );
    expect(renewedFrame).not.toBe(activatedFrame);
    expect(renewedFrame?.hasAttribute("src")).toBe(false);
    expect(renewedTrigger?.hidden).toBe(false);
  });
});
