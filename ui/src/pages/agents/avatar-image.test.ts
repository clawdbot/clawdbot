/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fileToAvatarDataUrl } from "./avatar-image.ts";

describe("fileToAvatarDataUrl", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects fallback encodings that would consume the identity bootstrap budget", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("unsupported")));
    const file = new File([new Uint8Array(20_000)], "avatar.png", { type: "image/png" });

    await expect(fileToAvatarDataUrl(file)).resolves.toBeNull();
  });

  it("keeps small fallback encodings", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("unsupported")));
    const file = new File([new Uint8Array([1, 2, 3])], "avatar.png", { type: "image/png" });

    await expect(fileToAvatarDataUrl(file)).resolves.toMatch(/^data:image\/png;base64,/u);
  });
});
