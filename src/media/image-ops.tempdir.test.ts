import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { getImageMetadata } from "./image-ops.js";

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

  it("creates sips temp dirs under the secured OpenClaw tmp root", async () => {
    const secureRoot = await fs.realpath(resolvePreferredOpenClawTmpDir());

    await getImageMetadata(Buffer.from("image"));

    expect(fs.mkdtemp).toHaveBeenCalledTimes(1);
    const [prefix] = vi.mocked(fs.mkdtemp).mock.calls[0] ?? [];
    expect(prefix).toEqual(expect.stringMatching(/^.+openclaw-img-[0-9a-f-]+-$/u));
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
  });
});
