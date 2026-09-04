// Process-boundary proof for direct-stop draining after durable channel-turn adoption.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

const CHILD_READY_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 60_000;
const RELEASE_DELAY_MS = 400;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  children.clear();
});

const moduleUrl = (relativePath: string) => pathToFileURL(path.resolve(relativePath)).href;

const childScript = `
  import fs from "node:fs";
  import path from "node:path";
  import { createChannelIngressDrain } from ${JSON.stringify(moduleUrl("src/channels/message/ingress-drain.ts"))};
  import { createChannelIngressQueue } from ${JSON.stringify(moduleUrl("src/channels/message/ingress-queue.ts"))};
  import {
    clearActiveEmbeddedRun,
    setActiveEmbeddedRun,
  } from ${JSON.stringify(moduleUrl("src/agents/embedded-agent-runner/runs.ts"))};
  import { getActiveEmbeddedRunCount } from ${JSON.stringify(moduleUrl("src/agents/embedded-agent-runner/active-run-projections.ts"))};
  import { runGatewayLoop } from ${JSON.stringify(moduleUrl("src/cli/gateway-cli/run-loop.ts"))};
  import { getActiveGatewayRootWorkCount } from ${JSON.stringify(moduleUrl("src/process/gateway-work-admission.ts"))};

  const tracePath = process.argv[1];
  const stateDir = process.argv[2];
  const trace = (line) => {
    fs.appendFileSync(tracePath, line + "\\n");
    process.stdout.write("process proof: " + line + "\\n");
  };
  const keepAlive = setInterval(() => {}, 1_000);
  const queue = createChannelIngressQueue({
    channelId: "process-proof",
    accountId: "direct-stop",
    stateDir,
  });
  let releaseEmbedded;
  const embeddedMaySettle = new Promise((resolve) => {
    releaseEmbedded = resolve;
  });
  let resolveAdopted;
  const adopted = new Promise((resolve) => {
    resolveAdopted = resolve;
  });
  const sessionId = "direct-stop-active-work";
  const sessionKey = "agent:main:process-proof:direct-stop-active-work";
  const handle = {
    runId: "run-direct-stop-active-work",
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => trace("embedded-aborted"),
  };
  const drain = createChannelIngressDrain({
    queue,
    dispatchClaimedEvent: async (_event, lifecycle) => {
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      await lifecycle.onAdopted();
      trace(
        "adopted:roots=" +
          getActiveGatewayRootWorkCount() +
          ":embedded=" +
          getActiveEmbeddedRunCount(),
      );
      resolveAdopted();
      await embeddedMaySettle;
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      trace("embedded-completed");
    },
  });

  await queue.enqueue("event-direct-stop", { text: "hello" }, { laneKey: sessionKey });
  process.prependOnceListener("SIGTERM", () => {
    trace("signal:SIGTERM");
    setTimeout(() => releaseEmbedded(), ${RELEASE_DELAY_MS});
  });

  await runGatewayLoop({
    start: async () => {
      await drain.drainOnce();
      await adopted;
      setImmediate(() => trace("gateway-ready"));
      return {
        getTailscaleIngressEndpoint: () => undefined,
        startupSettled: Promise.resolve(),
        close: async () => {
          trace("gateway-close");
          drain.dispose();
        },
      };
    },
    runtime: {
      log: () => {},
      error: () => {},
      exit: (code) => {
        clearInterval(keepAlive);
        trace("process-exit:" + code);
        process.exit(code);
      },
    },
    lockPort: 19473,
  });
`;

function readTrace(tracePath: string): string[] {
  try {
    return fs.readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

describe("runGatewayLoop direct-stop active work", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt.each([false, true])(
    "reports and drains a rootless adopted channel run after OS SIGTERM (trace=%s)",
    async (traceEnabled) => {
      const fixtureDir = tempDirs.make("openclaw-direct-stop-active-work-");
      const stateDir = path.join(fixtureDir, "state");
      const homeDir = path.join(fixtureDir, "home");
      const tracePath = path.join(fixtureDir, "trace.log");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(homeDir, { recursive: true });
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", childScript, tracePath, stateDir],
        {
          cwd: path.resolve("."),
          env: {
            ...process.env,
            HOME: homeDir,
            NODE_ENV: undefined,
            NODE_DISABLE_COMPILE_CACHE: "1",
            NODE_OPTIONS: undefined,
            OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_GATEWAY_RESTART_TRACE: traceEnabled ? "1" : undefined,
            VITEST: undefined,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

      await vi.waitFor(
        () => {
          expect(readTrace(tracePath), Buffer.concat(stderr).toString("utf8")).toContain(
            "gateway-ready",
          );
        },
        { timeout: CHILD_READY_TIMEOUT_MS, interval: 25 },
      );
      // The exit event can precede the final stdout data; close joins both streams.
      const exited = once(child, "close") as Promise<
        [code: number | null, signal: NodeJS.Signals | null]
      >;
      expect(child.kill("SIGTERM")).toBe(true);

      const exit = await exited;
      expect(
        exit,
        `${readTrace(tracePath).join(" -> ")}\n${Buffer.concat(stderr).toString("utf8")}`,
      ).toEqual([0, null]);
      children.delete(child);
      const trace = readTrace(tracePath);
      expect(trace).toContain("adopted:roots=0:embedded=1");
      expect(trace).not.toContain("embedded-aborted");
      expect(trace.indexOf("signal:SIGTERM")).toBeLessThan(trace.indexOf("embedded-completed"));
      expect(trace.indexOf("embedded-completed")).toBeLessThan(trace.indexOf("gateway-close"));
      expect(trace.indexOf("gateway-close")).toBeLessThan(trace.indexOf("process-exit:0"));
      const output = Buffer.concat(stdout).toString("utf8");
      expect(output).toContain("embeddedRuns=1");
      expect(output.indexOf("embeddedRuns=1")).toBeLessThan(
        output.indexOf("process proof: embedded-completed"),
      );
      expect(output).toContain("active-work drain settled; beginning server close");
      expect(output.indexOf("active-work drain settled; beginning server close")).toBeLessThan(
        output.indexOf("process proof: gateway-close"),
      );
      if (traceEnabled) {
        expect(output).toContain("restart trace: stop.signal.received ");
        expect(output).toContain("restart trace: stop.drain.begin ");
        expect(output).toContain("restart trace: stop.drain ");
      } else {
        expect(output).not.toContain("restart trace:");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
