import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { MAX_TIMER_TIMEOUT_MS } from "../../shared/number-coercion.js";
import { resolveSandboxConfigForAgent } from "./config.js";

describe("sandbox config", () => {
  it("caps browser autostart timeout to a timer-safe delay", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            browser: {
              autoStartTimeoutMs: Number.MAX_SAFE_INTEGER,
            },
          },
        },
      },
    };

    expect(resolveSandboxConfigForAgent(cfg, "main").browser.autoStartTimeoutMs).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});
