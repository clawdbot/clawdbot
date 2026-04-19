import { describe, expect, it } from "vitest";
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
});
