import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import {
  parseDelimitedPreview,
  renderAttachmentDocumentPreview,
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

  it("bounds the rendered CSV grid separately from the parse budget", () => {
    const container = document.createElement("div");
    const wideCsv = Array.from({ length: 8 }, (_, row) =>
      Array.from({ length: 24 }, (_, column) => `${row}:${column}`).join(","),
    ).join("\n");

    render(
      renderAttachmentDocumentPreview(
        "table",
        documentAttachment("wide.csv", "text/csv").attachment,
        "https://example.com/wide.csv",
        wideCsv,
      ),
      container,
    );

    expect(container.querySelectorAll("thead th")).toHaveLength(8);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(
      container.querySelector(".chat-assistant-attachment-card__table-truncated"),
    ).not.toBeNull();
  });

  it.each([
    ["notes.md", "text/markdown"],
    ["notes.txt", "text/plain"],
    ["styles.css", "text/css"],
    ["settings.json", "application/json"],
    ["script.js", "text/javascript"],
    ["config.xml", "application/xml"],
    ["brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ])("keeps %s as a compact document card", (label, mimeType) => {
    expect(resolveDocumentPreviewKind({ label, mimeType })).toBeNull();
  });

  it.each([
    ["preview.html", "text/html", ""],
    ["brief.pdf", "application/pdf", "allow-scripts"],
  ])("does not load %s until the preview is requested", (label, mimeType, sandbox) => {
    const container = document.createElement("div");
    render(
      renderAssistantAttachments(
        [documentAttachment(label, mimeType, `/__fixtures/${label}`)],
        {},
        undefined,
        vi.fn(),
      ),
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

    renderSource("/__fixtures/ticket-A/preview.html");
    container
      .querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__preview-load")
      ?.click();
    const activatedFrame = container.querySelector<HTMLIFrameElement>("iframe");
    expect(activatedFrame?.getAttribute("src")).toContain("ticket-A");

    renderSource("/__fixtures/ticket-B/preview.html");

    const renewedFrame = container.querySelector<HTMLIFrameElement>("iframe");
    const renewedTrigger = container.querySelector<HTMLButtonElement>(
      ".chat-assistant-attachment-card__preview-load",
    );
    expect(renewedFrame).not.toBe(activatedFrame);
    expect(renewedFrame?.hasAttribute("src")).toBe(false);
    expect(renewedTrigger?.hidden).toBe(false);
  });

  it.each([
    ["external.html", "text/html"],
    ["external.pdf", "application/pdf"],
    ["external.csv", "text/csv"],
  ])("keeps external document %s download-only", (label, mimeType) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");

    render(
      renderAssistantAttachments(
        [documentAttachment(label, mimeType, `https://files.example/${label}`)],
        {},
        undefined,
        vi.fn(),
      ),
      container,
    );

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card__table")).toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
