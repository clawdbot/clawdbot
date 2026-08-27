/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fileToAvatarDataUrl } from "./avatar-image.ts";

describe("fileToAvatarDataUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["encoded", "missing context", "failed draw"])(
    "releases the decoded bitmap when the canvas is %s",
    async (outcome) => {
      const close = vi.fn();
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn().mockResolvedValue({ width: 80, height: 80, close }),
      );
      const drawImage = vi.fn(() => {
        if (outcome === "failed draw") {
          throw new Error("Canvas draw failed");
        }
      });
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
        outcome === "missing context"
          ? null
          : ({ drawImage } as unknown as CanvasRenderingContext2D),
      );
      vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
        "data:image/png;base64,AQID",
      );
      const file = new File([new Uint8Array([1, 2, 3])], "avatar.png", { type: "image/png" });

      await expect(fileToAvatarDataUrl(file)).resolves.toMatch(/^data:image\/png;base64,/u);

      expect(close).toHaveBeenCalledOnce();
    },
  );

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
