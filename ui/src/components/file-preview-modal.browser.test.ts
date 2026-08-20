import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenClawFilePreviewModal } from "./file-preview-modal.ts";
import type { OpenClawModalDialog } from "./modal-dialog.ts";
import "./file-preview-modal-registration.ts";

const browserMode = "__vitest_browser__" in globalThis;
const initialFilePath =
  "templates/customer-success/quarterly-reviews/complete-digest-template-with-a-long-name.md";

const files = [
  {
    path: initialFilePath,
    size: "2.1 KB",
    contents: "Review the complete support-file contents.",
  },
  {
    path: "filters/auto-senders.txt",
    size: "418 B",
    contents: "noreply@example.com",
  },
  {
    path: "assets/empty-preview.png",
    size: "0 B",
    contents: "",
  },
];

afterEach(() => {
  document.body.replaceChildren();
});

async function resolveRenderedDialog(modal: OpenClawModalDialog) {
  await modal.updateComplete;
  const webAwesomeDialog = modal.shadowRoot?.querySelector<WaDialog>("wa-dialog");
  expect(webAwesomeDialog).toBeInstanceOf(HTMLElement);
  await webAwesomeDialog?.updateComplete;
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  const dialog = webAwesomeDialog?.shadowRoot?.querySelector("dialog");
  expect(dialog?.open).toBe(true);
  // Web Awesome opens at 80% scale; measure the settled dialog, not its first animation frame.
  await Promise.all(dialog!.getAnimations().map((animation) => animation.finished));
  return dialog!;
}

async function mountPreview(width: number, activePath = initialFilePath) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, 844);

  const preview = document.createElement("openclaw-file-preview-modal") as OpenClawFilePreviewModal;
  preview.style.setProperty("--wa-transition-normal", "150ms");
  preview.files = files;
  preview.activePath = activePath;
  document.body.append(preview);
  await preview.updateComplete;

  const ownerDialog =
    preview.shadowRoot?.querySelector<OpenClawModalDialog>("openclaw-modal-dialog");
  expect(ownerDialog).toBeInstanceOf(HTMLElement);
  const dialog = await resolveRenderedDialog(ownerDialog!);
  return { preview, dialog };
}

async function mountModal(
  width: number,
  options: {
    fullscreen?: boolean;
    kind?: "drawer" | "nav-drawer";
    modalWidth: string;
  },
) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, 844);

  const modal = document.createElement("openclaw-modal-dialog");
  modal.label = "Preview";
  modal.style.setProperty("--wa-transition-normal", "150ms");
  modal.style.setProperty("--openclaw-modal-width", options.modalWidth);
  modal.classList.toggle("fullscreen", options.fullscreen === true);
  modal.classList.toggle("drawer", options.kind !== undefined);
  modal.classList.toggle("nav-drawer", options.kind === "nav-drawer");
  const content = document.createElement("div");
  content.style.cssText = "width: 100%; height: 80px;";
  modal.append(content);
  document.body.append(modal);
  return await resolveRenderedDialog(modal);
}

describe.runIf(browserMode)("file preview modal responsive layout", () => {
  it.each([320, 375, 390, 640])(
    "keeps source and copy visible at a %dpx viewport",
    async (width) => {
      const { preview, dialog } = await mountPreview(width);
      const list = preview.shadowRoot?.querySelector<HTMLElement>(".list");
      const detail = preview.shadowRoot?.querySelector<HTMLElement>(".detail");
      const copy = preview.shadowRoot?.querySelector<HTMLButtonElement>(".chat-copy-btn");
      const search = preview.shadowRoot?.querySelector<HTMLInputElement>(".search");
      const source = preview.shadowRoot?.querySelector<HTMLElement>(".code-chunk");
      const activeItem = preview.shadowRoot?.querySelector<HTMLElement>(".item.is-active");
      const title = preview.shadowRoot?.querySelector<HTMLElement>(".title");
      expect(list).toBeInstanceOf(HTMLElement);
      expect(detail).toBeInstanceOf(HTMLElement);
      expect(copy).toBeInstanceOf(HTMLButtonElement);
      expect(search).toBeInstanceOf(HTMLInputElement);
      expect(source).toBeInstanceOf(HTMLElement);
      expect(activeItem).toBeInstanceOf(HTMLElement);
      expect(title).toBeInstanceOf(HTMLElement);

      const dialogBounds = dialog.getBoundingClientRect();
      const listBounds = list!.getBoundingClientRect();
      const detailBounds = detail!.getBoundingClientRect();
      const copyBounds = copy!.getBoundingClientRect();
      const searchBounds = search!.getBoundingClientRect();
      const sourceBounds = source!.getBoundingClientRect();
      const activeItemBounds = activeItem!.getBoundingClientRect();
      const titleBounds = title!.getBoundingClientRect();
      const sourceTextRange = document.createRange();
      sourceTextRange.selectNodeContents(source!);
      const sourceTextBounds = sourceTextRange.getBoundingClientRect();

      expect(dialogBounds.left).toBeGreaterThanOrEqual(0);
      expect(dialogBounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(dialogBounds.top).toBeGreaterThanOrEqual(0);
      expect(dialogBounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(detailBounds.top).toBeGreaterThanOrEqual(listBounds.bottom - 1);
      expect(detailBounds.width).toBeGreaterThan(200);
      expect(copyBounds.top).toBeGreaterThanOrEqual(0);
      expect(copyBounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(copyBounds.left).toBeGreaterThanOrEqual(dialogBounds.left - 1);
      expect(copyBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(searchBounds.width).toBeGreaterThan(80);
      expect(searchBounds.left).toBeGreaterThanOrEqual(0);
      expect(searchBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(searchBounds.top).toBeGreaterThanOrEqual(0);
      expect(searchBounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(activeItemBounds.left).toBeGreaterThanOrEqual(dialogBounds.left - 1);
      expect(activeItemBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(titleBounds.left).toBeGreaterThanOrEqual(dialogBounds.left - 1);
      expect(titleBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(title?.textContent).toBe(initialFilePath);
      expect(sourceBounds.width).toBeGreaterThan(100);
      expect(sourceBounds.height).toBeGreaterThan(0);
      expect(sourceBounds.top).toBeGreaterThanOrEqual(0);
      expect(sourceBounds.top).toBeLessThan(window.innerHeight);
      expect(sourceTextBounds.width).toBeGreaterThan(0);
      expect(sourceTextBounds.height).toBeGreaterThan(0);
      expect(sourceTextBounds.left).toBeGreaterThanOrEqual(dialogBounds.left - 1);
      expect(sourceTextBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(sourceTextBounds.top).toBeGreaterThanOrEqual(0);
      expect(sourceTextBounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(source?.textContent).toContain("Review the complete support-file contents.");

      const selected = vi.fn();
      preview.addEventListener("file-preview-select", selected);
      search?.focus();
      const { userEvent } = await import("vitest/browser");
      await userEvent.keyboard("{ArrowDown}");
      expect(selected).toHaveBeenCalledOnce();
      expect(selected.mock.calls[0]?.[0].detail).toBe("filters/auto-senders.txt");
    },
  );

  it.each([375, 640])(
    "keeps an empty non-text preview reachable at a %dpx viewport",
    async (width) => {
      const { preview, dialog } = await mountPreview(width, "assets/empty-preview.png");
      const detail = preview.shadowRoot?.querySelector<HTMLElement>(".detail");
      const title = preview.shadowRoot?.querySelector<HTMLElement>(".title");
      const kind = preview.shadowRoot?.querySelector<HTMLElement>(".chip.accent");
      const detailBody = preview.shadowRoot?.querySelector<HTMLElement>(".detail-body");
      expect(detail).toBeInstanceOf(HTMLElement);
      expect(title?.textContent).toBe("assets/empty-preview.png");
      expect(kind?.textContent).toBe("PNG");
      expect(detailBody).toBeInstanceOf(HTMLElement);
      expect(preview.shadowRoot?.querySelector(".chat-copy-btn")).toBeNull();
      expect(preview.shadowRoot?.querySelector(".code-chunk")?.textContent).toBe("");

      const dialogBounds = dialog.getBoundingClientRect();
      const detailBounds = detail!.getBoundingClientRect();
      const detailBodyBounds = detailBody!.getBoundingClientRect();
      expect(detailBounds.left).toBeGreaterThanOrEqual(dialogBounds.left - 1);
      expect(detailBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
      expect(detailBodyBounds.top).toBeGreaterThanOrEqual(0);
      expect(detailBodyBounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    },
  );

  it("preserves the desktop side-by-side file layout", async () => {
    const { preview, dialog } = await mountPreview(1280);
    const list = preview.shadowRoot?.querySelector<HTMLElement>(".list");
    const detail = preview.shadowRoot?.querySelector<HTMLElement>(".detail");
    expect(list).toBeInstanceOf(HTMLElement);
    expect(detail).toBeInstanceOf(HTMLElement);

    const listBounds = list!.getBoundingClientRect();
    const detailBounds = detail!.getBoundingClientRect();
    expect(listBounds.width).toBeCloseTo(360, 0);
    expect(detailBounds.left).toBeGreaterThanOrEqual(listBounds.right - 1);
    expect(detailBounds.right).toBeLessThanOrEqual(dialog.getBoundingClientRect().right + 1);
  });

  it.each([1280, 390])("expands fullscreen previews at a %dpx viewport", async (width) => {
    const dialog = await mountModal(width, {
      fullscreen: true,
      modalWidth: "min(1040px, calc(100vw - 32px))",
    });

    expect(dialog.getBoundingClientRect().width).toBeGreaterThanOrEqual(width - 21);
  });

  it("preserves narrower owner-defined modal widths on phones", async () => {
    const dialog = await mountModal(390, { modalWidth: "200px" });

    expect(dialog.getBoundingClientRect().width).toBeCloseTo(200, 0);
  });

  it.each([
    { viewport: 390, expectedWidth: 390 },
    { viewport: 1280, expectedWidth: 460 },
  ])("keeps workboard drawers edge-to-edge on phones", async ({ viewport, expectedWidth }) => {
    const dialog = await mountModal(viewport, {
      kind: "drawer",
      modalWidth: "min(460px, 100vw)",
    });

    expect(dialog.getBoundingClientRect().width).toBeCloseTo(expectedWidth, 0);
  });

  it("preserves the navigation drawer's narrower owned width", async () => {
    const dialog = await mountModal(390, {
      kind: "nav-drawer",
      modalWidth: "min(460px, 100vw)",
    });

    expect(dialog.getBoundingClientRect().width).toBeCloseTo(320, 0);
  });
});
