/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { OpenClawFilePreviewModal } from "./file-preview-modal.ts";

let container: HTMLDivElement;

const FILE_PREVIEW_MODAL_ELEMENT_NAME = `test-openclaw-file-preview-modal-${crypto.randomUUID()}`;

// The non-isolated UI runner resets modules but not customElements. Register
// the current class graph so locale updates reach the mounted test element.
class TestFilePreviewModal extends OpenClawFilePreviewModal {}

customElements.define(FILE_PREVIEW_MODAL_ELEMENT_NAME, TestFilePreviewModal);

const files = [
  {
    path: "templates/digest.md",
    size: "2.1 KB",
    contents: "Morning digest template",
  },
  {
    path: "filters/auto-senders.txt",
    size: "418 B",
    contents: "noreply@example.com",
  },
];

type RenderPreviewOptions = {
  query?: string;
  activePath?: string;
  previewFiles?: typeof files;
};

async function renderPreview(options: RenderPreviewOptions = {}) {
  const query = options.query ?? "";
  const activePath = options.activePath ?? "templates/digest.md";
  const previewFiles = options.previewFiles ?? files;
  const modal = document.createElement(FILE_PREVIEW_MODAL_ELEMENT_NAME) as OpenClawFilePreviewModal;
  modal.files = previewFiles;
  modal.activePath = activePath;
  modal.query = query;
  modal.contextLabel = "in morning-catchup";
  container.append(modal);

  await modal.updateComplete;
  await modal.updateComplete;
  return modal;
}

function shadowText(modal: OpenClawFilePreviewModal): string {
  return modal.shadowRoot?.textContent ?? "";
}

describe("openclaw-file-preview-modal", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    await i18n.setLocale("en");
    container.replaceChildren();
    container.remove();
    vi.restoreAllMocks();
  });

  it("filters files by path or contents", async () => {
    const modal = await renderPreview({ query: "sender" });

    expect(shadowText(modal)).toContain("1/2 files");
    expect(shadowText(modal)).toContain("filters/auto-senders.txt");
    expect(shadowText(modal)).not.toContain("templates/digest.md");
    expect(shadowText(modal)).toContain("noreply@example.com");
  });

  it("shows the Escape shortcut only on the close button", async () => {
    const modal = await renderPreview();
    const state = modal.shadowRoot?.querySelector<HTMLElement>(".state");
    const closeButton = modal.shadowRoot?.querySelector<HTMLButtonElement>(".button");

    expect(state?.textContent?.trim()).toBe("2 files");
    expect(state?.querySelector(".kbd")).toBeNull();
    expect(closeButton?.textContent?.replace(/\s+/g, " ").trim()).toBe("Close esc");
    expect(closeButton?.querySelector(".kbd")?.textContent).toBe("esc");
  });

  it("emits controlled query, select, and close events", async () => {
    const modal = await renderPreview();
    const onQuery = vi.fn();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    modal.addEventListener("file-preview-query-change", onQuery);
    modal.addEventListener("file-preview-select", onSelect);
    modal.addEventListener("file-preview-close", onClose);

    const input = modal.shadowRoot?.querySelector<HTMLInputElement>(".search");
    expect(input).toBeInstanceOf(HTMLInputElement);
    input!.value = "digest";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));

    const secondFile = modal.shadowRoot?.querySelectorAll<HTMLButtonElement>(".item")[1];
    expect(secondFile).toBeInstanceOf(HTMLButtonElement);
    secondFile!.click();

    modal.shadowRoot
      ?.querySelector<HTMLElement>(".modal")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(onQuery.mock.lastCall?.[0].detail).toBe("digest");
    expect(onSelect.mock.lastCall?.[0].detail).toBe("filters/auto-senders.txt");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps keyboard focus in the modal and navigates files with arrow keys", async () => {
    const modal = await renderPreview();
    const onSelect = vi.fn();
    const onDocumentKeydown = vi.fn();
    modal.addEventListener("file-preview-select", onSelect);
    document.addEventListener("keydown", onDocumentKeydown);

    const input = modal.shadowRoot?.querySelector<HTMLInputElement>(".search");
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(modal.shadowRoot?.activeElement).toBe(input);

    const arrowDown = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input!.dispatchEvent(arrowDown);

    expect(arrowDown.defaultPrevented).toBe(true);
    expect(onDocumentKeydown).not.toHaveBeenCalled();
    expect(onSelect.mock.lastCall?.[0].detail).toBe("filters/auto-senders.txt");
  });

  it("restores modal focus when the same element reconnects", async () => {
    const modal = await renderPreview();
    const outside = document.createElement("button");
    document.body.append(outside);

    try {
      container.remove();
      outside.focus();
      expect(document.activeElement).toBe(outside);
      document.body.append(container);
      await modal.updateComplete;

      const input = modal.shadowRoot?.querySelector<HTMLInputElement>(".search");
      expect(input).toBeInstanceOf(HTMLInputElement);
      expect(modal.shadowRoot?.activeElement).toBe(input);
    } finally {
      outside.remove();
    }
  });

  it("blocks background arrow-key scrolling even when no files match", async () => {
    const modal = await renderPreview({ query: "missing" });
    const onDocumentKeydown = vi.fn();
    document.addEventListener("keydown", onDocumentKeydown);

    const input = modal.shadowRoot?.querySelector<HTMLInputElement>(".search");
    const arrowDown = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input!.dispatchEvent(arrowDown);

    expect(arrowDown.defaultPrevented).toBe(true);
    expect(onDocumentKeydown).not.toHaveBeenCalled();
  });

  it("chunks large files without changing their text and resets the scroller on file changes", async () => {
    const firstContents = Array.from({ length: 500 }, (_, index) => `first-${index}`).join("\n");
    const secondContents = Array.from({ length: 500 }, (_, index) => `second-${index}`).join("\n");
    const previewFiles = [
      { path: "first.ts", size: "5 KB", contents: firstContents },
      { path: "second.ts", size: "5 KB", contents: secondContents },
    ];
    const modal = await renderPreview({ activePath: "first.ts", previewFiles });
    const body = modal.shadowRoot?.querySelector<HTMLElement>(".detail-body");
    expect(body).toBeInstanceOf(HTMLElement);
    const firstChunks = [...(modal.shadowRoot?.querySelectorAll<HTMLElement>(".code-chunk") ?? [])];
    expect(firstChunks).toHaveLength(8);
    expect(firstChunks.map((chunk) => chunk.textContent ?? "").join("\n")).toBe(firstContents);

    body!.scrollTop = 2200;

    const updatedModal = await renderPreview({ activePath: "second.ts", previewFiles });
    const updatedBody = updatedModal.shadowRoot?.querySelector<HTMLElement>(".detail-body");
    const secondChunks = [
      ...(updatedModal.shadowRoot?.querySelectorAll<HTMLElement>(".code-chunk") ?? []),
    ];

    expect(updatedBody?.scrollTop).toBe(0);
    expect(secondChunks.map((chunk) => chunk.textContent ?? "").join("\n")).toBe(secondContents);
  });

  it("copies the complete active file while only a virtual window is rendered", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const contents = Array.from({ length: 500 }, (_, index) => `line-${index}`).join("\n");
    const previewFiles = [{ path: "large.ts", size: "5 KB", contents }];
    const modal = await renderPreview({ activePath: "large.ts", previewFiles });
    const copyButton = modal.shadowRoot?.querySelector<HTMLButtonElement>(".chat-copy-btn");

    expect(copyButton).toBeInstanceOf(HTMLButtonElement);
    expect(modal.shadowRoot?.querySelectorAll(".code-chunk").length).toBe(8);
    copyButton!.click();

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(contents);
      expect(copyButton?.dataset.copied).toBe("1");
    });
  });

  it("rerenders default copy when the locale changes", async () => {
    const modal = await renderPreview();
    i18n.registerTranslation("pt-BR", {
      common: { close: "Fechar" },
      filePreview: {
        label: "Arquivos de suporte",
        listLabel: "Arquivos",
        searchPlaceholder: "Buscar arquivos…",
        readOnly: "somente leitura",
        emptyTitle: "Nenhum arquivo corresponde",
        emptySubtitle: "Tente outro nome ou conteúdo.",
        copyFile: "Copiar arquivo",
        fileCount: "{count} arquivos",
        filteredFileCount: "{count}/{total} arquivos",
        noMatches: "Nenhum arquivo corresponde.",
        navigate: "navegar",
      },
    });

    await i18n.setLocale("pt-BR");
    await modal.updateComplete;

    expect(modal.shadowRoot?.querySelector(".modal")?.getAttribute("aria-label")).toBe(
      "Arquivos de suporte",
    );
    expect(shadowText(modal)).toContain("2 arquivos");
    expect(shadowText(modal)).toContain("Fechar");
  });
});
