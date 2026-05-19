import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resizeToJpeg } from "./image-ops.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("image-ops temp dir", () => {
  let createdTempDir = "";

  beforeEach(() => {
    process.env.OPENCLAW_IMAGE_BACKEND = "sips";
    const originalMkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix) => {
      createdTempDir = await originalMkdtemp(prefix);
      return createdTempDir;
    });
  });

  afterEach(() => {
    delete process.env.OPENCLAW_IMAGE_BACKEND;
    vi.restoreAllMocks();
  });

  it.skipIf(process.platform !== "darwin")(
    "creates sips temp dirs under the secured OpenClaw tmp root",
    async () => {
      const secureRoot = await fs.realpath(resolvePreferredOpenClawTmpDir());

      await resizeToJpeg({
        buffer: Buffer.from(PNG_1X1_BASE64, "base64"),
        maxSide: 1,
        quality: 80,
      });

      expect(fs.mkdtemp).toHaveBeenCalledTimes(1);
      const [mkdtempCall] = vi.mocked(fs.mkdtemp).mock.calls;
      if (!mkdtempCall) {
        throw new Error("expected mkdtemp call");
      }
      const [prefix] = mkdtempCall;
      expect(typeof prefix).toBe("string");
      const uuidPrefix = path.join(secureRoot, "openclaw-img-");
      expect(prefix?.startsWith(uuidPrefix)).toBe(true);
      expect(prefix?.endsWith("-")).toBe(true);
      const uuid = prefix?.slice(uuidPrefix.length, -1) ?? "";
      expect(uuid).toHaveLength(36);
      expect(/^[0-9a-f-]+$/u.test(uuid)).toBe(true);
      expect([8, 13, 18, 23].map((index) => uuid[index])).toEqual(["-", "-", "-", "-"]);
      expect(path.dirname(prefix ?? "")).toBe(secureRoot);
      expect(createdTempDir.startsWith(prefix ?? "")).toBe(true);
      let accessError: unknown;
      try {
        await fs.access(createdTempDir);
      } catch (error) {
        accessError = error;
      }
      expect(accessError).toBeInstanceOf(Error);
      expect((accessError as NodeJS.ErrnoException).code).toBe("ENOENT");
    },
  );
});
