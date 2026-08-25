import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import {
  parseAttachmentDelimitedPreview,
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
  document.body.replaceChildren();
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

function stubPreviewIntersection(): () => Promise<void> {
  const callbacks: IntersectionObserverCallback[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  return async () => {
    await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
    const callback = callbacks.shift();
    if (!callback) {
      throw new Error("No attachment preview is waiting for viewport intersection");
    }
    callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
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
    const preview = parseAttachmentDelimitedPreview(
      Array.from({ length: 8 }, () => wideRow).join("\n"),
      documentAttachment("wide.csv", "text/csv").attachment,
    );
    const cellCount = preview.rows.reduce((total, row) => total + row.length, 0);

    expect(Math.max(...preview.rows.map((row) => row.length))).toBeLessThanOrEqual(24);
    expect(cellCount).toBeLessThanOrEqual(128);
    expect(preview.truncated).toBe(true);
  });

  it("bounds the rendered CSV grid separately from the parse budget", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const wideCsv = Array.from({ length: 8 }, (_row, row) =>
      Array.from({ length: 24 }, (_column, column) => `${row}:${column}`).join(","),
    ).join("\n");

    render(
      renderAttachmentDocumentPreview(
        "table",
        documentAttachment("wide.csv", "text/csv").attachment,
        wideCsv,
        undefined,
      ),
      container,
    );

    expect(container.querySelectorAll("thead th")).toHaveLength(8);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    const tableWrap = container.querySelector(".chat-assistant-attachment-card__table-wrap");
    expect(tableWrap?.hasAttribute("data-right-truncated")).toBe(true);
    expect(tableWrap?.hasAttribute("data-bottom-truncated")).toBe(true);
    expect(container.textContent).not.toContain("Preview truncated");
  });

  it("refuses a partial Files table when its safe cell budget is exceeded", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const oversizedCsv = Array.from({ length: 4_097 }, (_, row) => String(row)).join("\n");

    render(
      renderAttachmentDocumentPreview(
        "table",
        documentAttachment("oversized.csv", "text/csv").attachment,
        oversizedCsv,
        undefined,
        "full",
      ),
      container,
    );

    expect(container.querySelector(".chat-assistant-attachment-card__table")).toBeNull();
    expect(container.textContent).toContain("Preview unavailable");
  });

  it("loads a CSV preview only when its card reaches the viewport", async () => {
    const intersectPreview = stubPreviewIntersection();
    const fetchMock = vi.fn(async () => new Response("name,status\nalpha,ready\n"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () =>
      render(
        renderAssistantAttachments(
          [documentAttachment("rows.csv", "text/csv", "/__openclaw__/media/rows.csv")],
          { onRequestUpdate: rerender },
          undefined,
          vi.fn(),
        ),
        container,
      );
    subscribers.add(rerender);
    rerender();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector(".chat-assistant-attachment-card__table")).toBeNull();

    await intersectPreview();

    await vi.waitFor(() =>
      expect(container.querySelector(".chat-assistant-attachment-card__table")).not.toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(container.querySelector(".chat-assistant-attachment-card__preview-load")).toBeNull();
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

  it("places the HTML preview CSP in the real head despite hostile head-like text", async () => {
    const intersectPreview = stubPreviewIntersection();
    const hostileHtml =
      '<!-- <head><img src="https://leak.example/comment.png"></head> -->' +
      '<html data-fake="<head>"><img src="https://leak.example/before-head.png">' +
      "<head><title>Hostile preview</title></head><body>safe</body></html>";
    let previewBlob: Blob | undefined;
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn((object: Blob | MediaSource) => {
          if (object instanceof Blob) {
            previewBlob = object;
          }
          return "blob:hostile-html-preview";
        });
        static override revokeObjectURL = vi.fn();
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(hostileHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      ) as unknown as typeof fetch,
    );
    const container = document.body.appendChild(document.createElement("div"));
    const attachment = documentAttachment(
      "hostile.html",
      "text/html",
      "/__openclaw__/media/hostile.html",
    );
    const rerender = () =>
      render(
        renderAssistantAttachments([attachment], { onRequestUpdate: rerender }, undefined, vi.fn()),
        container,
      );
    subscribers.add(rerender);
    rerender();

    await intersectPreview();
    await vi.waitFor(() => expect(previewBlob).toBeDefined());

    const serialized = await previewBlob!.text();
    const parsed = new DOMParser().parseFromString(serialized, "text/html");
    const policy = parsed.head.firstElementChild;
    expect(policy?.tagName).toBe("META");
    expect(policy?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(policy?.getAttribute("content")).toContain("default-src 'none'");
    expect(serialized.indexOf("Content-Security-Policy")).toBeLessThan(
      serialized.indexOf("https://leak.example/before-head.png"),
    );
  });

  it("keeps a known oversized HTML attachment compact without fetching it", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.body.appendChild(document.createElement("div"));
    const attachment = documentAttachment(
      "oversized.html",
      "text/html",
      "/__openclaw__/media/oversized.html",
    );
    attachment.attachment.sizeBytes = 256 * 1024 + 1;

    render(renderAssistantAttachments([attachment], {}, undefined, vi.fn()), container);

    expect(container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull();
    expect(container.querySelector("openclaw-chat-document-preview")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels a PDF whose Content-Length exceeds the preview budget", async () => {
    const intersectPreview = stubPreviewIntersection();
    const cancel = vi.fn();
    const createObjectURL = vi.fn();
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = vi.fn();
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: {
              "Content-Length": String(256 * 1024 + 1),
              "Content-Type": "application/pdf",
            },
          }),
      ) as unknown as typeof fetch,
    );
    const container = document.body.appendChild(document.createElement("div"));
    const attachment = documentAttachment(
      "oversized.pdf",
      "application/pdf",
      "/__openclaw__/media/oversized.pdf",
    );
    const rerender = () =>
      render(
        renderAssistantAttachments([attachment], { onRequestUpdate: rerender }, undefined, vi.fn()),
        container,
      );
    subscribers.add(rerender);
    rerender();

    await intersectPreview();
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull(),
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ["preview.html", "text/html", ""],
    ["brief.pdf", "application/pdf", "allow-scripts"],
  ])("loads %s directly when its card reaches the viewport", async (label, mimeType, sandbox) => {
    const intersectPreview = stubPreviewIntersection();
    const previewObjectUrl = `blob:document-preview-${label}`;
    let previewBlob: Blob | undefined;
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn((object: Blob | MediaSource) => {
          if (object instanceof Blob) {
            previewBlob = object;
          }
          return previewObjectUrl;
        });
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi.fn(
      async () => new Response(label, { status: 200, headers: { "Content-Type": mimeType } }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.body.appendChild(document.createElement("div"));
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

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card__preview-load")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await intersectPreview();

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
    if (mimeType === "text/html") {
      expect(await previewBlob?.text()).toContain(
        'http-equiv="Content-Security-Policy" content="default-src \'none\'',
      );
    }
  });

  it("resets an activated frame when its resolved source changes", async () => {
    const intersectPreview = stubPreviewIntersection();
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
    const container = document.body.appendChild(document.createElement("div"));
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
    await intersectPreview();
    await vi.waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const activatedFrame = container.querySelector<HTMLIFrameElement>("iframe");
    expect(activatedFrame?.getAttribute("src")).toBe("blob:ticket-A");

    source = "/__openclaw__/media/ticket-B/preview.html";
    rerender();

    const renewedFrame = container.querySelector<HTMLIFrameElement>("iframe");
    expect(renewedFrame).toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card__preview-load")).toBeNull();
    releaseChatMediaResourceSubscriber(rerender);
    subscribers.delete(rerender);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:ticket-A");
  });

  it("persists a failed preview probe as a compact card", async () => {
    const intersectPreview = stubPreviewIntersection();
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.body.appendChild(document.createElement("div"));
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

    await intersectPreview();

    await vi.waitFor(() =>
      expect(container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull(),
    );
    rerender();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card__preview-load")).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("frames a fetched object URL instead of the protected download response", async () => {
    const intersectPreview = stubPreviewIntersection();
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
    const container = document.body.appendChild(document.createElement("div"));
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

    await intersectPreview();

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
