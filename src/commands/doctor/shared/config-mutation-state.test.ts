// Config mutation state tests cover doctor mutation tracking and final state reporting.
import { describe, expect, it } from "vitest";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "../../../config/legacy.default-agent-owner.js";
import { applyDoctorConfigMutation } from "./config-mutation-state.js";
import type { DoctorConfigMutationState } from "./config-mutation-state.js";

const DOCTOR_FIX_HINT = 'Run "openclaw doctor --fix" to apply these changes.';

function emptyMutationState(): DoctorConfigMutationState {
  return {
    cfg: { channels: {} },
    candidate: { channels: {} },
    pendingChanges: false,
    fixHints: [],
  };
}

function enabledSignalMutation() {
  return {
    config: { channels: { signal: { enabled: true } } },
    changes: ["enabled signal"],
  };
}

describe("doctor config mutation state", () => {
  it("updates candidate and fix hints in preview mode", () => {
    const next = applyDoctorConfigMutation({
      state: emptyMutationState(),
      mutation: enabledSignalMutation(),
      shouldRepair: false,
      fixHint: DOCTOR_FIX_HINT,
    });

    expect(next).toEqual({
      cfg: { channels: {} },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
    });
  });

  it("updates cfg directly in repair mode", () => {
    const next = applyDoctorConfigMutation({
      state: emptyMutationState(),
      mutation: enabledSignalMutation(),
      shouldRepair: true,
      fixHint: DOCTOR_FIX_HINT,
    });

    expect(next).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      fixHints: [],
    });
  });

  it("stays unchanged when there are no changes", () => {
    const state = emptyMutationState();

    expect(
      applyDoctorConfigMutation({
        state,
        mutation: { ...enabledSignalMutation(), changes: [] },
        shouldRepair: false,
      }),
    ).toBe(state);
  });

  it("carries the upgrade-only owner across repair mutations", () => {
    const state = emptyMutationState();
    retainLegacyDefaultAgentId(state.candidate, "ops");

    const next = applyDoctorConfigMutation({
      state,
      mutation: enabledSignalMutation(),
      shouldRepair: true,
    });

    expect(tryGetLegacyDefaultAgentId(next.candidate)).toBe("ops");
    expect(tryGetLegacyDefaultAgentId(next.cfg)).toBe("ops");
  });
});
