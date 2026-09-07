import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectUpdateRunDriver, readUpdateRunDriver } from "./update-run-driver.js";

const probes = vi.hoisted(() => ({
  hostname: vi.fn<() => string>(),
  startedAt: vi.fn<(pid: number) => number | null>(),
  definitelyDead: vi.fn<(pid: number) => boolean>(),
}));

vi.mock("node:os", () => ({ hostname: probes.hostname }));
vi.mock("../shared/pid-alive.js", () => ({
  getFileLockProcessStartTime: probes.startedAt,
  isPidDefinitelyDead: probes.definitelyDead,
}));

beforeEach(() => {
  probes.hostname.mockReturnValue("update-host");
  probes.startedAt.mockReturnValue(123);
  probes.definitelyDead.mockReturnValue(false);
});

describe("update run driver identity", () => {
  it.each([0, 123])("captures the current driver with start identity %s", (startedAt) => {
    probes.startedAt.mockReturnValue(startedAt);
    expect(readUpdateRunDriver()).toEqual({
      host: "update-host",
      pid: process.pid,
      startIdentity: String(startedAt),
    });
  });

  it.each([
    { host: "", startedAt: 123 },
    { host: "update-host", startedAt: null },
    { host: "x".repeat(256), startedAt: 123 },
  ])("does not invent a missing identity (%j)", ({ host, startedAt }) => {
    probes.hostname.mockReturnValue(host);
    probes.startedAt.mockReturnValue(startedAt);
    expect(readUpdateRunDriver()).toBeUndefined();
  });

  it.each([
    { host: "update-host", dead: false, startedAt: 123, expected: "alive" },
    { host: "update-host", dead: true, startedAt: null, expected: "dead" },
    { host: "update-host", dead: false, startedAt: 456, expected: "dead" },
    { host: "update-host", dead: false, startedAt: null, expected: "unknown" },
    { host: "another-host", dead: true, startedAt: null, expected: "unknown" },
    { host: "another-host", dead: false, startedAt: 456, expected: "unknown" },
  ])("requires local positive evidence before declaring a driver dead (%j)", (test) => {
    probes.definitelyDead.mockReturnValue(test.dead);
    probes.startedAt.mockReturnValue(test.startedAt);
    expect(inspectUpdateRunDriver({ host: test.host, pid: 42, startIdentity: "123" })).toBe(
      test.expected,
    );
  });
});
