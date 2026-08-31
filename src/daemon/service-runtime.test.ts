// Tests for systemd supervision-state classification helpers.
import { describe, expect, it } from "vitest";
import { isSystemdStartLimitHit } from "./service-runtime.js";

describe("isSystemdStartLimitHit", () => {
  it("detects a crash loop where the restart counter reached StartLimitBurst", () => {
    // Real systemd 249 give-up: process kept exiting non-zero so Result stays
    // exit-code; NRestarts hitting StartLimitBurst is the give-up signal.
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
      }),
    ).toBe(true);
  });

  it("detects a crash loop when the last exit was a non-config code", () => {
    // exit 1 is a normal crash, not the RestartPreventExitStatus=78 no-restart
    // path, so a counter that reached StartLimitBurst is real start-limit exhaustion.
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        lastExitStatus: 1,
        systemd: { result: "exit-code", nRestarts: 3, startLimitBurst: 3 },
      }),
    ).toBe(true);
  });

  it("detects Result=start-limit-hit even when restart counters are absent", () => {
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        systemd: { result: "start-limit-hit" },
      }),
    ).toBe(true);
  });

  it("does not counter-detect the deliberate EX_CONFIG (78) no-restart exit", () => {
    // RestartPreventExitStatus=78 stops systemd on purpose; the NRestarts left
    // over from earlier crashes is stale and must not read as start-limit exhaustion.
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        lastExitStatus: 78,
        systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
      }),
    ).toBe(false);
  });

  it("keeps Result=start-limit-hit authoritative even after a config (78) exit", () => {
    // The explicit systemd give-up signal wins regardless of the last exit code.
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        lastExitStatus: 78,
        systemd: { result: "start-limit-hit", nRestarts: 5, startLimitBurst: 5 },
      }),
    ).toBe(true);
  });

  it("does not flag a single failed exit below the start limit", () => {
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 1, startLimitBurst: 5 },
      }),
    ).toBe(false);
  });

  it("does not flag a running unit even if its lifetime restart count is high", () => {
    expect(
      isSystemdStartLimitHit({
        status: "running",
        state: "active",
        systemd: { result: "success", nRestarts: 9, startLimitBurst: 5 },
      }),
    ).toBe(false);
  });

  it("does not flag when rate limiting is disabled (StartLimitBurst=0)", () => {
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 9, startLimitBurst: 0 },
      }),
    ).toBe(false);
  });

  it("does not counter-detect when StartLimitBurst is missing from the probe", () => {
    expect(
      isSystemdStartLimitHit({
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 9 },
      }),
    ).toBe(false);
  });

  it("returns false without systemd supervision data or runtime", () => {
    expect(isSystemdStartLimitHit({ status: "stopped", state: "failed" })).toBe(false);
    expect(isSystemdStartLimitHit(undefined)).toBe(false);
  });
});
