import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import {
  parseAttachmentDelimitedPreview,
  parseDelimitedPreview,
  renderAttachmentDocumentPreview,
  resolveDocumentPreviewKind,
} from "./chat-message-document-preview.ts";
import { releaseChatMediaResourceSubscriber, type AttachmentItem } from "./chat-message-media.ts";

const subscribers = new Set<() => void>();

afterEach(() => {
  for (const subscriber of subscribers) {
    releaseChatMediaResourceSubscriber(subscriber);
  }
  subscribers.clear();
  vi.unstubAllGlobals();
});

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
  it("keeps commas inside tab-separated cells", () => {
    const preview = parseAttachmentDelimitedPreview(
      "name\tdescription\nreport\talpha,beta",
      documentAttachment("report.tsv", "text/tab-separated-values").attachment,
    );

    expect(preview.rows).toEqual([
      ["name", "description"],
      ["report", "alpha,beta"],
    ]);
  });

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
    const wideCsv = Array.from({ length: 8 }, (_row, row) =>
      Array.from({ length: 24 }, (_column, column) => `${row}:${column}`).join(","),
    ).join("\n");

    render(
      renderAttachmentDocumentPreview(
        "table",
        documentAttachment("wide.csv", "text/csv").attachment,
        "https://example.com/wide.csv",
        wideCsv,
        undefined,
        undefined,
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
  ])("does not load %s until the preview is requested", async (label, mimeType, sandbox) => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    const rerender = () =>
      render(
        renderAssistantAttachments(
          [documentAttachment(label, mimeType, `/__openclaw__/media/${label}`)],
          { onRequestUpdate: rerender },
          undefined,
          vi.fn(),
        ),
        container,
      );
    subscribers.add(rerender);
    rerender();

    const trigger = container.querySelector<HTMLButtonElement>(
      ".chat-assistant-attachment-card__preview-load",
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(trigger).not.toBeNull();

    trigger?.click();

    await vi.waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const iframe = container.querySelector<HTMLIFrameElement>("iframe");
    expect(iframe?.getAttribute("src")).toContain(label);
    expect(iframe?.getAttribute("sandbox")).toBe(sandbox);
    expect(fetchMock).toHaveBeenCalledWith(
      `/__openclaw__/media/${label}`,
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("resets an activated frame when its resolved source changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    );
    const container = document.createElement("div");
    let source = "/__openclaw__/media/ticket-A/preview.html";
    const rerender = () =>
      render(
        renderAssistantAttachments(
          [documentAttachment("preview.html", "text/html", source)],
          { onRequestUpdate: rerender },
          undefined,
          vi.fn(),
        ),
        container,
      );

    subscribers.add(rerender);
    rerender();
    container
      .querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__preview-load")
      ?.click();
    await vi.waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const activatedFrame = container.querySelector<HTMLIFrameElement>("iframe");
    expect(activatedFrame?.getAttribute("src")).toContain("ticket-A");

    source = "/__openclaw__/media/ticket-B/preview.html";
    rerender();

    const renewedFrame = container.querySelector<HTMLIFrameElement>("iframe");
    const renewedTrigger = container.querySelector<HTMLButtonElement>(
      ".chat-assistant-attachment-card__preview-load",
    );
    expect(renewedFrame).toBeNull();
    expect(renewedTrigger).not.toBeNull();
  });

  it("persists a failed preview probe as a compact card", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.createElement("div");
    const attachment = documentAttachment(
      "missing.pdf",
      "application/pdf",
      "/__openclaw__/media/missing.pdf",
    );
    const rerender = () =>
      render(
        renderAssistantAttachments([attachment], { onRequestUpdate: rerender }, undefined, vi.fn()),
        container,
      );
    subscribers.add(rerender);
    rerender();

    container
      .querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__preview-load")
      ?.click();

    await vi.waitFor(() =>
      expect(container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull(),
    );
    rerender();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card__preview-load")).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to a bounded GET probe when HEAD is unsupported", async () => {
    let cancelled = false;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const attachment = documentAttachment(
      "preview.html",
      "text/html",
      "/__openclaw__/media/preview.html",
    );
    const rerender = () =>
      render(
        renderAssistantAttachments([attachment], { onRequestUpdate: rerender }, undefined, vi.fn()),
        container,
      );
    subscribers.add(rerender);
    rerender();

    container
      .querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__preview-load")
      ?.click();

    await vi.waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD", "GET"]);
    expect(cancelled).toBe(true);
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
    const download = container.querySelector<HTMLAnchorElement>(
      ".chat-assistant-attachment-card__download",
    );
    expect(download?.target).toBe("_blank");
    expect(download?.rel).toBe("noreferrer");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
