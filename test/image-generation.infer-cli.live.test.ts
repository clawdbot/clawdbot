import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import { isTruthyEnvValue } from "../src/infra/env.js";

const GOOGLE_IMAGE_KEY =
  process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";
const LIVE =
  isLiveTestEnabled() &&
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_INFER_CLI_TEST) &&
  GOOGLE_IMAGE_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function parseJsonEnvelope(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const jsonStart = trimmed.lastIndexOf("\n{");
  const rawJson = jsonStart >= 0 ? trimmed.slice(jsonStart + 1) : trimmed;
  return JSON.parse(rawJson) as Record<string, unknown>;
}

describeLive("image generation infer CLI live", () => {
  it("generates an image through openclaw infer", () => {
    const outputBase = path.join(os.tmpdir(), `openclaw-infer-image-${process.pid}.png`);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-node.mjs",
        "infer",
        "image",
        "generate",
        "--model",
        "google/gemini-3.1-flash-image-preview",
        "--prompt",
        "Minimal flat test image: one blue square on a white background, no text.",
        "--output",
        outputBase,
        "--json",
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        env: process.env,
        timeout: 180_000,
      },
    );

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const payload = parseJsonEnvelope(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.capability).toBe("image.generate");
    expect(payload.provider).toBe("google");
    expect(payload.model).toBe("gemini-3.1-flash-image-preview");
    const outputs = payload.outputs as Array<{ path?: string; mimeType?: string; size?: number }>;
    expect(outputs).toHaveLength(1);
    const outputPath = outputs[0]?.path;
    expect(outputPath).toBeTruthy();
    expect(fs.existsSync(outputPath ?? "")).toBe(true);
    expect(outputs[0]?.mimeType?.startsWith("image/")).toBe(true);
    expect(outputs[0]?.size ?? 0).toBeGreaterThan(512);
  }, 240_000);
});
