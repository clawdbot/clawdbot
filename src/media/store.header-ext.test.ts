import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const realOs = await vi.importActual<typeof import("node:os")>("node:os");
const HOME = path.join(realOs.tmpdir(), "moltbot-home-header-ext-test");

vi.mock("node:os", () => ({
  default: { homedir: () => HOME, tmpdir: () => realOs.tmpdir() },
  homedir: () => HOME,
  tmpdir: () => realOs.tmpdir(),
}));

vi.mock("./mime.js", async () => {
  const actual = await vi.importActual<typeof import("./mime.js")>("./mime.js");
  return {
    ...actual,
    detectMime: vi.fn(async () => "audio/opus"),
  };
});

const store = await import("./store.js");

describe("media store header extensions", () => {
  beforeAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
  });

  it("prefers header mime extension when sniffed mime lacks mapping", async () => {
    const buf = Buffer.from("fake-audio");
    const saved = await store.saveMediaBuffer(buf, "audio/ogg; codecs=opus");
    expect(path.extname(saved.path)).toBe(".ogg");
  });
});
