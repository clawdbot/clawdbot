import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginRuntime } from "clawdbot/plugin-sdk";
import { setMatrixRuntime } from "../../runtime.js";
import { downloadMatrixMedia } from "./media.js";

describe("downloadMatrixMedia", () => {
  const saveMediaBuffer = vi.fn().mockResolvedValue({
    path: "/tmp/media",
    contentType: "image/png",
  });

  const runtimeStub = {
    channel: {
      media: {
        saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
      },
    },
  } as unknown as PluginRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    setMatrixRuntime(runtimeStub);
  });

  it("decrypts encrypted media when file payloads are present", async () => {
    const decryptMedia = vi.fn().mockResolvedValue(Buffer.from("decrypted"));

    const client = {
      crypto: { decryptMedia },
      mxcToHttp: vi.fn().mockReturnValue("https://example/mxc"),
    } as unknown as import("matrix-bot-sdk").MatrixClient;

    const file = {
      url: "mxc://example/file",
      key: {
        kty: "oct",
        key_ops: ["encrypt", "decrypt"],
        alg: "A256CTR",
        k: "secret",
        ext: true,
      },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    };

    const result = await downloadMatrixMedia({
      client,
      mxcUrl: "mxc://example/file",
      contentType: "image/png",
      maxBytes: 1024,
      file,
    });

    // decryptMedia should be called with just the file object (it handles download internally)
    expect(decryptMedia).toHaveBeenCalledWith(file);
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("decrypted"),
      "image/png",
      "inbound",
      1024,
    );
    expect(result?.path).toBe("/tmp/media");
  });

  it("rejects encrypted media that exceeds maxBytes before decrypting", async () => {
    const decryptMedia = vi.fn().mockResolvedValue(Buffer.from("decrypted"));

    const client = {
      crypto: { decryptMedia },
      mxcToHttp: vi.fn().mockReturnValue("https://example/mxc"),
    } as unknown as import("matrix-bot-sdk").MatrixClient;

    const file = {
      url: "mxc://example/file",
      key: {
        kty: "oct",
        key_ops: ["encrypt", "decrypt"],
        alg: "A256CTR",
        k: "secret",
        ext: true,
      },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    };

    await expect(
      downloadMatrixMedia({
        client,
        mxcUrl: "mxc://example/file",
        contentType: "image/png",
        sizeBytes: 2048,
        maxBytes: 1024,
        file,
      }),
    ).rejects.toThrow("Matrix media exceeds configured size limit");

    expect(decryptMedia).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });
});
