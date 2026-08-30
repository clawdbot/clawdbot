import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures = [
  { owner: "setup", name: "forwards output and SIGTERM through the runner process group" },
  { owner: "timeout", name: "cleans timeout descendants before resolving the case" },
  { owner: "parent", name: "cleans active case descendants on parent signal" },
] as const;

afterEach(() => {
  for (const module of [
    "vitest",
    "node:fs",
    "node:child_process",
    "../../scripts/profile-extension-memory.mts",
    "../../scripts/lib/vitest-build-prerequisites.mts",
    "../helpers/promise.js",
  ]) {
    vi.doUnmock(module);
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

function errorTree(error: unknown): unknown[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(errorTree);
  }
  return error instanceof Error && error.cause ? [error, ...errorTree(error.cause)] : [error];
}

async function captureFixture(owner: (typeof fixtures)[number]["owner"]) {
  vi.resetModules();
  const bodies = new Map<string, () => Promise<void>>();
  const register = (name: string, body: () => Promise<void>) => bodies.set(name, body);
  vi.doMock("vitest", () => ({
    describe: (_name: string, body: () => void) => body(),
    it: Object.assign(register, { each: () => () => {}, runIf: () => register, skip: register }),
    expect,
    vi,
  }));
  if (owner === "setup") {
    await import("./vitest-e2e-global-setup.test.js");
  } else {
    await import("./profile-extension-memory.test.js");
  }
  const fixture = fixtures.find((entry) => entry.owner === owner)!;
  const body = bodies.get(fixture.name);
  expect(body, fixture.name).toBeTypeOf("function");
  return body!;
}

// Execute the registered process fixtures, injecting OS faults at their real
// dependencies. No extracted copy of the cleanup implementation is exercised.
describe.skipIf(process.platform === "win32")("process fixture cleanup faults", () => {
  it.each(
    fixtures.flatMap(({ owner, name }) =>
      ["EPERM", "ESRCH"].map((code) => ({ owner, name, code })),
    ),
  )("preserves failures and finishes safe $owner cleanup after $code", async ({ owner, code }) => {
    const primary = new Error("fixture assertion failed");
    const denied = Object.assign(new Error("injected kill failure"), { code });
    const scratchError = new Error("scratch removal failed");
    const leader = 81001;
    const descendants = owner === "setup" ? [81002, 81003] : [81003];
    const alive = new Set([leader, ...descendants]);
    let parentSignaled = false;
    const events: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: leader,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const close = () => {
      alive.delete(leader);
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      events.push("close");
      child.emit("close", null, "SIGKILL");
    };
    const fs = {
      mkdtempSync: () => "/fixture",
      mkdirSync: () => {},
      writeFileSync: () => {},
      existsSync: () => true,
      readFileSync: (file: string) =>
        String(file.endsWith("child.pid") ? descendants[0] : descendants.at(-1)),
      rmSync: () => {
        events.push("scratch");
        if (owner === "setup" && code === "EPERM") {
          throw scratchError;
        }
      },
    };
    vi.doMock("node:fs", () => ({ ...fs, default: fs }));
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        setImmediate(() => child.emit("spawn"));
        return child;
      },
    }));
    vi.doMock("../../scripts/lib/vitest-build-prerequisites.mts", () => ({}));
    vi.doMock("../../scripts/profile-extension-memory.mts", () => ({
      runCase: async () => {
        throw primary;
      },
    }));
    const { withTestTimeout } = await import("../helpers/promise.js");
    vi.doMock("../helpers/promise.js", () => ({
      // Keep the real deadline owner; shorten only this injected never-closing child.
      withTestTimeout: (promise: PromiseLike<unknown>, ms: number, message: string) =>
        withTestTimeout(promise, owner === "parent" && code === "EPERM" ? 20 : ms, message),
    }));
    vi.spyOn(vi, "waitFor").mockRejectedValue(primary);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) {
        const groupPids = [leader, ...descendants];
        if (pid < 0 ? groupPids.some((member) => alive.has(member)) : alive.has(pid)) {
          return true;
        }
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      events.push(`kill:${pid}`);
      if (signal === "SIGTERM" && !parentSignaled) {
        parentSignaled = true;
        throw primary;
      }
      const deniedTarget =
        owner === "setup" ? descendants[0] : owner === "timeout" ? -leader : leader;
      if (pid === deniedTarget) {
        if (code === "ESRCH") {
          alive.delete(Math.abs(pid));
          if (pid < 0) {
            alive.clear();
          }
          if (Math.abs(pid) === leader) {
            setImmediate(close);
          }
        }
        throw denied;
      }
      if (pid === -leader) {
        setImmediate(() => {
          alive.clear();
          close();
        });
      } else {
        alive.delete(pid);
        if (pid === leader) {
          setImmediate(close);
        }
      }
      return true;
    });

    const body = await captureFixture(owner);
    const failure: unknown = await body().catch((error: unknown) => error);
    expect(errorTree(failure)).toContain(primary);
    if (code === "EPERM") {
      expect(errorTree(failure)).toContain(denied);
    } else {
      expect(failure).not.toBeInstanceOf(AggregateError);
      if (owner !== "timeout") {
        expect(failure).toBe(primary);
      }
    }
    if (owner === "setup" && code === "EPERM") {
      expect(errorTree(failure)).toContain(scratchError);
    }
    if (code === "EPERM") {
      expect(events).toContain(`kill:${descendants.at(-1)}`);
    }
    if (owner === "parent" && code === "EPERM") {
      expect(events).not.toContain("scratch");
      expect(errorTree(failure)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("close") }),
        ]),
      );
    } else {
      expect(events.indexOf("close")).toBeGreaterThan(-1);
      expect(events.indexOf("scratch")).toBeGreaterThan(events.indexOf("close"));
    }
  });

  it("removes setup scratch after a fixture write fails before spawn", async () => {
    const primary = new Error("fixture write failed");
    const rmSync = vi.fn();
    const fs = {
      mkdtempSync: () => "/fixture",
      mkdirSync: () => {},
      writeFileSync: () => {
        throw primary;
      },
      existsSync: () => false,
      rmSync,
    };
    vi.doMock("node:fs", () => ({ ...fs, default: fs }));
    vi.doMock("../../scripts/lib/vitest-build-prerequisites.mts", () => ({}));
    const body = await captureFixture("setup");
    await expect(body()).rejects.toBe(primary);
    expect(rmSync).toHaveBeenCalledWith("/fixture", { force: true, recursive: true });
  });
});
