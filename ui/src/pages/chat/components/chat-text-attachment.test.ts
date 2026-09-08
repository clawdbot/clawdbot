/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-sidebar.ts";

async function mountAttachment(
  overrides: Partial<Extract<SidebarContent, { kind: "attachment" }>> = {},
) {
  const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
    content: SidebarContent;
    updateComplete: Promise<unknown>;
  };
  panel.content = {
    kind: "attachment",
    attachmentKind: "document",
    title: "notes.txt",
    src: "/__openclaw__/assistant-media?mediaTicket=text-preview",
    mimeType: "text/plain",
    ...overrides,
  };
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reads a text attachment in Files without downloading or interpreting its contents", async () => {
  const text = "Pasted notes 🦞\n  preserve indentation\n<script>not executable</script>\n";
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(text));
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment();

  await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe(text));
  expect(panel.querySelector("script, iframe, textarea")).toBeNull();
  expect(panel.querySelector<HTMLAnchorElement>("a[download]")?.getAttribute("href")).toBe(
    "/__openclaw__/assistant-media?mediaTicket=text-preview",
  );
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
});

it.each([
  ["notes.md", "text/markdown; charset=utf-8", "# literal Markdown\n"],
  ["preview.html", "text/html", "<h1>literal HTML</h1>"],
  ["rows.csv", "text/csv", "name,status\nalpha,ready\n"],
  ["settings.json", "application/json", '{"ready":true}\n'],
  ["config.xml", "application/xml", "<ready>true</ready>"],
  ["notes.txt", "application/octet-stream", "Text with generic metadata"],
  ["empty.txt", "", ""],
])("previews %s as literal text", async (title, mimeType, text) => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(text)));
  const panel = await mountAttachment({ title, mimeType });
  await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe(text));
  expect(panel.querySelector("iframe, h1, table")).toBeNull();
});

it.each([
  { title: "notes.txt", mimeType: "application/pdf" },
  { title: "archive.bin", mimeType: "application/octet-stream" },
  { title: "notes.txt", src: "https://files.example/notes.txt" },
])("does not fetch unsupported or external documents: $title $mimeType $src", async (content) => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment(content);
  expect(panel.querySelector("pre")).toBeNull();
  expect(panel.querySelector("a[download]")).not.toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("declines a known oversized text file without fetching", async () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment({ sizeBytes: 256 * 1024 + 1 });
  await vi.waitFor(() => expect(panel.textContent).toContain("Download it to read the full file"));
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(["advertised", "streamed"])(
  "cancels %s oversized responses and preserves download",
  async (sizeSource) => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1024 + 1));
        },
        cancel,
      }),
      { headers: sizeSource === "advertised" ? { "Content-Length": "262145" } : {} },
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
    const panel = await mountAttachment();
    await vi.waitFor(() =>
      expect(panel.textContent).toContain("Download it to read the full file"),
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(panel.querySelector("pre")).toBeNull();
    expect(panel.querySelector("a[download]")).not.toBeNull();
  },
);

it.each([new Uint8Array([0xff]), new Uint8Array([0x61, 0x00, 0x62])])(
  "does not lossily decode non-text bytes",
  async (bytes) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes)));
    const panel = await mountAttachment();
    await vi.waitFor(() =>
      expect(panel.textContent).toContain("Download it to read the full file"),
    );
    expect(panel.querySelector("pre")).toBeNull();
  },
);

it("shows a download fallback for an unavailable response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response("denied", { status: 403 })),
  );
  const panel = await mountAttachment();
  await vi.waitFor(() => expect(panel.textContent).toContain("Download it to read the full file"));
  expect(panel.querySelector("pre")).toBeNull();
});

it("aborts a superseded read and never displays its late contents", async () => {
  let resolveOld!: (response: Response) => void;
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce(new Response("Current file"));
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const signal = fetchMock.mock.calls[0]?.[1]?.signal;
  panel.content = {
    kind: "attachment",
    title: "next.txt",
    src: "/next.txt",
    mimeType: "text/plain",
  };
  await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe("Current file"));
  expect(signal?.aborted).toBe(true);
  resolveOld(new Response("Old file"));
  await vi.waitFor(() => expect(fetchMock.mock.settledResults[0]?.type).toBe("fulfilled"));
  await panel.querySelector("openclaw-chat-text-attachment")?.updateComplete;
  expect(panel.querySelector("pre")?.textContent).toBe("Current file");
});

it("aborts a closed preview and reloads it after remount", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    )
    .mockResolvedValueOnce(new Response("Reloaded text"));
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  panel.remove();
  expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  document.body.append(panel);
  await vi.waitFor(() => expect(panel.querySelector("pre")?.textContent).toBe("Reloaded text"));
});

it("times out even when a response stalls while reading its body", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("Aborted", "AbortError")),
              );
            },
          }),
        ),
    ),
  );
  const panel = await mountAttachment();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(panel.textContent).toContain("Download it to read the full file");
  expect(panel.querySelector("pre")).toBeNull();
});
