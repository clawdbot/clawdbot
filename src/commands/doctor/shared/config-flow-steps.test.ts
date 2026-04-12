import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { DoctorConfigPreflightResult } from "../../doctor-config-preflight.js";
import { applyLegacyCompatibilityStep, applyUnknownConfigKeyStep } from "./config-flow-steps.js";

function createLegacyStepResult(
  snapshot: DoctorConfigPreflightResult["snapshot"],
  doctorFixCommand = "openclaw doctor --fix",
) {
  return applyLegacyCompatibilityStep({
    snapshot,
    state: {
      cfg: {},
      candidate: {},
      pendingChanges: false,
      fixHints: [],
    },
    shouldRepair: false,
    doctorFixCommand,
  });
}

describe("doctor config flow steps", () => {
  it("collects legacy compatibility issue lines and preview fix hints", () => {
    const result = createLegacyStepResult({
      exists: true,
      parsed: { heartbeat: { enabled: true } },
      legacyIssues: [{ path: "heartbeat", message: "use agents.defaults.heartbeat" }],
      path: "/tmp/config.json",
      valid: true,
      issues: [],
      raw: "{}",
      resolved: {},
      sourceConfig: {},
      config: {},
      runtimeConfig: {},
      warnings: [],
    } satisfies DoctorConfigPreflightResult["snapshot"]);

    expect(result.issueLines).toEqual([expect.stringContaining("- heartbeat:")]);
    expect(result.changeLines).not.toEqual([]);
    expect(result.state.fixHints).toContain(
      'Run "openclaw doctor --fix" to migrate legacy config keys.',
    );
    expect(result.state.pendingChanges).toBe(true);
  });

  it("keeps pending repair state for legacy issues even when the snapshot is already normalized", () => {
    const result = createLegacyStepResult({
      exists: true,
      parsed: { talk: { voiceId: "voice-1", modelId: "eleven_v3" } },
      legacyIssues: [
        {
          path: "talk",
          message: "talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey",
        },
      ],
      path: "/tmp/config.json",
      valid: true,
      issues: [],
      raw: "{}",
      resolved: {},
      sourceConfig: {},
      config: {},
      runtimeConfig: {},
      warnings: [],
    } satisfies DoctorConfigPreflightResult["snapshot"]);

    expect(result.changeLines).toEqual([]);
    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.fixHints).toContain(
      'Run "openclaw doctor --fix" to migrate legacy config keys.',
    );
  });

  it("removes unknown keys and adds preview hint", () => {
    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: {},
        candidate: { bogus: true } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: false,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.removed).toEqual(["bogus"]);
    expect(result.state.candidate).toEqual({});
    expect(result.state.fixHints).toContain('Run "openclaw doctor --fix" to remove these keys.');
  });
});
