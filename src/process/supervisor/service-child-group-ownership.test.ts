import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
const { census, definitelyDead, directory, readStat } = vi.hoisted(() => ({
  census: vi.fn(),
  definitelyDead: vi.fn(),
  directory: vi.fn(),
  readStat: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: census }));
vi.mock("node:fs", () => ({ readdirSync: directory, readFileSync: readStat }));
vi.mock("../../shared/pid-alive.js", () => ({ isPidDefinitelyDead: definitelyDead }));
import { hasLiveOwnedProcessGroupMembers } from "./service-child-group-ownership.js";

const owner = process.pid;
let rows: Map<number, string | Error>;
function stat(pid: number, group: number, state = "S", name = "worker") {
  return `${pid} (${name}) ${state} 1 ${group} 0 0`;
}

beforeEach(() => {
  census.mockReset().mockReturnValue({ error: new Error("ps is unavailable") });
  definitelyDead.mockReset().mockReturnValue(false);
  rows = new Map([[owner, stat(owner, owner)]]);
  directory.mockReset().mockImplementation(() => ["self", ...Array.from(rows.keys(), String)]);
  readStat.mockReset().mockImplementation((file: string) => {
    const match = /^\/proc\/(\d+)\/stat$/.exec(file);
    const value = match ? rows.get(Number(match[1])) : undefined;
    if (value === undefined || value instanceof Error) {
      throw value ?? new Error(`Unexpected fixture read: ${file}`);
    }
    return value;
  });
  mockProcessPlatform("linux");
});
afterEach(() => vi.restoreAllMocks());

it.each(["S", "D", "U", "R"])("observes a Linux %s group member without ps", (state) => {
  rows.set(owner + 1, stat(owner + 1, owner, state, "worker ) (with\nname"));
  expect(hasLiveOwnedProcessGroupMembers()).toBe(true);
  expect(census).not.toHaveBeenCalled();
});

it.each([false, true])("uses the shared Linux zombie/thread decision (dead=%s)", (dead) => {
  rows.set(owner + 1, stat(owner + 1, owner, "Z"));
  definitelyDead.mockReturnValue(dead);
  expect(hasLiveOwnedProcessGroupMembers()).toBe(!dead);
  expect(definitelyDead).toHaveBeenCalledExactlyOnceWith(owner + 1);
});

it("allows an observed Linux owner to retire without requiring a ps executable", () => {
  rows.set(owner + 1, stat(owner + 1, owner + 1));
  expect(hasLiveOwnedProcessGroupMembers()).toBe(false);
  expect(census).not.toHaveBeenCalled();
});

it.each(["ENOENT", "ESRCH"])(
  "tolerates a foreign PID disappearing during the census (%s)",
  (code) => {
    rows.set(owner + 1, Object.assign(new Error("gone"), { code }));
    expect(hasLiveOwnedProcessGroupMembers()).toBe(false);
  },
);

it.each([
  "missing owner",
  "wrong group",
  "malformed stat",
  "inaccessible row",
  "inaccessible directory",
])("keeps the Linux census uncertain with %s", (failure) => {
  if (failure === "missing owner") {
    rows.clear();
  }
  if (failure === "wrong group") {
    rows.set(owner, stat(owner, owner + 1));
  }
  if (failure === "malformed stat") {
    rows.set(owner + 1, "invalid stat");
  }
  if (failure === "inaccessible row") {
    rows.set(owner + 1, Object.assign(new Error("denied"), { code: "EACCES" }));
  }
  if (failure === "inaccessible directory") {
    directory.mockImplementation(() => {
      throw new Error("denied");
    });
  }
  expect(hasLiveOwnedProcessGroupMembers()).toBeUndefined();
});

it("does not report an empty Linux group after its existing census budget expires", () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  readStat.mockImplementation(() => {
    now = 51;
    return stat(owner, owner);
  });
  expect(hasLiveOwnedProcessGroupMembers(50)).toBeUndefined();
  expect(census).not.toHaveBeenCalled();
});

it.each([
  { state: "S", expected: true },
  { state: "D", expected: true },
  { state: "U", expected: true },
  { state: "Z", expected: false },
  { state: "Z+", expected: false },
])("preserves Darwin ps state $state as live=$expected", ({ state, expected }) => {
  mockProcessPlatform("darwin");
  census.mockReturnValue({
    status: 0,
    stdout: `${owner} ${owner} S\n${owner + 1} ${owner} ${state}\n`,
  });
  expect(hasLiveOwnedProcessGroupMembers()).toBe(expected);
  expect(directory).not.toHaveBeenCalled();
  expect(readStat).not.toHaveBeenCalled();
});

it.each([
  { status: 1, stdout: "" },
  { status: 0, stdout: "malformed census" },
  { status: 0, stdout: "" },
  { status: 0, stdout: `${owner} ${owner + 1} S\n` },
])("keeps failed Darwin ownership uncertain (%j)", (result) => {
  mockProcessPlatform("darwin");
  census.mockReturnValue(result);
  expect(hasLiveOwnedProcessGroupMembers()).toBeUndefined();
});

it.each([false, true])("excludes only Darwin's exact inspector PID (other member=%s)", (other) => {
  mockProcessPlatform("darwin");
  census.mockReturnValue({
    pid: owner + 1,
    status: 0,
    stdout: `${owner} ${owner} S\n${owner + 1} ${owner} R\n${owner + 2} ${other ? owner : owner + 2} S\n`,
  });
  expect(hasLiveOwnedProcessGroupMembers()).toBe(other);
});
