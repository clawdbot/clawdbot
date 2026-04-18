import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mediaRuntimeMocks = vi.hoisted(() => ({
  fetchRemoteMedia: vi.fn(),
}));

vi.mock("./file-utils-runtime.js", () => ({
  fetchRemoteMedia: (...args: unknown[]) => mediaRuntimeMocks.fetchRemoteMedia(...args),
}));

import { QQBOT_MEDIA_SSRF_POLICY, downloadFile } from "./file-utils.js";

describe("qqbot file-utils downloadFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    mediaRuntimeMocks.fetchRemoteMedia.mockReset();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "qqbot-file-utils-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("downloads through the guarded media runtime with the qqbot SSRF policy", async () => {
    mediaRuntimeMocks.fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/png",
      fileName: "remote.png",
    });

    const savedPath = await downloadFile(
      "https://media.qq.com/assets/photo.png",
      tempDir,
      "photo.png",
    );

    expect(savedPath).toBeTruthy();
    expect(savedPath).toMatch(/photo_\d+_[0-9a-f]{6}\.png$/);
    expect(await fs.promises.readFile(savedPath!, "utf8")).toBe("image-bytes");
    expect(mediaRuntimeMocks.fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://media.qq.com/assets/photo.png",
      filePathHint: "photo.png",
      ssrfPolicy: QQBOT_MEDIA_SSRF_POLICY,
    });
    expect(QQBOT_MEDIA_SSRF_POLICY).toEqual({
      hostnameAllowlist: [
        "*.qpic.cn",
        "*.qq.com",
        "*.weiyun.com",
        "*.qq.com.cn",
        "*.ugcimg.cn",
        "*.myqcloud.com",
        "*.tencentcos.cn",
        "*.tencentcos.com",
      ],
      allowRfc2544BenchmarkRange: true,
    });
  });

  it("rejects non-HTTPS URLs before attempting a fetch", async () => {
    const savedPath = await downloadFile("http://media.qq.com/assets/photo.png", tempDir);

    expect(savedPath).toBeNull();
    expect(mediaRuntimeMocks.fetchRemoteMedia).not.toHaveBeenCalled();
  });
});
