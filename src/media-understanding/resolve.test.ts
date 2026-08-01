// Media-understanding resolve tests cover timeout clamping and capability filtering.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveMediaRuntimeTimeoutMs, resolveModelEntries, resolveTimeoutMs } from "./resolve.js";
import type { MediaUnderstandingCapability } from "./types.js";

const providerRegistry = new Map<string, { capabilities: MediaUnderstandingCapability[] }>([
  ["openai", { capabilities: ["image"] }],
  ["groq", { capabilities: ["audio"] }],
]);

describe("media timeout resolution", () => {
  it("caps configured media timeout seconds to timer-safe values", () => {
    expect(resolveTimeoutMs(Number.MAX_VALUE, 60)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveTimeoutMs(undefined, Number.MAX_VALUE)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("caps explicit runtime timeout milliseconds to timer-safe values", () => {
    expect(resolveMediaRuntimeTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveMediaRuntimeTimeoutMs(undefined)).toBe(30_000);
  });
});

describe("resolveModelEntries", () => {
  it("uses provider capabilities for shared entries without explicit caps", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          models: [{ provider: "openai", model: "gpt-5.4" }],
        },
      },
    };

    const imageEntries = resolveModelEntries({
      cfg,
      capability: "image",
      providerRegistry,
    });
    expect(imageEntries).toHaveLength(1);
    expect(imageEntries[0]).toMatchObject({
      entry: { provider: "openai", model: "gpt-5.4" },
      secretOwnerId: "media-model:shared:0",
    });

    const audioEntries = resolveModelEntries({
      cfg,
      capability: "audio",
      providerRegistry,
    });
    expect(audioEntries).toHaveLength(0);
  });

  it("orders capability-tagged shared entries by the per-capability preference", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          models: [
            { provider: "openai", model: "gpt-5.4-mini", capabilities: ["image"] },
            { provider: "openai", model: "gpt-5.4", capabilities: ["image"] },
          ],
          image: { preferredModel: "openai/gpt-5.4" },
        },
      },
    };

    const imageEntries = resolveModelEntries({
      cfg,
      capability: "image",
      config: cfg.tools?.media?.image,
      providerRegistry,
    });
    expect(imageEntries).toHaveLength(2);
    expect(imageEntries[0]).toMatchObject({
      entry: { model: "gpt-5.4" },
      secretOwnerId: "media-model:shared:1",
    });
  });

  it("ranks an exact provider-qualified preference above a matching bare model id", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          models: [
            { provider: "openrouter", model: "openai/gpt-5.4", capabilities: ["image"] },
            { provider: "openai", model: "gpt-5.4", capabilities: ["image"] },
          ],
          image: { preferredModel: "openai/gpt-5.4" },
        },
      },
    };

    const entries = resolveModelEntries({
      cfg,
      capability: "image",
      config: cfg.tools?.media?.image,
      providerRegistry,
    });
    expect(entries[0]?.entry).toMatchObject({ provider: "openai", model: "gpt-5.4" });
  });

  it("prefers a provider-default entry without requiring a model id", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          models: [
            { provider: "groq", model: "whisper-large-v3", capabilities: ["audio"] },
            { provider: "openai", capabilities: ["audio"] },
          ],
          audio: { preferredModel: "provider:openai" },
        },
      },
    };

    const entries = resolveModelEntries({
      cfg,
      capability: "audio",
      config: cfg.tools?.media?.audio,
      providerRegistry,
    });
    expect(entries[0]?.entry.provider).toBe("openai");
  });

  it("skips shared CLI entries without capabilities", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          models: [{ type: "cli", command: "gemini", args: ["--file", "{{MediaPath}}"] }],
        },
      },
    };

    const entries = resolveModelEntries({
      cfg,
      capability: "image",
      providerRegistry,
    });
    expect(entries).toHaveLength(0);
  });
});
