/* @vitest-environment jsdom */

import { MermaidTransientError, renderMermaidSvg } from "@openclaw/mermaid-renderer";
import { html, nothing, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { copyToClipboard } from "../lib/clipboard.ts";
import { mountMermaidBlocks } from "./markdown-mermaid.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

vi.mock("@openclaw/mermaid-renderer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/mermaid-renderer")>()),
  renderMermaidSvg: vi.fn(),
}));
vi.mock("../lib/clipboard.ts", () => ({ copyToClipboard: vi.fn() }));

type MermaidElement = HTMLElementTagNameMap["openclaw-mermaid"];
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered diagram</text></svg>';
const renderSvg = vi.mocked(renderMermaidSvg);
const copySource = vi.mocked(copyToClipboard);
const containers = new Set<HTMLElement>();
let sourceSequence = 0;
let originalThemeMode: string | null;
let originalStyle: string | null;
let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob | MediaSource) => string>>;
let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;

function source(label: string): string {
  return `flowchart LR\n  A["${label} ${++sourceSequence}"] --> B\n`;
}

async function mount(...sources: string[]) {
  const container = document.body.appendChild(document.createElement("div"));
  containers.add(container);
  const markdown = sources.map((value) => `\`\`\`mermaid\n${value}\`\`\``).join("\n\n");
  render(html`${unsafeHTML(toSanitizedMarkdownHtml(markdown))}`, container);
  mountMermaidBlocks(container);
  const elements = [...container.querySelectorAll("openclaw-mermaid")];
  expect(elements).toHaveLength(sources.length);
  await Promise.all(elements.map((element) => element.updateComplete));
  return { container, elements };
}

function action(element: MermaidElement, label: string) {
  const controls = element.shadowRoot?.querySelectorAll<
    HTMLButtonElement | HTMLElementTagNameMap["wa-dropdown-item"]
  >("button, wa-dropdown-item");
  const match = [...(controls ?? [])].find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === label,
  );
  if (!match) {
    throw new Error(`Missing Mermaid action: ${label}`);
  }
  return match;
}

function imageSource(element: MermaidElement): string | null | undefined {
  return element.shadowRoot?.querySelector("img")?.getAttribute("src");
}

async function waitForImage(element: MermaidElement): Promise<string> {
  await vi.waitFor(() => expect(imageSource(element)).toMatch(/^blob:mermaid-/u));
  return imageSource(element)!;
}

beforeEach(() => {
  renderSvg.mockReset().mockResolvedValue(svg);
  copySource.mockReset().mockResolvedValue(true);
  let urlSequence = 0;
  createObjectURL = vi.fn(() => `blob:mermaid-${++urlSequence}`);
  revokeObjectURL = vi.fn();
  const NativeURL = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  const root = document.documentElement;
  originalThemeMode = root.getAttribute("data-theme-mode");
  originalStyle = root.getAttribute("style");
  root.dataset.themeMode = "light";
  for (const property of ["--card", "--text", "--muted", "--border", "--accent"]) {
    root.style.setProperty(property, "#123456");
  }
});

afterEach(() => {
  for (const container of containers) {
    render(nothing, container);
    container.remove();
  }
  containers.clear();
  for (const [attribute, value] of [
    ["data-theme-mode", originalThemeMode],
    ["style", originalStyle],
  ] as const) {
    if (value === null) {
      document.documentElement.removeAttribute(attribute);
    } else {
      document.documentElement.setAttribute(attribute, value);
    }
  }
  vi.unstubAllGlobals();
});

describe("Mermaid Markdown presentation", () => {
  it.each([true, false])("preserves source and reports copy success=%s", async (copied) => {
    copySource.mockResolvedValueOnce(copied);
    const original = source("x < y & z <script>alert(1)</script>");
    const {
      elements: [element],
    } = await mount(original);
    const imageUrl = await waitForImage(element!);

    expect(renderSvg).toHaveBeenCalledWith(original, expect.objectContaining({ darkMode: false }));
    expect(action(element!, "Expand diagram").disabled).toBe(false);
    action(element!, "Show source").click();
    await element!.updateComplete;
    expect(element!.shadowRoot?.querySelector("code")?.textContent).toBe(original);
    expect(element!.shadowRoot?.querySelector("script, img")).toBeNull();
    action(element!, "Copy source").click();
    await vi.waitFor(() =>
      expect(action(element!, copied ? "Copied!" : "Copy failed")).toBeDefined(),
    );
    expect(copySource.mock.calls.map(([text]) => text)).toEqual([original]);

    action(element!, "Show diagram").click();
    await element!.updateComplete;
    expect(imageSource(element!)).toBe(imageUrl);
    expect(renderSvg).toHaveBeenCalledTimes(1);
  });

  it.each([
    { failure: "layout", message: "Check the source or simplify the diagram" },
    { failure: "renderer", message: "check proxy or authentication rules" },
    { failure: "image", message: "The diagram image could not be displayed" },
  ])("keeps $failure failures actionable, readable and copyable", async ({ failure, message }) => {
    if (failure === "layout") {
      renderSvg.mockRejectedValueOnce(new Error("<script>internal parser detail</script>"));
    } else if (failure === "renderer") {
      renderSvg.mockRejectedValueOnce(new MermaidTransientError("Renderer could not load"));
    }
    const original = source("Invalid diagram");
    const {
      elements: [element],
    } = await mount(original);
    if (failure === "image") {
      await waitForImage(element!);
      element!.shadowRoot?.querySelector("img")?.dispatchEvent(new Event("error"));
    }

    await vi.waitFor(() =>
      expect(element!.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain(message),
    );
    expect(element!.shadowRoot?.querySelector("code")?.textContent).toBe(original);
    expect(element!.shadowRoot?.querySelector("img, script")).toBeNull();
    expect(element!.shadowRoot?.textContent).not.toContain("internal parser detail");
    expect(action(element!, "Expand diagram").disabled).toBe(true);
    action(element!, "Copy source").click();
    await vi.waitFor(() => expect(copySource.mock.calls.map(([text]) => text)).toEqual([original]));
    if (failure === "image") {
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:mermaid-1");
    } else {
      expect(createObjectURL).not.toHaveBeenCalled();
    }
  });

  it.each([
    { change: "source", oldOutcome: "success" },
    { change: "source", oldOutcome: "failure" },
    { change: "theme", oldOutcome: "success" },
    { change: "theme", oldOutcome: "failure" },
  ])("ignores a stale $oldOutcome after a $change change", async ({ change, oldOutcome }) => {
    const old = createDeferred<string>();
    const current = createDeferred<string>();
    renderSvg.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const {
      elements: [element],
    } = await mount(source("Old diagram"));
    expect(renderSvg).toHaveBeenCalledTimes(1);
    if (change === "source") {
      element!.source = source("Current diagram");
    } else {
      document.documentElement.dataset.themeMode = "dark";
    }
    await vi.waitFor(() => expect(renderSvg).toHaveBeenCalledTimes(2));
    if (change === "theme") {
      expect(renderSvg.mock.calls[1]?.[1].darkMode).toBe(true);
    }
    current.resolve(svg);
    const imageUrl = await waitForImage(element!);
    if (oldOutcome === "success") {
      old.resolve(svg);
    } else {
      old.reject(new Error("Stale failure"));
    }
    await old.promise.catch(() => {});
    await element!.updateComplete;

    expect(imageSource(element!)).toBe(imageUrl);
    expect(element!.shadowRoot?.querySelector('[role="status"]')).toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "releases URLs across reconnect with disconnect before render=%s",
    async (disconnectBeforeRender) => {
      const pending = createDeferred<string>();
      renderSvg.mockReturnValueOnce(pending.promise);
      const {
        container,
        elements: [element],
      } = await mount(source("Reconnected diagram"));
      if (!disconnectBeforeRender) {
        pending.resolve(svg);
        await waitForImage(element!);
      }
      element!.remove();
      if (disconnectBeforeRender) {
        pending.resolve(svg);
        await pending.promise;
        expect(createObjectURL).not.toHaveBeenCalled();
      } else {
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:mermaid-1");
      }

      container.append(element!);
      const reconnectedUrl = disconnectBeforeRender ? "blob:mermaid-1" : "blob:mermaid-2";
      await vi.waitFor(() => expect(imageSource(element!)).toBe(reconnectedUrl));
      expect(renderSvg).toHaveBeenCalledTimes(1);
      expect(createObjectURL).toHaveBeenCalledTimes(disconnectBeforeRender ? 1 : 2);
      element!.remove();
      expect(revokeObjectURL).toHaveBeenCalledWith(reconnectedUrl);
      expect(revokeObjectURL).toHaveBeenCalledTimes(createObjectURL.mock.calls.length);
    },
  );

  it("shares concurrent layout work while each displayed diagram owns its URL", async () => {
    const pending = createDeferred<string>();
    renderSvg.mockReturnValueOnce(pending.promise);
    const original = source("Shared layout");
    const { elements } = await mount(original, original);
    expect(renderSvg).toHaveBeenCalledTimes(1);
    pending.resolve(svg);
    const [firstUrl, secondUrl] = await Promise.all(elements.map(waitForImage));
    expect(firstUrl).not.toBe(secondUrl);

    elements[0]!.remove();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(firstUrl);
    expect(imageSource(elements[1]!)).toBe(secondUrl);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(secondUrl);
  });

  it("evicts older layouts under sustained use without revoking visible images", async () => {
    const sources = Array.from({ length: 20 }, (_, index) => source(`Diagram ${index}`));
    const { elements } = await mount(...sources);
    const originalUrls = await Promise.all(elements.map(waitForImage));
    expect(renderSvg).toHaveBeenCalledTimes(sources.length);

    const recent = await mount(sources.at(-1)!);
    await waitForImage(recent.elements[0]!);
    expect(renderSvg).toHaveBeenCalledTimes(sources.length);
    const oldest = await mount(sources[0]!);
    await waitForImage(oldest.elements[0]!);
    expect(renderSvg).toHaveBeenCalledTimes(sources.length + 1);
    expect(elements.map(imageSource)).toEqual(originalUrls);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
