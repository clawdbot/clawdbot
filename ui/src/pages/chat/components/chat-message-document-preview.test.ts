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
    const previewObjectUrl = `blob:document-preview-${label}`;
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => previewObjectUrl);
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi.fn(
      async () => new Response(label, { status: 200, headers: { "Content-Type": mimeType } }),
    );
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
    expect(iframe?.getAttribute("src")).toBe(
      mimeType === "application/pdf"
        ? `${previewObjectUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`
        : previewObjectUrl,
    );
    expect(iframe?.getAttribute("sandbox")).toBe(sandbox);
    expect(fetchMock).toHaveBeenCalledWith(
      `/__openclaw__/media/${label}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("resets an activated frame when its resolved source changes", async () => {
    const NativeUrl = URL;
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi
          .fn()
          .mockReturnValueOnce("blob:ticket-A")
          .mockReturnValueOnce("blob:ticket-B");
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("preview", { status: 200 })) as unknown as typeof fetch,
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
    expect(activatedFrame?.getAttribute("src")).toBe("blob:ticket-A");

    source = "/__openclaw__/media/ticket-B/preview.html";
    rerender();

    const renewedFrame = container.querySelector<HTMLIFrameElement>("iframe");
    const renewedTrigger = container.querySelector<HTMLButtonElement>(
      ".chat-assistant-attachment-card__preview-load",
    );
    expect(renewedFrame).toBeNull();
    expect(renewedTrigger).not.toBeNull();
    releaseChatMediaResourceSubscriber(rerender);
    subscribers.delete(rerender);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:ticket-A");
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

  it("frames a fetched object URL instead of the protected download response", async () => {
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => "blob:sandboxed-preview");
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("<h1>Preview</h1>", {
        status: 200,
        headers: {
          "Content-Disposition": 'attachment; filename="preview.html"',
          "Content-Security-Policy": "frame-ancestors 'none'",
          "Content-Type": "text/html",
          "X-Frame-Options": "DENY",
        },
      }),
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
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("blob:sandboxed-preview");
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
