import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchJsonMock = vi.hoisted(() => vi.fn());
const patchConfigMock = vi.hoisted(() => vi.fn(async () => undefined));
const waitForGatewayHealthyMock = vi.hoisted(() => vi.fn(async () => undefined));
const waitForTransportReadyMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./suite-runtime-gateway.js", () => ({
  fetchJson: fetchJsonMock,
  patchConfig: patchConfigMock,
  waitForGatewayHealthy: waitForGatewayHealthyMock,
  waitForTransportReady: waitForTransportReadyMock,
}));

import {
  ensureImageGenerationConfigured,
  extractMediaPathFromText,
  resolveGeneratedImagePath,
} from "./suite-runtime-agent-media.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("qa suite runtime agent media helpers", () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    patchConfigMock.mockClear();
    waitForGatewayHealthyMock.mockClear();
    waitForTransportReadyMock.mockClear();
  });

  it("extracts media paths from tool output text", () => {
    expect(extractMediaPathFromText("done\nMEDIA:/tmp/image.png")).toBe("/tmp/image.png");
    expect(extractMediaPathFromText("done")).toBeUndefined();
  });

  it("resolves generated image paths from mock request logs first", async () => {
    fetchJsonMock.mockResolvedValue([
      {
        allInputText: "irrelevant",
        toolOutput: "MEDIA:/tmp/other.png",
      },
      {
        allInputText: "prompt snippet",
        toolOutput: "done\nMEDIA:/tmp/generated.png",
      },
    ]);

    await expect(
      resolveGeneratedImagePath({
        env: {
          mock: { baseUrl: "http://127.0.0.1:9999" },
          gateway: { tempRoot: "/tmp/runtime" },
        } as never,
        promptSnippet: "prompt snippet",
        startedAtMs: Date.now(),
        timeoutMs: 2_000,
      }),
    ).resolves.toBe("/tmp/generated.png");
  });

  it("falls back to generated image files under the gateway temp root", async () => {
    const tempRoot = await makeTempDir("qa-generated-image-");
    const mediaDir = path.join(tempRoot, "state", "media", "tool-image-generation");
    await fs.mkdir(mediaDir, { recursive: true });
    const mediaPath = path.join(mediaDir, "generated.png");
    await fs.writeFile(mediaPath, "png", "utf8");

    await expect(
      resolveGeneratedImagePath({
        env: {
          mock: null,
          gateway: { tempRoot },
        } as never,
        promptSnippet: "unused",
        startedAtMs: Date.now(),
        timeoutMs: 2_000,
      }),
    ).resolves.toBe(mediaPath);
  });

  it("applies mock image generation config with transport-required plugins", async () => {
    await ensureImageGenerationConfigured({
      providerMode: "mock-openai",
      mock: { baseUrl: "http://127.0.0.1:9999" },
      transport: { requiredPluginIds: ["qa-channel", "browser"] },
    } as never);

    expect(patchConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: expect.arrayContaining(["memory-core", "openai", "qa-channel", "browser"]),
          }),
        }),
      }),
    );
    expect(waitForGatewayHealthyMock).toHaveBeenCalled();
    expect(waitForTransportReadyMock).toHaveBeenCalledWith(expect.anything(), 60_000);
  });
});
