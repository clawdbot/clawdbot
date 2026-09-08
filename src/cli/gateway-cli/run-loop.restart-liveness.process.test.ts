import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { gatewayDirectStopEntrypoints } from "../cli-entrypoint.test-support.js";

const tempDirs = createTempDirTracker();
const children = new Map<ChildProcess, Promise<unknown[]>>();
const runLoopUrl = resolveRuntimeWorkerUrl(gatewayDirectStopEntrypoints.runLoop).href;
const restartUrl = resolveRuntimeWorkerUrl(gatewayDirectStopEntrypoints.restartPolicy).href;

const childScript = `
  import fs from "node:fs";
  import http from "node:http";
  import { runGatewayLoop } from ${JSON.stringify(runLoopUrl)};
  import { setGatewaySigusr1RestartPolicy } from ${JSON.stringify(restartUrl)};
  const faultPath = process.argv[1];
  setGatewaySigusr1RestartPolicy({ allowExternal: true });
  let starts = 0;
  try {
    await runGatewayLoop({
      ownsProcessLifecycle: true,
      start: async () => {
        const attempt = ++starts;
        process.stdout.write("start:" + attempt + "\\n");
        if (fs.existsSync(faultPath)) throw new Error("fixture startup refused");
        const server = http.createServer((_request, response) => response.end("ready"));
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        process.stdout.write("ready:" + attempt + "\\n");
        return {
          getTailscaleIngressEndpoint: () => undefined,
          startupSettled: Promise.resolve(),
          close: async () => {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            process.stdout.write("closed:" + attempt + "\\n");
          },
        };
      },
      runtime: {
        log: () => {},
        error: (...args) => console.error(...args),
        exit: code => process.exit(code),
      },
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
`;

afterEach(async () => {
  for (const child of children.keys()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  const results = await withTestTimeout(
    Promise.allSettled(children.values()),
    5_000,
    "restart liveness children did not close; retaining their fixture directories",
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) {
    throw new AggregateError(errors, "restart liveness cleanup failed");
  }
  children.clear();
  tempDirs.cleanup();
});

function startFixture(initialFailure = false) {
  const directory = tempDirs.make("openclaw-restart-liveness-");
  const home = path.join(directory, "home");
  fs.mkdirSync(home);
  const faultPath = path.join(directory, "startup-fault");
  if (initialFailure) {
    fs.writeFileSync(faultPath, "refuse");
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childScript, faultPath],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: directory,
        OPENCLAW_STATE_DIR: path.join(directory, "state"),
        OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
        OPENCLAW_NO_RESPAWN: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        TSX_DISABLE_CACHE: "1",
        ESBUILD_WORKER_THREADS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = once(child, "close");
  children.set(child, closed);
  void closed.catch(() => {});
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const waitForOutput = (text: string) =>
    vi.waitFor(() => expect(output).toContain(text), { timeout: 45_000, interval: 25 });
  return { child, closed, faultPath, waitForOutput, output: () => output };
}

async function expectFailedRestartWaiting(
  fixture: ReturnType<typeof startFixture>,
  attempt: number,
) {
  expect(fixture.child.kill("SIGUSR1")).toBe(true);
  await fixture.waitForOutput(`start:${attempt}`);
  await vi.waitFor(
    () =>
      expect(
        fixture.output().split("Process will stay alive; fix the issue and restart.").length - 1,
      ).toBe(attempt - 1),
    { timeout: 5_000, interval: 25 },
  );
  // Only the parent observes an idle interval. A child timer or IPC channel
  // would hide the lost-process regression after its real listener closes.
  expect(
    await Promise.race([
      fixture.closed.then((exit) => ({ exit })),
      delay(750).then(() => "waiting"),
    ]),
    fixture.output(),
  ).toBe("waiting");
}

describe("runGatewayLoop failed-restart process lifetime", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt(
    "recovers in the same process after repeated operator-triggered startup failures",
    async () => {
      const fixture = startFixture();
      await fixture.waitForOutput("ready:1");
      fs.writeFileSync(fixture.faultPath, "refuse");
      await expectFailedRestartWaiting(fixture, 2);
      await expectFailedRestartWaiting(fixture, 3);
      fs.unlinkSync(fixture.faultPath);
      expect(fixture.child.kill("SIGUSR1")).toBe(true);
      await fixture.waitForOutput("ready:4");
      expect(fixture.child.kill("SIGTERM")).toBe(true);
      expect(await fixture.closed, fixture.output()).toEqual([0, null]);
    },
    60_000,
  );

  posixIt.each(["SIGTERM", "SIGINT"] as const)(
    "exits cleanly on %s while waiting after a failed restart",
    async (signal) => {
      const fixture = startFixture();
      await fixture.waitForOutput("ready:1");
      fs.writeFileSync(fixture.faultPath, "refuse");
      await expectFailedRestartWaiting(fixture, 2);
      expect(fixture.child.kill(signal)).toBe(true);
      expect(await fixture.closed, fixture.output()).toEqual([0, null]);
      expect(fixture.output()).not.toContain("start:3");
    },
    60_000,
  );

  posixIt(
    "releases process ownership when initial startup rejects",
    async () => {
      const fixture = startFixture(true);
      expect(await fixture.closed, fixture.output()).toEqual([1, null]);
      expect(fixture.output()).toContain("fixture startup refused");
      expect(fixture.output()).not.toContain("Process will stay alive");
    },
    60_000,
  );
});
