import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createImageTool } from "./image-tool.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_OLLAMA_IMAGE === "1";
const OLLAMA_BASE_URL =
  process.env.OPENCLAW_LIVE_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
const OLLAMA_IMAGE_MODEL = process.env.OPENCLAW_LIVE_OLLAMA_IMAGE_MODEL?.trim() || "qwen2.5vl:7b";

function resolveLiveNumCtx(): number {
  const parsed = Number.parseInt(process.env.OPENCLAW_LIVE_OLLAMA_IMAGE_NUM_CTX ?? "2048", 10);
  return Number.isFinite(parsed) ? Math.max(512, parsed) : 2048;
}

const OLLAMA_IMAGE_NUM_CTX = resolveLiveNumCtx();

const VALID_RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBBsGAQr00ED3AAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA0LTI3VDA2OjAxOjEwKzAwOjAwPU3tXwAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wNC0yN1QwNjowMToxMCswMDowMEwQVeMAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDQtMjdUMDY6MDE6MTArMDA6MDAbBXQ8AAAAeElEQVRo3u3awQnDQBAEwT2Q8w/YAikIP5rF1RFMca+FO8/s7rrnqjcA1BsA6g0A9QaAesOfA77zqTf8Blj/AgAAAAAAAJsDqAOoA6gDqAOoc9TXAdQB1AHUAdQB1AHUAdQB1AHU7Qc46gEAAAAANrcecGZ2f8B/ASYSQPlKoEJ/AAAAAElFTkSuQmCC";

async function withLiveImageWorkspace<T>(
  run: (ctx: { agentDir: string; workspaceDir: string; imagePath: string }) => Promise<T>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ollama-image-live-"));
  try {
    const agentDir = path.join(root, "agent");
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    const imagePath = path.join(workspaceDir, "red.png");
    await fs.writeFile(imagePath, Buffer.from(VALID_RED_PNG_B64, "base64"));
    return await run({ agentDir, workspaceDir, imagePath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(!LIVE)("image tool Ollama live", () => {
  it("describes a local image through a providerless configured Ollama image model", async () => {
    process.env.OLLAMA_API_KEY ||= "ollama-local";
    await withLiveImageWorkspace(async ({ agentDir, workspaceDir, imagePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            imageModel: { primary: OLLAMA_IMAGE_MODEL },
          },
        },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: OLLAMA_BASE_URL,
              apiKey: "ollama-local",
              timeoutSeconds: 300,
              models: [
                {
                  id: OLLAMA_IMAGE_MODEL,
                  name: OLLAMA_IMAGE_MODEL,
                  input: ["text", "image"],
                  reasoning: false,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 512,
                  params: { num_ctx: OLLAMA_IMAGE_NUM_CTX, keep_alive: "1m" },
                },
              ],
            },
          },
        },
        tools: {
          media: {
            image: {
              timeoutSeconds: 180,
              models: [{ provider: "ollama", model: OLLAMA_IMAGE_MODEL, timeoutSeconds: 300 }],
            },
          },
        },
      };
      const tool = createImageTool({ config: cfg, agentDir, workspaceDir });
      expect(typeof tool?.execute).toBe("function");
      if (!tool) {
        throw new Error("expected image tool");
      }

      const result = await tool.execute("live-ollama-image", {
        prompt: "Describe this image in one short sentence.",
        image: imagePath,
      });

      const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
      expect(Array.isArray(content)).toBe(true);
      expect(content?.[0]?.type).toBe("text");
      const text = content?.[0]?.text?.trim();
      expect(text?.length ?? 0).toBeGreaterThan(0);
    });
  }, 180_000);
});
