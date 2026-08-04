// Control UI tests cover open external url behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openExternalUrlSafe,
  reserveExternalWindowForDeferredNavigation,
  resolveSafeExternalUrl,
} from "./open-external-url.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveSafeExternalUrl", () => {
  const baseHref = "https://openclaw.ai/chat";

  it("allows absolute https URLs", () => {
    expect(resolveSafeExternalUrl("https://example.com/a.png?x=1#y", baseHref)).toBe(
      "https://example.com/a.png?x=1#y",
    );
  });

  it("allows relative URLs resolved against the current origin", () => {
    expect(resolveSafeExternalUrl("/assets/pic.png", baseHref)).toBe(
      "https://openclaw.ai/assets/pic.png",
    );
  });

  it("allows blob URLs", () => {
    expect(resolveSafeExternalUrl("blob:https://openclaw.ai/abc-123", baseHref)).toBe(
      "blob:https://openclaw.ai/abc-123",
    );
  });

  it("allows data image URLs when enabled", () => {
    expect(
      resolveSafeExternalUrl("data:image/png;base64,iVBORw0KGgo=", baseHref, {
        allowDataImage: true,
      }),
    ).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("rejects non-image data URLs", () => {
    expect(
      resolveSafeExternalUrl("data:text/html,<script>alert(1)</script>", baseHref, {
        allowDataImage: true,
      }),
    ).toBeNull();
  });

  it("rejects SVG data image URLs", () => {
    expect(
      resolveSafeExternalUrl(
        "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />",
        baseHref,
        {
          allowDataImage: true,
        },
      ),
    ).toBeNull();
  });

  it("rejects base64-encoded SVG data image URLs", () => {
    expect(
      resolveSafeExternalUrl(
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIC8+",
        baseHref,
        {
          allowDataImage: true,
        },
      ),
    ).toBeNull();
  });

  it("rejects data image URLs unless explicitly enabled", () => {
    expect(resolveSafeExternalUrl("data:image/png;base64,iVBORw0KGgo=", baseHref)).toBeNull();
  });

  it("rejects javascript URLs", () => {
    expect(resolveSafeExternalUrl("javascript:alert(1)", baseHref)).toBeNull();
  });

  it("rejects file URLs", () => {
    expect(resolveSafeExternalUrl("file:///tmp/x.png", baseHref)).toBeNull();
  });

  it("rejects empty values", () => {
    expect(resolveSafeExternalUrl("   ", baseHref)).toBeNull();
  });
});

describe("openExternalUrlSafe", () => {
  it("nulls opener when window.open returns a proxy-like object", () => {
    const openedLikeProxy = {
      opener: { postMessage: () => void 0 },
    } as unknown as WindowProxy;
    const openMock = vi
      .spyOn(window, "open")
      .mockImplementation(() => openedLikeProxy as unknown as Window);

    const opened = openExternalUrlSafe("https://example.com/safe.png", {
      baseHref: "https://openclaw.ai/chat",
    });

    expect(openMock).toHaveBeenCalledWith(
      "https://example.com/safe.png",
      "_blank",
      "noopener,noreferrer",
    );
    expect(opened).toBe(openedLikeProxy);
    expect(openedLikeProxy.opener).toBeNull();
  });
});

describe("reserveExternalWindowForDeferredNavigation", () => {
  it("opens an inert placeholder and detaches its opener", () => {
    const openedLikeProxy = {
      opener: { postMessage: () => void 0 },
    } as unknown as WindowProxy;
    const openMock = vi
      .spyOn(window, "open")
      .mockImplementation(() => openedLikeProxy as unknown as Window);

    const opened = reserveExternalWindowForDeferredNavigation();

    expect(openMock).toHaveBeenCalledWith("about:blank", "_blank");
    expect(opened).toBe(openedLikeProxy);
    expect(openedLikeProxy.opener).toBeNull();
  });
});
