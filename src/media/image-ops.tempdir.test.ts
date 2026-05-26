import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer, createTinyJpegBuffer } from "../../test/helpers/image-fixtures.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

const fakeSips = vi.hoisted(() => ({
  logPath: "",
  path: "",
}));

vi.mock("../infra/resolve-system-bin.js", () => ({
  resolveSystemBin: (command: string) => (command === "sips" ? fakeSips.path : null),
}));

describe("image-ops temp dir", () => {
  let fakeRoot = "";

  beforeEach(async () => {
    vi.resetModules();
    process.env.OPENCLAW_IMAGE_BACKEND = "sips";
    fakeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fake-sips-"));
    fakeSips.path = path.join(fakeRoot, "sips.js");
    fakeSips.logPath = path.join(fakeRoot, "args.json");
    const outputJpeg = createTinyJpegBuffer().toString("base64");
    await fs.writeFile(
      fakeSips.path,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(fakeSips.logPath)}, JSON.stringify(args));`,
        "const outIndex = args.indexOf('--out');",
        "const output = outIndex >= 0 ? args[outIndex + 1] : args.at(-1);",
        `fs.writeFileSync(output, Buffer.from(${JSON.stringify(outputJpeg)}, 'base64'));`,
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(fakeSips.path, 0o755);
  });

  afterEach(async () => {
    delete process.env.OPENCLAW_IMAGE_BACKEND;
    fakeSips.logPath = "";
    fakeSips.path = "";
    await fs.rm(fakeRoot, { recursive: true, force: true });
    fakeRoot = "";
  });

  it.skipIf(process.platform !== "darwin")(
    "creates sips temp dirs under the secured OpenClaw tmp root",
    async () => {
      const { resizeToJpeg } = await import("./image-ops.js");
      const secureRoot = path.resolve(resolvePreferredOpenClawTmpDir());

      await resizeToJpeg({
        buffer: createSolidPngBuffer(2, 2, { r: 255, g: 255, b: 255 }),
        maxSide: 2,
        quality: 80,
      });

      const args = JSON.parse(await fs.readFile(fakeSips.logPath, "utf8")) as string[];
      const outIndex = args.indexOf("--out");
      if (outIndex < 1) {
        throw new Error("expected sips input before --out");
      }
      const inputPath = args[outIndex - 1] ?? "";
      const tempDir = path.dirname(inputPath);
      const relative = path.relative(secureRoot, tempDir);
      expect(relative.startsWith("openclaw-img-")).toBe(true);
      expect(relative.includes("..")).toBe(false);
      const match = /^openclaw-img-([0-9a-f-]{36})-[A-Za-z0-9]+$/u.exec(path.basename(tempDir));
      expect(match).not.toBeNull();
      const uuid = match?.[1] ?? "";
      expect([8, 13, 18, 23].map((index) => uuid[index])).toEqual(["-", "-", "-", "-"]);
      let accessError: unknown;
      try {
        await fs.access(tempDir);
      } catch (error) {
        accessError = error;
      }
      expect(accessError).toBeInstanceOf(Error);
      expect((accessError as NodeJS.ErrnoException).code).toBe("ENOENT");
    },
  );
});
