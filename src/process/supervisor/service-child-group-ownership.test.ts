import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
const { census, definitelyDead } = vi.hoisted(() => ({
  census: vi.fn(),
  definitelyDead: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: census }));
vi.mock("../../shared/pid-alive.js", () => ({ isPidDefinitelyDead: definitelyDead }));
import { hasLiveOwnedProcessGroupMembers } from "./service-child-group-ownership.js";

beforeEach(() => {
  census.mockReset();
  definitelyDead.mockReset().mockReturnValue(false);
  mockProcessPlatform("linux");
});
afterEach(() => vi.restoreAllMocks());

it.each([
  { state: "S", expected: true },
  { state: "D", expected: true },
  { state: "U", expected: true },
  { state: "Z", expected: true },
  { state: "Z+", expected: true },
  { state: "Zl", expected: true },
  { state: "Zsl", expected: true },
  { state: "Zl+", expected: true },
])("observes a $state descendant as live=$expected", ({ state, expected }) => {
  census.mockReturnValue({
    status: 0,
    stdout: `${process.pid} ${process.pid} S\n${process.pid + 1} ${process.pid} ${state}\n`,
  });
  expect(hasLiveOwnedProcessGroupMembers()).toBe(expected);
});

it("allows retirement only after the shared check confirms a Linux zombie's threads exited", () => {
  census.mockReturnValue({
    status: 0,
    stdout: `${process.pid} ${process.pid} S\n${process.pid + 1} ${process.pid} Z\n`,
  });
  definitelyDead.mockReturnValue(true);
  expect(hasLiveOwnedProcessGroupMembers()).toBe(false);
});

it.each([
  { status: 1, stdout: "" },
  { status: 0, stdout: "malformed census" },
  { status: 0, stdout: "" },
  { status: 0, stdout: `${process.pid} ${process.pid + 1} S\n` },
])("keeps failed or missing group ownership uncertain (%j)", (result) => {
  census.mockReturnValue(result);
  expect(hasLiveOwnedProcessGroupMembers()).toBeUndefined();
});

it.each([false, true])("excludes only its exact inspector PID (other group member=%s)", (other) => {
  census.mockReturnValue({
    pid: process.pid + 1,
    status: 0,
    stdout: `${process.pid} ${process.pid} S\n${process.pid + 1} ${process.pid} R\n${process.pid + 2} ${other ? process.pid : process.pid + 2} S\n`,
  });
  expect(hasLiveOwnedProcessGroupMembers()).toBe(other);
});
