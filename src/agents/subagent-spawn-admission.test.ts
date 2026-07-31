import { afterEach, describe, expect, it } from "vitest";
import {
  countPendingSubagentSpawnAdmissionSlots,
  reserveSubagentSpawnAdmissionSlot,
  resetSubagentSpawnAdmissionForTests,
} from "./subagent-spawn-admission.js";

describe("shared subagent spawn admission slots", () => {
  afterEach(() => {
    resetSubagentSpawnAdmissionForTests();
  });

  it("accounts reserved and ordinary contenders under the same requester key", () => {
    const reserved = reserveSubagentSpawnAdmissionSlot({
      requesterSessionKey: "agent:main:main",
      runId: "reserved-run",
      childSessionKey: "agent:worker:subagent:reserved-child",
    });
    const ordinary = reserveSubagentSpawnAdmissionSlot({
      requesterSessionKey: "agent:main:main",
      runId: "ordinary-run",
    });

    expect(countPendingSubagentSpawnAdmissionSlots("agent:main:main")).toBe(2);
    expect(countPendingSubagentSpawnAdmissionSlots("agent:main:main", { exclude: reserved })).toBe(
      1,
    );
    ordinary.release();
    expect(countPendingSubagentSpawnAdmissionSlots("agent:main:main")).toBe(1);
  });

  it("tracks at least three contenders and releases deterministically", () => {
    const slots = ["one", "two", "three"].map((runId) =>
      reserveSubagentSpawnAdmissionSlot({
        requesterSessionKey: "agent:main:main",
        runId,
      }),
    );

    expect(countPendingSubagentSpawnAdmissionSlots("agent:main:main")).toBe(3);
    slots[1]?.release();
    slots[1]?.release();
    expect(countPendingSubagentSpawnAdmissionSlots("agent:main:main")).toBe(2);
    slots[0]?.release();
    slots[2]?.release();
    expect(countPendingSubagentSpawnAdmissionSlots("agent:main:main")).toBe(0);
  });

  it("keeps requester capacity isolated", () => {
    const first = reserveSubagentSpawnAdmissionSlot({
      requesterSessionKey: "agent:main:first",
      runId: "first-run",
    });
    const second = reserveSubagentSpawnAdmissionSlot({
      requesterSessionKey: "agent:main:second",
      runId: "second-run",
    });

    expect(countPendingSubagentSpawnAdmissionSlots("agent:main:first")).toBe(1);
    expect(countPendingSubagentSpawnAdmissionSlots("agent:main:second")).toBe(1);
    first.release();
    expect(countPendingSubagentSpawnAdmissionSlots("agent:main:first")).toBe(0);
    expect(countPendingSubagentSpawnAdmissionSlots("agent:main:second")).toBe(1);
    second.release();
  });
});
