/** Tests bootstrap mode selection for primary, cron, heartbeat, and sandboxed runs. */
import { describe, expect, it } from "vitest";
import { isHeartbeatLifecycleRunKind, resolveBootstrapMode } from "./bootstrap-mode.js";

describe("resolveBootstrapMode", () => {
  it("classifies global and commitment-only runs as heartbeat lifecycle turns", () => {
    expect(isHeartbeatLifecycleRunKind("heartbeat")).toBe(true);
    expect(isHeartbeatLifecycleRunKind("commitment-only")).toBe(true);
    expect(isHeartbeatLifecycleRunKind("cron")).toBe(false);
    expect(isHeartbeatLifecycleRunKind("default")).toBe(false);
  });

  it("returns none when bootstrap is not pending", () => {
    expect(
      resolveBootstrapMode({
        bootstrapPending: false,
        runKind: "default",
        isInteractiveUserFacing: true,
        isPrimaryRun: true,
        isCanonicalWorkspace: true,
        hasBootstrapFileAccess: true,
      }),
    ).toBe("none");
  });

  it("returns full for primary interactive canonical runs with file access", () => {
    expect(
      resolveBootstrapMode({
        bootstrapPending: true,
        runKind: "default",
        isInteractiveUserFacing: true,
        isPrimaryRun: true,
        isCanonicalWorkspace: true,
        hasBootstrapFileAccess: true,
      }),
    ).toBe("full");
  });

  it("returns limited for primary interactive copied-sandbox runs with file access", () => {
    expect(
      resolveBootstrapMode({
        bootstrapPending: true,
        runKind: "default",
        isInteractiveUserFacing: true,
        isPrimaryRun: true,
        isCanonicalWorkspace: false,
        hasBootstrapFileAccess: true,
      }),
    ).toBe("limited");
  });

  it("returns none for background and non-primary runs", () => {
    expect(
      resolveBootstrapMode({
        bootstrapPending: true,
        runKind: "cron",
        isInteractiveUserFacing: true,
        isPrimaryRun: true,
        isCanonicalWorkspace: true,
        hasBootstrapFileAccess: true,
      }),
    ).toBe("none");
    expect(
      resolveBootstrapMode({
        bootstrapPending: true,
        runKind: "heartbeat",
        isInteractiveUserFacing: true,
        isPrimaryRun: true,
        isCanonicalWorkspace: true,
        hasBootstrapFileAccess: true,
      }),
    ).toBe("none");
    expect(
      resolveBootstrapMode({
        bootstrapPending: true,
        runKind: "commitment-only",
        isInteractiveUserFacing: true,
        isPrimaryRun: true,
        isCanonicalWorkspace: true,
        hasBootstrapFileAccess: true,
      }),
    ).toBe("none");
    expect(
      resolveBootstrapMode({
        bootstrapPending: true,
        runKind: "default",
        isInteractiveUserFacing: true,
        isPrimaryRun: false,
        isCanonicalWorkspace: true,
        hasBootstrapFileAccess: true,
      }),
    ).toBe("none");
  });

  it("returns limited when the run cannot access bootstrap files normally", () => {
    expect(
      resolveBootstrapMode({
        bootstrapPending: true,
        runKind: "default",
        isInteractiveUserFacing: true,
        isPrimaryRun: true,
        isCanonicalWorkspace: true,
        hasBootstrapFileAccess: false,
      }),
    ).toBe("limited");
  });
});
