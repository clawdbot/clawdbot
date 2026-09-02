import { describe, expect, it } from "vitest";
import type { GatewayBootLifecycleSegment } from "../../../infra/gateway-boot-lifecycle.js";
import {
  countRecordedSubagentAssistantMessages,
  formatSubagentOrphanErrorMessage,
  isAbruptGatewayBootEnd,
  resolveSubagentOrphanAttribution,
  resolveSubagentRunLastActivityMs,
} from "./subagent-orphan-attribution.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const KERNEL_BOOT_A = "kernel:11111111-1111-4111-8111-111111111111";
const KERNEL_BOOT_B = "kernel:22222222-2222-4222-8222-222222222222";

function bootSegment(overrides: Partial<GatewayBootLifecycleSegment>): GatewayBootLifecycleSegment {
  return {
    bootId: "boot",
    pid: 1234,
    startedAtMs: 0,
    completedAtMs: null,
    outcome: null,
    hostBootId: KERNEL_BOOT_A,
    ...overrides,
  };
}

/**
 * The real incident, in UTC:
 *   22:49:16  run starts under boot -5
 *   22:54:52  WSL2 VM dies; the run stops executing here
 *   23:28:30  boot -4 starts, 33m38s later
 *   23:29:51  the sweeper finally reaps the run
 * Apparent lifetime from the reap is 40m35s. Actual lifetime is 5m36s.
 */
const RUN_STARTED_AT = Date.parse("2026-08-26T22:49:16.000Z");
const RUN_DIED_AT = Date.parse("2026-08-26T22:54:52.000Z");
const GATEWAY_RESTARTED_AT = Date.parse("2026-08-26T23:28:30.000Z");
const RUN_REAPED_AT = Date.parse("2026-08-26T23:29:51.000Z");

describe("isAbruptGatewayBootEnd", () => {
  it("treats a boot with neither completion time nor outcome as abrupt", () => {
    expect(isAbruptGatewayBootEnd(bootSegment({}))).toBe(true);
  });

  it("treats any recorded stop as deliberate", () => {
    expect(isAbruptGatewayBootEnd(bootSegment({ completedAtMs: 10, outcome: "clean_stop" }))).toBe(
      false,
    );
    expect(isAbruptGatewayBootEnd(bootSegment({ completedAtMs: 10, outcome: null }))).toBe(false);
    expect(
      isAbruptGatewayBootEnd(bootSegment({ completedAtMs: null, outcome: "forced_stop" })),
    ).toBe(false);
  });
});

describe("resolveSubagentOrphanAttribution", () => {
  it("does not attribute anything to a boot that stopped cleanly", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      lastActivityAtMs: RUN_DIED_AT,
      boots: [
        bootSegment({
          bootId: "boot-clean",
          startedAtMs: RUN_STARTED_AT - 60_000,
          completedAtMs: RUN_DIED_AT,
          outcome: "clean_stop",
        }),
        bootSegment({ bootId: "boot-next", startedAtMs: GATEWAY_RESTARTED_AT }),
      ],
    });
    expect(attribution).toBeNull();
  });

  it("attributes a run whose owning boot ended abruptly", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      lastActivityAtMs: RUN_DIED_AT,
      assistantMessageCount: 0,
      boots: [
        bootSegment({ bootId: "boot-minus-5", startedAtMs: RUN_STARTED_AT - 60_000 }),
        bootSegment({ bootId: "boot-minus-4", startedAtMs: GATEWAY_RESTARTED_AT }),
      ],
    });
    expect(attribution).not.toBeNull();
    expect(attribution?.priorBootId).toBe("boot-minus-5");
    expect(attribution?.restartedAtMs).toBe(GATEWAY_RESTARTED_AT);
    expect(attribution?.assistantMessageCount).toBe(0);
  });

  it("measures elapsed lifetime from the death, not from the reap", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      lastActivityAtMs: RUN_DIED_AT,
      boots: [
        bootSegment({ bootId: "boot-minus-5", startedAtMs: RUN_STARTED_AT - 60_000 }),
        bootSegment({ bootId: "boot-minus-4", startedAtMs: GATEWAY_RESTARTED_AT }),
      ],
    });
    // 5m36s of real execution, not the 40m35s the reap clock suggests.
    expect(attribution?.elapsedMs).toBe(RUN_DIED_AT - RUN_STARTED_AT);
    expect(attribution?.elapsedMs).toBe(336_000);
    expect(attribution?.elapsedMs).not.toBe(RUN_REAPED_AT - RUN_STARTED_AT);
    expect(attribution?.diedAtEvidence).toBe("last_activity");
    expect(attribution?.elapsedBound).toBe("at_least");
    // The 33m38s outage is reported as downtime rather than as run lifetime.
    expect(attribution?.downtimeMs).toBe(GATEWAY_RESTARTED_AT - RUN_DIED_AT);
  });

  it("falls back to the successor boot start as an upper bound when activity is unknown", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      boots: [
        bootSegment({ bootId: "boot-minus-5", startedAtMs: RUN_STARTED_AT - 60_000 }),
        bootSegment({ bootId: "boot-minus-4", startedAtMs: GATEWAY_RESTARTED_AT }),
      ],
    });
    expect(attribution?.diedAtEvidence).toBe("successor_boot_start");
    expect(attribution?.elapsedBound).toBe("at_most");
    expect(attribution?.elapsedMs).toBe(GATEWAY_RESTARTED_AT - RUN_STARTED_AT);
    // Still strictly better than the reap: it never counts time after the restart.
    expect(attribution?.elapsedMs).toBeLessThan(RUN_REAPED_AT - RUN_STARTED_AT);
  });

  it("does not accept the run's own start time as activity evidence", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      lastActivityAtMs: RUN_STARTED_AT,
      boots: [
        bootSegment({ bootId: "boot-minus-5", startedAtMs: RUN_STARTED_AT - 60_000 }),
        bootSegment({ bootId: "boot-minus-4", startedAtMs: GATEWAY_RESTARTED_AT }),
      ],
    });
    // Reporting a 0s lifetime would be a stronger claim than the evidence.
    expect(attribution?.elapsedMs).not.toBe(0);
    expect(attribution?.diedAtEvidence).toBe("successor_boot_start");
  });

  it("rejects attribution when run activity postdates the successor boot", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      // A reap-time reading leaking in must not be accepted as a death time.
      lastActivityAtMs: RUN_REAPED_AT,
      boots: [
        bootSegment({ bootId: "boot-minus-5", startedAtMs: RUN_STARTED_AT - 60_000 }),
        bootSegment({ bootId: "boot-minus-4", startedAtMs: GATEWAY_RESTARTED_AT }),
      ],
    });
    expect(attribution).toBeNull();
  });

  it("calls a changed host boot id a host reboot", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      boots: [
        bootSegment({
          bootId: "boot-minus-5",
          startedAtMs: RUN_STARTED_AT - 60_000,
          hostBootId: KERNEL_BOOT_A,
        }),
        bootSegment({
          bootId: "boot-minus-4",
          startedAtMs: GATEWAY_RESTARTED_AT,
          hostBootId: KERNEL_BOOT_B,
        }),
      ],
    });
    expect(attribution?.cause).toBe("host_reboot");
    expect(attribution?.hostContinuityInferred).toBe(false);
  });

  it("calls an unchanged host boot id a gateway process death", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      boots: [
        bootSegment({
          bootId: "boot-minus-5",
          startedAtMs: RUN_STARTED_AT - 60_000,
          hostBootId: KERNEL_BOOT_A,
        }),
        bootSegment({
          bootId: "boot-minus-4",
          startedAtMs: GATEWAY_RESTARTED_AT,
          hostBootId: KERNEL_BOOT_A,
        }),
      ],
    });
    expect(attribution?.cause).toBe("gateway_process_death");
    expect(attribution?.hostContinuityInferred).toBe(false);
  });

  it("marks an uptime-derived verdict as inferred", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      boots: [
        bootSegment({
          bootId: "boot-minus-5",
          startedAtMs: RUN_STARTED_AT - 60_000,
          hostBootId: "uptime:5000",
        }),
        bootSegment({
          bootId: "boot-minus-4",
          startedAtMs: GATEWAY_RESTARTED_AT,
          hostBootId: "uptime:5001",
        }),
      ],
    });
    expect(attribution?.cause).toBe("host_reboot");
    expect(attribution?.hostContinuityInferred).toBe(true);
  });

  it("makes no host-continuity claim when a boot row predates the column", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      boots: [
        bootSegment({
          bootId: "boot-minus-5",
          startedAtMs: RUN_STARTED_AT - 60_000,
          hostBootId: null,
        }),
        bootSegment({ bootId: "boot-minus-4", startedAtMs: GATEWAY_RESTARTED_AT }),
      ],
    });
    expect(attribution?.cause).toBe("gateway_restart");
  });

  it("does not attribute a run owned by the live boot", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      currentBootId: "boot-live",
      boots: [
        bootSegment({ bootId: "boot-live", startedAtMs: RUN_STARTED_AT - 60_000 }),
        bootSegment({ bootId: "boot-later", startedAtMs: GATEWAY_RESTARTED_AT }),
      ],
    });
    expect(attribution).toBeNull();
  });

  it("makes no claim without a successor boot or without any owning boot", () => {
    expect(
      resolveSubagentOrphanAttribution({
        runStartedAtMs: RUN_STARTED_AT,
        boots: [bootSegment({ bootId: "boot-only", startedAtMs: RUN_STARTED_AT - 60_000 })],
      }),
    ).toBeNull();
    expect(
      resolveSubagentOrphanAttribution({
        runStartedAtMs: RUN_STARTED_AT,
        boots: [bootSegment({ bootId: "boot-later", startedAtMs: RUN_STARTED_AT + 60_000 })],
      }),
    ).toBeNull();
    expect(resolveSubagentOrphanAttribution({ runStartedAtMs: Number.NaN, boots: [] })).toBeNull();
  });
});

describe("formatSubagentOrphanErrorMessage", () => {
  it("names the cause, the restart, the prior boot, the true lifetime and the message count", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      lastActivityAtMs: RUN_DIED_AT,
      assistantMessageCount: 0,
      boots: [
        bootSegment({
          bootId: "boot-minus-5",
          startedAtMs: RUN_STARTED_AT - 60_000,
          hostBootId: KERNEL_BOOT_A,
        }),
        bootSegment({
          bootId: "boot-minus-4",
          startedAtMs: GATEWAY_RESTARTED_AT,
          hostBootId: KERNEL_BOOT_B,
        }),
      ],
    });
    const message = formatSubagentOrphanErrorMessage(attribution!);
    expect(message).toContain("host rebooted under the gateway");
    expect(message).toContain("2026-08-26T23:28:30.000Z");
    expect(message).toContain("previous boot boot-minus-5 ended without a clean stop");
    expect(message).toContain("0 assistant messages recorded");
    expect(message).toContain("at least 5m36s");
    expect(message).toContain("gateway absent 33m38s");
    // The misleading 40-minute apparent lifetime must not appear anywhere.
    expect(message).not.toContain("40m");
  });

  it("distinguishes a process death from a host reboot in the rendered text", () => {
    const processDeath = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      boots: [
        bootSegment({ bootId: "boot-a", startedAtMs: RUN_STARTED_AT - 60_000 }),
        bootSegment({ bootId: "boot-b", startedAtMs: GATEWAY_RESTARTED_AT }),
      ],
    });
    const message = formatSubagentOrphanErrorMessage(processDeath!);
    expect(message).toContain("gateway process died while the host stayed up");
    expect(message).not.toContain("gateway absent under 1s");
  });

  it("flags an inferred host-continuity verdict", () => {
    const inferred = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      boots: [
        bootSegment({
          bootId: "boot-a",
          startedAtMs: RUN_STARTED_AT - 60_000,
          hostBootId: "uptime:1",
        }),
        bootSegment({
          bootId: "boot-b",
          startedAtMs: GATEWAY_RESTARTED_AT,
          hostBootId: "uptime:1",
        }),
      ],
    });
    expect(formatSubagentOrphanErrorMessage(inferred!)).toContain("inferred from uptime");
  });

  it("uses singular wording for a single recorded assistant message", () => {
    const attribution = resolveSubagentOrphanAttribution({
      runStartedAtMs: RUN_STARTED_AT,
      assistantMessageCount: 1,
      boots: [
        bootSegment({ bootId: "boot-a", startedAtMs: RUN_STARTED_AT - 60_000 }),
        bootSegment({ bootId: "boot-b", startedAtMs: GATEWAY_RESTARTED_AT }),
      ],
    });
    expect(formatSubagentOrphanErrorMessage(attribution!)).toContain(
      "1 assistant message recorded",
    );
  });
});

function runRecord(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:child",
    requesterSessionKey: "agent:parent",
    requesterDisplayKey: "agent:parent",
    task: "do the thing",
    cleanup: "keep",
    createdAt: RUN_STARTED_AT,
    execution: { status: "running", startedAt: RUN_STARTED_AT },
    ...overrides,
  } as SubagentRunRecord;
}

describe("countRecordedSubagentAssistantMessages", () => {
  it("counts a run that recorded nothing as zero", () => {
    expect(countRecordedSubagentAssistantMessages(runRecord({}))).toBe(0);
    expect(
      countRecordedSubagentAssistantMessages(
        runRecord({ completion: { required: true, resultText: "   " } }),
      ),
    ).toBe(0);
  });

  it("counts captured and fallback result text", () => {
    expect(
      countRecordedSubagentAssistantMessages(
        runRecord({ completion: { required: true, resultText: "done" } }),
      ),
    ).toBe(1);
    expect(
      countRecordedSubagentAssistantMessages(
        runRecord({
          completion: { required: true, resultText: "done", fallbackResultText: "partial" },
        }),
      ),
    ).toBe(2);
  });
});

describe("resolveSubagentRunLastActivityMs", () => {
  it("prefers the latest timestamp the run itself wrote", () => {
    expect(
      resolveSubagentRunLastActivityMs(
        runRecord({
          execution: { status: "running", startedAt: RUN_STARTED_AT },
          completion: { required: true, capturedAt: RUN_DIED_AT },
        }),
      ),
    ).toBe(RUN_DIED_AT);
  });

  it("reports no activity rather than offering the run's own start as evidence", () => {
    expect(resolveSubagentRunLastActivityMs(runRecord({}))).toBeUndefined();
  });
});
