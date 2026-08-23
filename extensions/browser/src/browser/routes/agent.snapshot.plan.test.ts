// Browser tests cover agent.snapshot.plan plugin behavior.
import { describe, expect, it } from "vitest";
import type { ResolvedBrowserProfile } from "../config.js";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "../constants.js";
import { resolveSnapshotPlan } from "./agent.snapshot.plan.js";

function profile(driver: "existing-session" | "openclaw"): ResolvedBrowserProfile {
  return {
    name: driver === "existing-session" ? "user" : "openclaw",
    driver,
    cdpPort: driver === "existing-session" ? 0 : 18792,
    cdpUrl: driver === "existing-session" ? "" : "http://127.0.0.1:18792",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    color: "#00AA00",
    headless: false,
    attachOnly: driver === "existing-session",
  };
}

describe("resolveSnapshotPlan", () => {
  it("defaults existing-session snapshots to ai when format is omitted", () => {
    const plan = resolveSnapshotPlan({
      profile: profile("existing-session"),
      query: {},
      hasPlaywright: true,
    });

    expect(plan.format).toBe("ai");
  });

  it("keeps ai snapshots for managed browsers when Playwright is available", () => {
    const plan = resolveSnapshotPlan({
      profile: profile("openclaw"),
      query: {},
      hasPlaywright: true,
    });

    expect(plan.format).toBe("ai");
  });

  it("treats urls as a role snapshot feature", () => {
    const plan = resolveSnapshotPlan({
      profile: profile("openclaw"),
      query: { urls: "1" },
      hasPlaywright: true,
    });

    expect(plan.urls).toBe(true);
    expect(plan.wantsRoleSnapshot).toBe(true);
  });

  it("parses timeoutMs from the snapshot query string", () => {
    const plan = resolveSnapshotPlan({
      profile: profile("openclaw"),
      query: { timeoutMs: "12345" },
      hasPlaywright: true,
    });

    expect(plan.timeoutMs).toBe(12345);
  });

  it("caps timeoutMs from the snapshot query string to Node's safe timer range", () => {
    const plan = resolveSnapshotPlan({
      profile: profile("openclaw"),
      query: { timeoutMs: "3000000000" },
      hasPlaywright: true,
    });

    expect(plan.timeoutMs).toBe(2_147_483_647);
  });

  it("parses snapshot numeric query options as strict integers", () => {
    const plan = resolveSnapshotPlan({
      profile: profile("openclaw"),
      query: {
        limit: "25",
        maxChars: "5000",
        depth: "2",
        timeoutMs: "12345",
      },
      hasPlaywright: true,
    });

    expect(plan.limit).toBe(25);
    expect(plan.resolvedMaxChars).toBe(5000);
    expect(plan.depth).toBe(2);
    expect(plan.timeoutMs).toBe(12345);
  });

  it("accepts structured numeric snapshot query options from proxy dispatch", () => {
    const plan = resolveSnapshotPlan({
      profile: profile("openclaw"),
      query: {
        limit: 25,
        maxChars: 5000,
        depth: 2,
        timeoutMs: 12345,
      },
      hasPlaywright: true,
    });

    expect(plan.limit).toBe(25);
    expect(plan.resolvedMaxChars).toBe(5000);
    expect(plan.depth).toBe(2);
    expect(plan.timeoutMs).toBe(12345);
  });

  it("rejects loose snapshot numeric query tokens", () => {
    const plan = resolveSnapshotPlan({
      profile: profile("openclaw"),
      query: {
        limit: "0x10",
        maxChars: "1.5",
        depth: "1e0",
        timeoutMs: "1000ms",
      },
      hasPlaywright: true,
    });

    expect(plan.limit).toBeUndefined();
    expect(plan.resolvedMaxChars).toBe(DEFAULT_AI_SNAPSHOT_MAX_CHARS);
    expect(plan.depth).toBeUndefined();
    expect(plan.timeoutMs).toBeUndefined();
  });

  it("keeps maxChars zero as an explicit uncapped snapshot request", () => {
    const plan = resolveSnapshotPlan({
      profile: profile("openclaw"),
      query: { maxChars: "0" },
      hasPlaywright: true,
    });

    expect(plan.resolvedMaxChars).toBeUndefined();
  });

  it("ignores non-positive timeoutMs values", () => {
    expect(
      resolveSnapshotPlan({
        profile: profile("openclaw"),
        query: { timeoutMs: "0" },
        hasPlaywright: true,
      }).timeoutMs,
    ).toBeUndefined();
    expect(
      resolveSnapshotPlan({
        profile: profile("openclaw"),
        query: { timeoutMs: "not-a-number" },
        hasPlaywright: true,
      }).timeoutMs,
    ).toBeUndefined();
  });
});
