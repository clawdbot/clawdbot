// Launchd current service tests cover resolving active macOS service labels.
import { describe, expect, it } from "vitest";
import { isCurrentProcessLaunchdServiceLabel } from "./launchd-current-service.js";

describe("isCurrentProcessLaunchdServiceLabel", () => {
  it("matches launchd-provided service labels", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.openclaw.gateway", {
        LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
      }),
    ).toBe(true);
  });

  it("falls back to OpenClaw service markers when XPC_SERVICE_NAME is inherited", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.openclaw.gateway", {
        XPC_SERVICE_NAME: "0",
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
      }),
    ).toBe(true);
  });

  it("preserves label-only fallback when launchd exposes no label variables", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.openclaw.gateway", {
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
      }),
    ).toBe(true);
  });

  it("can require service markers for label-only fallback", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel(
        "ai.openclaw.gateway",
        {
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
        },
        { allowConfiguredLabelFallback: false },
      ),
    ).toBe(false);
  });

  it("does not treat unrelated inherited launchd labels as current services", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.openclaw.gateway", {
        XPC_SERVICE_NAME: "0",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
      }),
    ).toBe(false);
  });
});
