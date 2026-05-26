import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";

const { infoMock, warnMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => {
  const makeLogger = () => ({
    subsystem: "agents/tool-images",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: infoMock,
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => makeLogger(),
  });
  return { createSubsystemLogger: () => makeLogger() };
});

import { sanitizeContentBlocksImages } from "./tool-images.js";

async function createLargePng(): Promise<Buffer> {
  return createSolidPngBuffer(2001, 8, { r: 0x7f, g: 0x7f, b: 0x7f });
}

describe("tool-images log context", () => {
  let png: Buffer;

  beforeAll(async () => {
    png = await createLargePng();
  });

  beforeEach(() => {
    infoMock.mockClear();
    warnMock.mockClear();
  });

  it("includes filename from MEDIA text", async () => {
    const blocks = [
      { type: "text" as const, text: "MEDIA:/tmp/snapshots/camera-front.png" },
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
    ];
    await sanitizeContentBlocksImages(blocks, "nodes:camera_snap");
    const messages = infoMock.mock.calls.map((call) => String(call[0] ?? ""));
    expect(messages.join("\n")).toContain("camera-front.png");
  });

  it("includes filename from read label", async () => {
    const blocks = [
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
    ];
    await sanitizeContentBlocksImages(blocks, "read:/tmp/images/sample-diagram.png");
    const messages = infoMock.mock.calls.map((call) => String(call[0] ?? ""));
    expect(messages.join("\n")).toContain("sample-diagram.png");
  });
});
