/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import "./image-lightbox.ts";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;
let createObjectUrl: ReturnType<typeof vi.fn<(object: Blob | MediaSource) => string>>;
let revokeObjectUrl: ReturnType<typeof vi.fn<(url: string) => void>>;
let fetchImage: ReturnType<typeof vi.fn>;

async function renderLightbox() {
  render(
    html`<openclaw-image-lightbox
      src="data:image/png;base64,cG5n"
      title="Generated lobster"
    ></openclaw-image-lightbox>`,
    container,
  );
  const modal = container.querySelector("openclaw-image-lightbox");
  if (!modal) {
    throw new Error("missing image lightbox");
  }
  await modal.updateComplete;
  const dialogAdapter = modal.shadowRoot?.querySelector("openclaw-modal-dialog");
  if (!dialogAdapter) {
    throw new Error("missing modal dialog adapter");
  }
  await getRenderedModalDialog((modal.shadowRoot ?? modal) as unknown as HTMLElement);
  return { modal, dialogAdapter };
}

describe("openclaw-image-lightbox", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
    createObjectUrl = vi.fn(() => "blob:lightbox-original");
    revokeObjectUrl = vi.fn();
    fetchImage = vi.fn(async () => ({
      blob: async () => new Blob(["png"], { type: "image/png" }),
    }));
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL(object: Blob | MediaSource): string {
          return createObjectUrl(object);
        }

        static override revokeObjectURL(url: string): void {
          revokeObjectUrl(url);
        }
      },
    );
    vi.stubGlobal("fetch", fetchImage);
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    restoreDialogPolyfill();
    vi.unstubAllGlobals();
  });

  it("renders a labelled large image with original and close actions", async () => {
    const { modal } = await renderLightbox();
    const root = modal.shadowRoot;

    expect(root?.querySelector<HTMLImageElement>("img")?.alt).toBe("Generated lobster");
    expect(root?.querySelector<HTMLImageElement>("img")?.src).toBe("data:image/png;base64,cG5n");
    await vi.waitFor(() =>
      expect(root?.querySelector<HTMLAnchorElement>("a")?.href).toBe("blob:lightbox-original"),
    );
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(root?.querySelector<HTMLButtonElement>("button")?.hasAttribute("autofocus")).toBe(true);
  });

  it("accepts parameters on safe raster MIME types", async () => {
    fetchImage.mockResolvedValueOnce({
      blob: async () => new Blob(["png"], { type: "image/png;charset=utf-8" }),
    });
    render(
      html`<openclaw-image-lightbox
        src="data:image/png;charset=utf-8;base64,cG5n"
        title="Generated lobster"
      ></openclaw-image-lightbox>`,
      container,
    );
    const modal = container.querySelector("openclaw-image-lightbox");
    if (!modal) {
      throw new Error("missing image lightbox");
    }
    await modal.updateComplete;

    await vi.waitFor(() =>
      expect(modal.shadowRoot?.querySelector<HTMLAnchorElement>(".open-original")?.href).toBe(
        "blob:lightbox-original",
      ),
    );
  });

  it("releases and recreates the original-image URL across reconnection", async () => {
    const { modal } = await renderLightbox();
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));

    modal.remove();

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:lightbox-original");

    container.append(modal);
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(2));
  });

  it("omits the original action for active data image formats", async () => {
    render(
      html`<openclaw-image-lightbox
        src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>"
        title="Untrusted SVG"
      ></openclaw-image-lightbox>`,
      container,
    );
    const modal = container.querySelector("openclaw-image-lightbox");
    if (!modal) {
      throw new Error("missing image lightbox");
    }
    await modal.updateComplete;

    expect(modal.shadowRoot?.querySelector(".open-original")).toBeNull();
    expect(fetchImage).not.toHaveBeenCalled();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("keeps Tab focus within the lightbox actions", async () => {
    const { modal } = await renderLightbox();
    const root = modal.shadowRoot;
    await vi.waitFor(() =>
      expect(root?.querySelector<HTMLAnchorElement>(".open-original")).toBeTruthy(),
    );
    const openOriginal = root?.querySelector<HTMLAnchorElement>(".open-original");
    const closeButton = root?.querySelector<HTMLButtonElement>(".close");
    closeButton?.focus();

    closeButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(root?.activeElement).toBe(openOriginal);

    openOriginal?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(root?.activeElement).toBe(closeButton);
  });

  it("emits one close event for the close button and modal cancellation", async () => {
    const { modal, dialogAdapter } = await renderLightbox();
    let closes = 0;
    modal.addEventListener("image-lightbox-close", () => {
      closes += 1;
    });

    modal.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();
    expect(closes).toBe(1);

    dialogAdapter.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true }));
    expect(closes).toBe(2);
  });
});
