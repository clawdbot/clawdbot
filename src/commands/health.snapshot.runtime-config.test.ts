import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildRuntimeConfigHealth } from "./health-runtime-config.js";

function buildHealth(params: {
  liveSourceConfig: OpenClawConfig | null;
  observedSourceConfig: OpenClawConfig | null;
  hasLiveSnapshot?: boolean;
}) {
  return buildRuntimeConfigHealth({
    liveSourceConfig: params.liveSourceConfig,
    hasLiveSnapshot: params.hasLiveSnapshot ?? true,
    observedSourceConfig: params.observedSourceConfig,
  });
}

describe("buildRuntimeConfigHealth drift", () => {
  it("surfaces model/provider runtime config drift from the observed source", () => {
    const runtimeConfig = buildHealth({
      liveSourceConfig: {
        session: { store: "/tmp/x" },
        agents: { defaults: { model: "openai/gpt-5.6-sol" } },
      },
      observedSourceConfig: {
        session: { store: "/tmp/x" },
        agents: { defaults: { model: "openai/gpt-5.6-terra" } },
      },
    });

    expect(runtimeConfig).toEqual({
      state: "drift",
      liveDefaultModel: "openai/gpt-5.6-sol",
      observedDefaultModel: "openai/gpt-5.6-terra",
      driftPaths: ["agents.defaults.model"],
      message:
        "Live gateway runtime config differs from the latest completed reload observation for model/provider/auth paths; restart is required or pending.",
    });
  });

  it("detects drift on top-level auth.profiles when provider auth rotates", () => {
    const runtimeConfig = buildHealth({
      liveSourceConfig: {
        auth: { profiles: { primary: { provider: "openai", mode: "token" } } },
      },
      observedSourceConfig: {
        auth: { profiles: { primary: { provider: "openai", mode: "oauth" } } },
      },
    });

    expect(runtimeConfig?.state).toBe("drift");
    expect(runtimeConfig?.driftPaths).toEqual(["auth.profiles"]);
  });

  it("detects per-agent model drift in canonical agent entries", () => {
    const runtimeConfig = buildHealth({
      liveSourceConfig: {
        agents: { entries: { main: { model: "openai/gpt-5.6-sol" } } },
      },
      observedSourceConfig: {
        agents: { entries: { main: { model: "openai/gpt-5.6-terra" } } },
      },
    });

    expect(runtimeConfig?.state).toBe("drift");
    expect(runtimeConfig?.driftPaths).toEqual(["agents.entries"]);
  });

  it("reports a redacted unknown state for a missing or invalid observation", () => {
    const runtimeConfig = buildHealth({
      liveSourceConfig: {
        agents: { defaults: { model: "openai/gpt-5.6-sol" } },
      },
      observedSourceConfig: null,
    });

    expect(runtimeConfig).toEqual({
      state: "unknown",
      liveDefaultModel: "openai/gpt-5.6-sol",
      message: "Latest completed reload source observation is unavailable.",
    });
    expect(JSON.stringify(runtimeConfig)).not.toContain("/tmp/openclaw.json");
  });

  it("distinguishes an unpublished live source from a non-Gateway caller", () => {
    expect(
      buildHealth({
        liveSourceConfig: null,
        observedSourceConfig: {},
        hasLiveSnapshot: true,
      }),
    ).toEqual({
      state: "unknown",
      message: "Runtime source config snapshot is unavailable.",
    });
    expect(
      buildHealth({
        liveSourceConfig: null,
        observedSourceConfig: {},
        hasLiveSnapshot: false,
      }),
    ).toBeUndefined();
  });
});
