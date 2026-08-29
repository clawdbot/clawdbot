import { appendFileSync, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import { isQaPosixProcessGroupAlive, signalQaPosixProcessGroup } from "./posix-process-group.js";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import type { QaSuiteResolvedRunContext } from "./suite-types.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const artifactRoot = path.join(repoRoot, ".artifacts/qa-e2e/startup-lease-fix");

// This disposable CLI consumes synthetic auth stdin without storing or logging it.
// The descendant stays in the real detached gateway group after its leader exits.
const fixtureSource = String.raw`
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [root, command, leaderText] = process.argv.slice(2);
const record = (kind, details = {}) => fs.appendFileSync(
  path.join(root, "events.jsonl"), JSON.stringify({ at: Date.now(), kind, ...details }) + "\n");
const pgid = () => Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)],
  { encoding: "utf8" }).trim());
if (command === "models") {
  for await (const ignored of process.stdin) { /* discard synthetic auth */ }
  record("auth-cli-completed");
  process.exit(0);
}
if (command === "update" && leaderText === "repair") {
  if (process.argv.includes("--help")) {
    process.stdout.write("Options: --accept-capabilities --yes --no-restart --json");
  } else {
    record("plugin-repair-completed");
    process.stdout.write(JSON.stringify({ status: "ok" }));
  }
  process.exit(0);
}
if (command === "descendant") {
  process.on("SIGTERM", () => {});
  setTimeout(() => { record("descendant-failsafe-exit"); process.exit(0); }, 30_000);
  const identity = { leaderPid: Number(leaderText), descendantPid: process.pid, pgid: pgid() };
  record("descendant-ready", identity);
  process.send(identity);
} else if (command === "gateway") {
  setTimeout(() => process.exit(19), 10_000);
  const identity = { leaderPid: process.pid, pgid: pgid() };
  fs.writeFileSync(path.join(root, "identity.json"), JSON.stringify(identity));
  record("gateway-start", identity);
  const descendant = spawn(process.execPath,
    [fileURLToPath(import.meta.url), root, "descendant", String(process.pid)],
    { detached: false, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const [ready] = await once(descendant, "message");
  if (ready.descendantPid !== descendant.pid || ready.pgid !== process.pid) process.exit(18);
  fs.writeFileSync(path.join(root, "identity.json"), JSON.stringify(ready));
  process.on("exit", (exitCode) => record("leader-exit", { exitCode, ...ready }));
  process.exit(17);
} else {
  throw new Error("unexpected disposable CLI command");
}
`;

type Identity = { leaderPid: number; pgid: number; descendantPid?: number };
type Event = { at: number; kind: string; [key: string]: unknown };

function readIdentity(root: string): Identity | undefined {
  const identityPath = path.join(root, "identity.json");
  if (!existsSync(identityPath)) {
    return undefined;
  }
  const identity = JSON.parse(readFileSync(identityPath, "utf8")) as Identity;
  if (
    !Number.isSafeInteger(identity.leaderPid) ||
    identity.leaderPid <= 1 ||
    identity.leaderPid !== identity.pgid ||
    (identity.descendantPid !== undefined &&
      (!Number.isSafeInteger(identity.descendantPid) || identity.descendantPid <= 1))
  ) {
    throw new Error("invalid owned fixture identity; refusing to signal");
  }
  return identity;
}

function serializeError(error: unknown): unknown {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        ...(error.cause ? { cause: serializeError(error.cause) } : {}),
        ...(error instanceof AggregateError ? { errors: error.errors.map(serializeError) } : {}),
      }
    : String(error);
}

async function reproduce(denyGroupSignals: boolean) {
  await fs.mkdir(artifactRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(artifactRoot, denyGroupSignals ? "fault-" : "control-"));
  const eventsPath = path.join(root, "events.jsonl");
  const record = (kind: string, details: Record<string, unknown> = {}) =>
    appendFileSync(eventsPath, `${JSON.stringify({ at: Date.now(), kind, ...details })}\n`);
  const realKill = process.kill.bind(process);
  const alive = (pid: number | undefined) => {
    if (pid === undefined) {
      return false;
    }
    try {
      realKill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
      return false;
    }
  };
  const snapshot = () => {
    const identity = readIdentity(root);
    const groupAlive = identity ? isQaPosixProcessGroupAlive(identity.pgid) : false;
    return {
      ...identity,
      leaderAlive: alive(identity?.leaderPid),
      descendantAlive:
        alive(identity?.descendantPid) && (process.platform !== "linux" || groupAlive),
      groupAlive,
    };
  };
  const releases: ReturnType<typeof snapshot>[] = [];
  let stopHeartbeat: (() => Promise<void>) | undefined;
  let suiteError: unknown;
  let groupProbeCount = 0;
  let scenarioCalls = 0;
  const tempParentDir = path.join(root, "gateway-temp");
  const fixturePath = path.join(root, "fixture.mjs");
  await fs.mkdir(tempParentDir);
  await fs.writeFile(fixturePath, fixtureSource);

  // A local synthetic broker doubles as the supplied lab's readiness endpoint.
  // Requests/headers/payloads are never recorded; the release observation is PID-only.
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    if (request.url === "/readyz") {
      record("lab-ready-request");
      response.end('{"ok":true}');
    } else if (request.url === "/qa-credentials/v1/acquire") {
      record("lease-acquire");
      response.end(
        JSON.stringify({
          status: "ok",
          credentialId: "synthetic-only",
          leaseToken: "synthetic-only",
          payload: { synthetic: true },
          heartbeatIntervalMs: 250,
          leaseTtlMs: 60_000,
        }),
      );
    } else if (request.url === "/qa-credentials/v1/heartbeat") {
      record("lease-heartbeat");
      response.end('{"status":"ok"}');
    } else if (request.url === "/qa-credentials/v1/release") {
      const observation = snapshot();
      releases.push(observation);
      record("lease-release", observation);
      response.end('{"status":"ok"}');
    } else {
      record("unexpected-http-request");
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing local broker address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const state = createQaBusState();
  const unexpected = () => {
    throw new Error("startup failure must precede lab publication");
  };
  const lab: QaLabServerHandle = {
    baseUrl,
    listenUrl: baseUrl,
    state,
    setControlUi: unexpected,
    setScenarioRun: unexpected,
    setLatestReport: unexpected,
    runSelfCheck: async () => unexpected(),
    stop: async () => {
      record("suite-lab-finish");
      state.reset(true);
    },
  };
  const factory: QaTransportAdapterFactory = {
    id: "startup-lease-fixture",
    matches: ({ channelId, driver }) => channelId === "startup-lease-fixture" && driver === "live",
    async create({ credentials, messages }) {
      const lease = await credentials.acquire({
        kind: "synthetic-startup-lease",
        source: "convex",
        role: "ci",
        resolveEnvPayload: () => {
          throw new Error("real env credentials forbidden");
        },
        parsePayload: (payload) => {
          if (JSON.stringify(payload) !== '{"synthetic":true}') {
            throw new Error("non-synthetic lease payload forbidden");
          }
          return { synthetic: true };
        },
      });
      const heartbeat = credentials.startHeartbeat(lease);
      stopHeartbeat = () => heartbeat.stop();
      return {
        id: "startup-lease-fixture",
        label: "Synthetic lease",
        accountId: "sut",
        requiredPluginIds: [],
        supportedActions: [],
        sendInbound: async (input) => messages.addInboundMessage(input),
        createGatewayConfig: () => ({}),
        waitReady: async () => unexpected(),
        buildAgentDelivery: ({ target }) => ({
          channel: "startup-lease-fixture",
          to: target,
          replyChannel: "startup-lease-fixture",
          replyTo: target,
        }),
        handleAction: async () => unexpected(),
        createReportNotes: () => [],
        cleanup: async () => {
          record("transport-before-gateway-stop");
        },
        cleanupAfterGatewayStop: async () => {
          record("transport-after-gateway-stop");
          try {
            await heartbeat.stop();
          } finally {
            await lease.release();
          }
        },
      };
    },
  };
  vi.stubEnv("OPENCLAW_QA_CONVEX_SITE_URL", baseUrl);
  vi.stubEnv("OPENCLAW_QA_CONVEX_SECRET_CI", "synthetic-only");
  vi.stubEnv("OPENCLAW_QA_ALLOW_INSECURE_HTTP", "1");
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    const identity = readIdentity(root);
    if (identity && pid === -identity.pgid) {
      if (signal === 0) {
        groupProbeCount += 1;
      } else if (signal === "SIGTERM" || signal === "SIGKILL") {
        record("group-signal", { signal, denied: denyGroupSignals, ...snapshot() });
        if (denyGroupSignals) {
          throw Object.assign(new Error("synthetic EPERM for owned fixture group"), {
            code: "EPERM",
          });
        }
      }
    }
    return realKill(pid, signal);
  });
  try {
    record("suite-start", { denyGroupSignals });
    const context: QaSuiteResolvedRunContext = {
      startedAt: new Date(),
      repoRoot,
      outputDir: root,
      transportId: "qa-channel",
      selectedScenarios: [],
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      fastMode: true,
      enabledPluginIds: [],
      gatewayConfigPatches: [],
      gatewayRuntimeOptions: undefined,
      concurrency: 1,
      progressEnabled: true,
      gatewayHeapCheckpointsEnabled: false,
    };
    try {
      await runQaFlowSuiteStandard(
        {
          startLab: async () => lab,
          controlUiEnabled: false,
          channelDriver: "live",
          channelId: "startup-lease-fixture",
          adapterFactories: [factory],
          sutOpenClawCommand: {
            executablePath: process.execPath,
            argsPrefix: [fixturePath, root],
            tempParentDir,
            usePackagedPlugins: true,
          },
        },
        context,
        async () => {
          scenarioCalls += 1;
          return unexpected();
        },
      );
    } catch (error) {
      suiteError = error;
      record("suite-rejected", { error: serializeError(error), ...snapshot() });
    }
    if (denyGroupSignals) {
      const before = readFileSync(eventsPath, "utf8").match(/lease-heartbeat/g)?.length ?? 0;
      await vi.waitFor(() =>
        expect(
          readFileSync(eventsPath, "utf8").match(/lease-heartbeat/g)?.length ?? 0,
        ).toBeGreaterThan(before),
      );
    }
  } finally {
    killSpy.mockRestore();
    let cleaned: ReturnType<typeof snapshot>;
    try {
      record("fault-restored", { groupProbeCount });
      const identity = readIdentity(root);
      if (identity && alive(-identity.pgid)) {
        record("diagnostic-force-kill", snapshot());
        expect(signalQaPosixProcessGroup(identity.pgid, "SIGKILL")).toBeUndefined();
      }
      const deadline = Date.now() + 5_000;
      cleaned = snapshot();
      while (cleaned.groupAlive && Date.now() < deadline) {
        await sleep(25);
        cleaned = snapshot();
      }
      record("process-cleanup-verified", cleaned);
    } finally {
      try {
        await stopHeartbeat?.();
      } finally {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          });
        } finally {
          vi.unstubAllEnvs();
          state.reset(true);
        }
      }
    }
    const retainedGatewayRoots = await fs.readdir(tempParentDir);
    if (!cleaned.groupAlive && !cleaned.descendantAlive && !cleaned.leaderAlive) {
      await fs.rm(tempParentDir, { recursive: true, force: true });
    }
    record("cleanup-complete", {
      ...cleaned,
      brokerListening: server.listening,
      retainedGatewayRoots,
      tempParentRemoved: !existsSync(tempParentDir),
    });
    await fs.writeFile(
      path.join(root, "verdict.json"),
      `${JSON.stringify(
        {
          denyGroupSignals,
          releases,
          scenarioCalls,
          groupProbeCount,
          error: serializeError(suiteError),
          cleanup: cleaned,
          retainedGatewayRoots,
          invariantViolated: releases.some((release) => release.descendantAlive),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`startup lease evidence: ${path.relative(repoRoot, root)}`);
    expect(cleaned).toMatchObject({
      leaderAlive: false,
      descendantAlive: false,
      groupAlive: false,
    });
  }
  const events = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event);
  return { events, releases, suiteError, groupProbeCount, scenarioCalls };
}

describe.skipIf(process.platform === "win32")(
  "gateway startup lease lifetime (real process group)",
  () => {
    it.each([
      { label: "positive control: successful tree shutdown", denyGroupSignals: false },
      { label: "fault: process-group shutdown denied", denyGroupSignals: true },
    ])(
      "$label releases only after descendant exit",
      { timeout: 45_000 },
      async ({ denyGroupSignals }) => {
        const result = await reproduce(denyGroupSignals);
        expect(result.scenarioCalls).toBe(0);
        const repaired = result.events.findIndex(
          (event) => event.kind === "plugin-repair-completed",
        );
        expect(repaired).toBeGreaterThan(-1);
        expect(result.events.findIndex((event) => event.kind === "gateway-start")).toBeGreaterThan(
          repaired,
        );
        expect(result.events.filter((event) => event.kind === "gateway-start")).toHaveLength(1);
        expect(result.events.find((event) => event.kind === "leader-exit")).toMatchObject({
          exitCode: 17,
        });
        expect(result.events.some((event) => event.kind === "descendant-failsafe-exit")).toBe(
          false,
        );
        expect(result.groupProbeCount).toBeGreaterThan(0);
        const signals = result.events.filter((event) => event.kind === "group-signal");
        expect(signals.length).toBeGreaterThan(0);
        expect(
          signals.every((event) => event.leaderAlive === false && event.descendantAlive === true),
        ).toBe(true);
        const afterCleanup = result.events.findIndex(
          (event) => event.kind === "transport-after-gateway-stop",
        );
        const rejected = result.events.findIndex((event) => event.kind === "suite-rejected");
        if (denyGroupSignals) {
          expect(afterCleanup).toBe(-1);
          expect(result.releases).toEqual([]);
          expect(
            result.events.some(
              (event) => event.kind === "lease-heartbeat" && event.at > result.events[rejected]!.at,
            ),
          ).toBe(true);
        } else {
          expect(result.releases.length).toBeGreaterThan(0);
          expect(result.releases.every((release) => !release.groupAlive)).toBe(true);
          expect(afterCleanup).toBeGreaterThan(
            result.events.findLastIndex((event) => event.kind === "group-signal"),
          );
        }
        if (denyGroupSignals) {
          expect(result.suiteError).toBeInstanceOf(AggregateError);
          expect(JSON.stringify(serializeError(result.suiteError))).toContain(
            "process tree remained alive",
          );
        } else {
          expect(result.suiteError).toBeInstanceOf(Error);
        }
        expect(JSON.stringify(serializeError(result.suiteError))).toContain(
          "gateway exited before listening (exitCode=17",
        );
        expect(
          result.releases.every((release) => !release.descendantAlive),
          "credential lease released while the failed-start gateway descendant was still alive",
        ).toBe(true);
      },
    );
  },
);
