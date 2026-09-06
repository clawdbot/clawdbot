import { describe, expect, it, vi } from "vitest";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withAudioFixture } from "./runner.test-utils.js";
import { transcribeAudioFile } from "./runtime.js";

const cli = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", () => ({ runExec: cli }));

describe("audio processing disposition", () => {
  it.each([
    { name: "empty CLI", entries: ["cli"], text: "", handled: true },
    { name: "empty API", entries: ["api"], text: "", handled: true },
    { name: "omitted API then empty CLI", entries: ["omitted", "cli"], text: "", handled: true },
    { name: "empty CLI then omitted API", entries: ["cli", "omitted"], text: "", handled: true },
    {
      name: "omitted API then successful fallback",
      entries: ["omitted", "api"],
      text: "whole input",
      handled: true,
    },
    { name: "all input omitted", entries: ["omitted"], text: "", handled: false },
  ])("records completed processing for $name", async ({ name, entries, text, handled }) => {
    cli.mockReset().mockResolvedValue({ stdout: text, stderr: "" });
    const api = vi.fn(async () => ({ text }));
    const registry = createEmptyPluginRegistry();
    registry.mediaUnderstandingProviders.push({
      pluginId: "synthetic-audio",
      source: "test",
      provider: { id: "synthetic-audio", capabilities: ["audio"], transcribeAudio: api },
    });
    const models: MediaUnderstandingModelConfig[] = entries.map((entry) =>
      entry === "cli"
        ? { type: "cli", command: "synthetic-stt", capabilities: ["audio"] }
        : {
            provider: "synthetic-audio",
            model: "synthetic-stt",
            capabilities: ["audio"],
            ...(entry === "omitted" ? { maxBytes: 1_024 } : {}),
          },
    );
    await withAudioFixture(`disposition-${name.replaceAll(" ", "-")}`, async ({ mediaPath }) => {
      const result = await withPluginRuntimeRegistryScope(registry, () =>
        transcribeAudioFile({
          filePath: mediaPath,
          mime: "audio/wav",
          cfg: {
            models: {
              providers: {
                "synthetic-audio": {
                  baseUrl: "https://unused.invalid",
                  apiKey: "synthetic-fixture-key",
                  models: [],
                },
              },
            },
            tools: { media: { models } },
          },
        }),
      );
      expect(cli).toHaveBeenCalledTimes(entries.includes("cli") ? 1 : 0);
      expect(api).toHaveBeenCalledTimes(entries.includes("api") ? 1 : 0);
      expect(result.text).toBe(text || undefined);
      expect(result.decision?.outcome).toBe(text ? "success" : "skipped");
      expect(result.decision?.attachmentDispositions).toEqual({
        0: { kind: text ? "handled" : "failed" },
      });
      expect(result.decision?.attachmentProcessing).toEqual({
        0: handled ? "completed" : "omitted",
      });
    });
  });
});
