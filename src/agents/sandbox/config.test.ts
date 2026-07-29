// Sandbox config tests cover resolved agent sandbox settings after config
// normalization and timer-safe clamping.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSandboxConfigForAgent } from "./config.js";

describe("sandbox config", () => {
  it("caps browser autostart timeout to a timer-safe delay", () => {
    // Browser startup timeouts flow into Node timers; huge config values must
    // not overflow or become immediate delays.
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
