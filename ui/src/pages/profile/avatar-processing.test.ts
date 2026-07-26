/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { processProfileAvatar, ProfileAvatarError } from "./avatar-processing.ts";

describe("profile avatar processing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects unreasonable source files before browser image decoding", async () => {
    await expect(
      processProfileAvatar(
        new File([new Uint8Array(10 * 1024 * 1024 + 1)], "avatar.png", {
          type: "image/png",
        }),
      ),
    ).rejects.toMatchObject({ code: "source-too-large" } satisfies Partial<ProfileAvatarError>);
  });

  it("enforces the encoded avatar hard cap through the upload surface", async () => {
    class StubImage {
      decoding = "auto";
      src = "";
      naturalWidth = 256;
      naturalHeight = 256;
      decode = vi.fn(async () => undefined);
    }
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:avatar",
      revokeObjectURL: () => undefined,
    });
    vi.stubGlobal("Image", StubImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
      callback(new Blob([new Uint8Array(512 * 1024 + 1)], { type: type ?? "image/png" }));
    });

    await expect(
      processProfileAvatar(new File(["source"], "avatar.png", { type: "image/png" })),
    ).rejects.toMatchObject({ code: "too-large" } satisfies Partial<ProfileAvatarError>);
  });

  it("center-crops without upscaling smaller uploads through the upload surface", async () => {
    class StubImage {
      decoding = "auto";
      src = "";
      naturalWidth = 80;
      naturalHeight = 60;
      decode = vi.fn(async () => undefined);
    }
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:avatar",
      revokeObjectURL: () => undefined,
    });
    vi.stubGlobal("Image", StubImage);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
      callback(new Blob([new Uint8Array([1])], { type: type ?? "image/png" }));
    });

    await processProfileAvatar(new File(["source"], "avatar.png", { type: "image/png" }));

    expect(drawImage).toHaveBeenCalledWith(expect.any(StubImage), 10, 0, 60, 60, 0, 0, 60, 60);
  });

  it("decodes, downsizes, and encodes an uploaded image before the RPC payload", async () => {
    const createObjectURL = vi.fn(() => "blob:avatar");
    const revokeObjectURL = vi.fn();
    class StubUrl extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    }
    class StubImage {
      decoding = "auto";
      src = "";
      naturalWidth = 1024;
      naturalHeight = 512;
      decode = vi.fn(async () => undefined);
    }
    vi.stubGlobal("URL", StubUrl);
    vi.stubGlobal("Image", StubImage);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
      callback(new Blob([new Uint8Array([1, 2, 3])], { type: type ?? "image/png" }));
    });

    const result = await processProfileAvatar(
      new File(["source"], "avatar.jpg", { type: "image/jpeg" }),
    );

    expect(drawImage).toHaveBeenCalledWith(expect.any(StubImage), 256, 0, 512, 512, 0, 0, 512, 512);
    expect(result).toEqual({ mime: "image/png", avatarBase64: "AQID", byteLength: 3 });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:avatar");
  });
});
