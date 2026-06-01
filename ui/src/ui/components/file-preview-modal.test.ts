/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawFilePreviewModal } from "./file-preview-modal.ts";
import "./file-preview-modal.ts";

let container: HTMLDivElement;

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

async function renderPreview(query = "") {
  render(
    html`
      <openclaw-file-preview-modal
        .files=${files}
        .activePath=${"templates/digest.md"}
        .query=${query}
        .contextLabel=${"in morning-catchup"}
      ></openclaw-file-preview-modal>
    `,
    container,
  );

  const modal = container.querySelector<OpenClawFilePreviewModal>("openclaw-file-preview-modal");
  expect(modal).toBeInstanceOf(HTMLElement);
  if (!modal) {
    throw new Error("expected file preview modal");
  }
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

  afterEach(() => {
    render(nothing, container);
    container.remove();
    vi.restoreAllMocks();
  });

  it("filters files by path or contents", async () => {
    const modal = await renderPreview("sender");

    expect(shadowText(modal)).toContain("1/2 files");
    expect(shadowText(modal)).toContain("filters/auto-senders.txt");
    expect(shadowText(modal)).not.toContain("templates/digest.md");
    expect(shadowText(modal)).toContain("noreply@example.com");
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

  it("blocks background arrow-key scrolling even when no files match", async () => {
    const modal = await renderPreview("missing");
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
});
