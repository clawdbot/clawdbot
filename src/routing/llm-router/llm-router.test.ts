import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelRef } from "../../agents/model-selection.js";
import { loadRouterConfig, resolveRouteDecision } from "./index.js";

async function withTempDir<T>(runner: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-router-"));
  try {
    return await runner(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const defaultModelRef: ModelRef = { provider: "anthropic", model: "default" };

describe("llm-router", () => {
  it("returns default when config dir is missing or empty", async () => {
    const missingDir = path.join(os.tmpdir(), `moltbot-router-missing-${Date.now()}`);
    const missingCfg = await loadRouterConfig(missingDir);
    expect(missingCfg).toBeNull();

    const decision = resolveRouteDecision({
      cfg: missingCfg,
      intent: "chat",
      defaultModelRef,
    });
    expect(decision).toEqual({
      intent: "chat",
      provider: "anthropic",
      model: "default",
      reason: "default",
      isDefault: true,
    });

    await withTempDir(async (dir) => {
      const emptyCfg = await loadRouterConfig(dir);
      expect(emptyCfg).toBeNull();
    });
  });

  it("resolves routing.yaml intents", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "routing.yaml"),
        [
          "intents:",
          "  chat:",
          "    primary: anthropic/haiku",
          "    fallbacks:",
          "      - anthropic/sonnet",
          "  strategy:",
          "    primary: anthropic/sonnet",
          "    fallbacks:",
          "      - anthropic/haiku",
          "  code:",
          "    primary: openai-codex/codex",
          "  summarize:",
          "    primary: anthropic/haiku",
          "  continuity:",
          "    primary: local/local_small",
          "",
        ].join("\n"),
        "utf-8",
      );

      const cfg = await loadRouterConfig(dir);
      expect(cfg).not.toBeNull();

      expect(resolveRouteDecision({ cfg, intent: "chat", defaultModelRef }).fallbacks).toEqual([
        { provider: "anthropic", model: "sonnet" },
      ]);
      expect(resolveRouteDecision({ cfg, intent: "chat", defaultModelRef }).provider).toBe(
        "anthropic",
      );
      expect(resolveRouteDecision({ cfg, intent: "chat", defaultModelRef }).model).toBe("haiku");

      const strategy = resolveRouteDecision({ cfg, intent: "strategy", defaultModelRef });
      expect(strategy.provider).toBe("anthropic");
      expect(strategy.model).toBe("sonnet");

      const code = resolveRouteDecision({ cfg, intent: "code", defaultModelRef });
      expect(code.provider).toBe("openai-codex");
      expect(code.model).toBe("codex");

      const summarize = resolveRouteDecision({ cfg, intent: "summarize", defaultModelRef });
      expect(summarize.provider).toBe("anthropic");
      expect(summarize.model).toBe("haiku");

      const continuity = resolveRouteDecision({ cfg, intent: "continuity", defaultModelRef });
      expect(continuity.provider).toBe("local");
      expect(continuity.model).toBe("local_small");
    });
  });

  it("escalates chat/strategy to opus based on complexity policy", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "routing.yaml"),
        [
          "intents:",
          "  chat:",
          "    primary: anthropic/haiku",
          "  strategy:",
          "    primary: anthropic/sonnet",
          "",
        ].join("\n"),
        "utf-8",
      );
      await fs.writeFile(
        path.join(dir, "policy.yaml"),
        ["complexity:", "  context_tokens_ge: 2000", "  target: anthropic/opus", ""].join("\n"),
        "utf-8",
      );

      const cfg = await loadRouterConfig(dir);
      const chat = resolveRouteDecision({
        cfg,
        intent: "chat",
        defaultModelRef,
        contextTokens: 2000,
      });
      const strategy = resolveRouteDecision({
        cfg,
        intent: "strategy",
        defaultModelRef,
        contextTokens: 2500,
      });

      expect(chat.provider).toBe("anthropic");
      expect(chat.model).toBe("opus");
      expect(chat.reason).toBe("complexity");

      expect(strategy.provider).toBe("anthropic");
      expect(strategy.model).toBe("opus");
      expect(strategy.reason).toBe("complexity");
    });
  });
});
