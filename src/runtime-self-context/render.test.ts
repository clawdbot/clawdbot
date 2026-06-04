import { describe, expect, it } from "vitest";
import { extractInternalRuntimeContext } from "../agents/internal-runtime-context.js";
import { appendRuntimeSelfContextToPrompt, buildRuntimeSelfContextPrompt } from "./render.js";
import type { RuntimeContextConfig } from "./types.js";

function createRuntimeContext(mode: "none" | "tool_hint" | "prompt_summary"): RuntimeContextConfig {
  return {
    source: "static",
    expose: { mode },
    value: {
      id: "openclaw-dev",
      current: {
        id: "openclaw-dev",
        label: "OpenClaw Dev",
        locality: "local",
      },
      resources: {
        cpu: {
          effectiveCores: 8,
          model: "Apple M3 Max",
        },
        memory: {
          effectiveBytes: 34_359_738_368,
        },
      },
      actions: [
        {
          kind: "scale_up",
          label: "Resize this runtime",
          ref: "runtime-action://gateway/current/scale-up",
          requiresApproval: true,
        },
      ],
      offload: {
        targets: [
          {
            id: "gateway-large",
            locality: "cloud",
            workloadKinds: ["codex", "long_task"],
            cost: { model: "metered", currency: "USD" },
          },
        ],
      },
      freshness: {
        validUntil: "2026-06-03T19:00:00-07:00",
      },
    },
  };
}

describe("runtime self context prompt rendering", () => {
  it("renders no prompt for exposure mode none", () => {
    expect(buildRuntimeSelfContextPrompt(createRuntimeContext("none"))).toBe("");
    expect(
      appendRuntimeSelfContextToPrompt({
        prompt: "visible request",
        config: { runtimeContext: createRuntimeContext("none") },
      }),
    ).toBe("visible request");
  });

  it("renders only a tool hint for exposure mode tool_hint", () => {
    const prompt = buildRuntimeSelfContextPrompt(createRuntimeContext("tool_hint"));
    expect(prompt).toContain("Runtime details are available through the runtime tool");
    expect(prompt).not.toContain("Runtime summary:");
  });

  it("wraps prompt_summary as hidden internal runtime context", () => {
    const merged = appendRuntimeSelfContextToPrompt({
      prompt: "visible request",
      config: { runtimeContext: createRuntimeContext("prompt_summary") },
    });
    const extracted = extractInternalRuntimeContext(merged);
    expect(extracted.text).toBe("visible request");
    expect(extracted.runtimeContext).toContain("Runtime summary:");
    expect(extracted.runtimeContext).toContain("OpenClaw Dev, local");
    expect(extracted.runtimeContext).toContain("1 target available");
    expect(extracted.runtimeContext).toContain("valid until: 2026-06-03T19:00:00-07:00");
  });
});
