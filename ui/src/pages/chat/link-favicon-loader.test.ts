import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateLinkFavicons } from "./link-favicon-loader.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function appendPlaceholder(): HTMLImageElement {
  const root = document.createElement("div");
  root.innerHTML =
    '<a href="https://docs.example.com"><img class="markdown-link-favicon" data-link-favicon-host="docs.example.com" alt=""></a>';
  document.body.append(root);
  return root.querySelector("img") as HTMLImageElement;
}

describe("hydrateLinkFavicons", () => {
  it("does nothing without an opt-in fetcher", () => {
    const image = appendPlaceholder();
    const fetcher = vi.fn();

    hydrateLinkFavicons(document.body);

    expect(fetcher).not.toHaveBeenCalled();
    expect(image.hasAttribute("src")).toBe(false);
    expect(image.dataset.linkFaviconState).toBeUndefined();
  });

  it("loads each inert placeholder once and reveals only a decoded image", async () => {
    const image = appendPlaceholder();
    const fetcher = vi.fn().mockResolvedValue("blob:link-favicon");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 16 });

    hydrateLinkFavicons(document.body, fetcher);
    hydrateLinkFavicons(document.body, fetcher);
    await vi.waitFor(() => expect(image.src).toBe("blob:link-favicon"));
    image.dispatchEvent(new Event("load"));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("docs.example.com", expect.any(AbortSignal));
    expect(image.classList.contains("is-loaded")).toBe(true);
    expect(image.dataset.linkFaviconState).toBe("loaded");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:link-favicon");
  });

  it("leaves the link unchanged when the Gateway has no icon", async () => {
    const image = appendPlaceholder();
    const fetcher = vi.fn().mockResolvedValue(null);

    hydrateLinkFavicons(document.body, fetcher);
    await vi.waitFor(() => expect(image.dataset.linkFaviconState).toBe("failed"));

    expect(image.hasAttribute("src")).toBe(false);
    expect(image.classList.contains("is-loaded")).toBe(false);
  });
});
