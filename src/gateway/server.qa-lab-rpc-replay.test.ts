import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  connectOk,
  getGatewayTestPort,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
  testState,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

// The public artifact crosses the plugin boundary without importing its compiler graph.
type QaGatewayFixture = {
  baseUrl: string;
  pid: number | null;
  call(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; deadlineMs?: number },
  ): Promise<unknown>;
};
type QaGatewayFixtureOwner = {
  start(params: {
    repoRoot: string;
    providerMode: "mock-openai";
    controlUiEnabled: boolean;
    transportBaseUrl: string;
    command: {
      executablePath: string;
      argsPrefix: string[];
      tempParentDir: string;
      usePackagedPlugins: boolean;
    };
    onListening: (context: { token: string }) => Promise<void>;
  }): Promise<QaGatewayFixture>;
  stop(): Promise<{ process: string; errors: unknown[] }>;
};

const qaModule = "../../extensions/qa-lab/api.js";
const { createQaGatewayChild } = (await import(qaModule)) as {
  createQaGatewayChild: () => QaGatewayFixtureOwner;
};
installGatewayTestHooks({ scope: "suite" });

type ProxyEvent = {
  sequence: number;
  kind: string;
  connection?: number;
  requestId?: string;
  key?: string;
  labelCollision?: boolean;
};
type ProxySnapshot = { events: ProxyEvent[]; held: boolean; pid: number };
type CreateOutcome = { kind: "returned"; key: string } | { kind: "rejected"; message: string };
const dirs = createTempDirTracker();
const evidence: Array<Record<string, unknown>> = [];
const owner = createQaGatewayChild();
let child: Awaited<ReturnType<typeof owner.start>>;
let backend: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
let observer: WebSocket | undefined;
let recordPath: string;
let childPid: number | null;
let stopped = false;
let token: string;

async function control(action = "snapshot"): Promise<ProxySnapshot> {
  const response = await fetch(`${child.baseUrl}/__fixture`, {
    method: "POST",
    headers: { "x-qa-fixture-token": token, "content-type": "application/json" },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`proxy control failed: ${response.status}`);
  }
  return (await response.json()) as ProxySnapshot;
}

async function create(
  params: { label?: string; displayName?: string },
  deadlineMs?: number,
): Promise<CreateOutcome> {
  try {
    const value = await child.call("sessions.create", params, { timeoutMs: 10_000, deadlineMs });
    if (!value || typeof value !== "object" || !("key" in value) || typeof value.key !== "string") {
      throw new Error("sessions.create returned no key");
    }
    return { kind: "returned", key: value.key };
  } catch (error) {
    return { kind: "rejected", message: error instanceof Error ? error.message : String(error) };
  }
}

async function verifyCommittedRows(events: ProxyEvent[]) {
  const keys = events
    .filter((event) => event.kind === "mutation-success")
    .map((event) => event.key);
  for (const key of keys) {
    expect(typeof key).toBe("string");
    const read = await rpcReq<{ session: { key: string } | null }>(observer!, "sessions.describe", {
      key,
    });
    expect(read.ok).toBe(true);
    expect(read.payload?.session?.key).toBe(key);
  }
  return keys;
}

async function holdReconnect() {
  await control("hold-reconnect");
  await vi.waitFor(async () => expect((await control()).held).toBe(true), { timeout: 10_000 });
}

beforeAll(async () => {
  vi.stubEnv("OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_LIVE_SETUP_TOKEN_VALUE", undefined);
  const root = dirs.make("qa-rpc-replay-");
  recordPath = path.join(root, "proxy-events.jsonl");
  const backendPort = await getGatewayTestPort();
  child = await owner.start({
    repoRoot: process.cwd(),
    providerMode: "mock-openai",
    controlUiEnabled: false,
    transportBaseUrl: "http://127.0.0.1:1",
    command: {
      executablePath: process.execPath,
      argsPrefix: [
        path.resolve("test/fixtures/qa-gateway-rpc-proxy.mjs"),
        String(backendPort),
        process.cwd(),
        recordPath,
      ],
      tempParentDir: root,
      usePackagedPlugins: true,
    },
    onListening: async (context) => {
      token = context.token;
      testState.gatewayAuth = { mode: "token", token };
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", token);
      backend = await startTestGatewayServer(backendPort, { auth: { mode: "token", token } });
    },
  });
  childPid = child.pid;
  observer = new WebSocket(`ws://127.0.0.1:${backendPort}`);
  trackConnectChallengeNonce(observer);
  await once(observer, "open");
  await connectOk(observer, { token, scopes: ["operator.admin"] });
  // Family loading is fixture preparation, not the RPC's behavior deadline.
  await rpcReq(observer, "sessions.create", { displayName: "QA replay setup" }, 30_000);
  await rpcReq(observer, "sessions.describe", { key: "main" }, 30_000);
}, 180_000);

beforeEach(async () => {
  testState.gatewayAuth = { mode: "token", token };
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", token);
  await control("reset");
});

afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  try {
    const result = await owner.stop();
    stopped = result.process === "confirmed-stopped";
    cleanupErrors.push(...result.errors);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (observer && observer.readyState !== WebSocket.CLOSED) {
    const closed = once(observer, "close");
    observer.terminate();
    await closed;
  }
  try {
    await backend?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  const finalEvents = recordPath
    ? (await fs.readFile(recordPath, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  dirs.cleanup();
  const output = path.resolve(".artifacts/qa-rpc-replay");
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    path.join(output, "before.json"),
    JSON.stringify(
      {
        evidence,
        cleanup: {
          stopped,
          childPid,
          remainingTempDirs: dirs.dirs.size,
          errors: cleanupErrors.map(String),
          finalEvents,
        },
      },
      null,
      2,
    ),
  );
  vi.unstubAllEnvs();
  expect(cleanupErrors).toEqual([]);
  expect(stopped).toBe(true);
}, 30_000);

describe("QA child RPC mutation dispatch", () => {
  it("creates once without a connection fault", async () => {
    const outcome = await create({ displayName: "QA replay no fault" });
    const snapshot = await control();
    const keys = await verifyCommittedRows(snapshot.events);
    evidence.push({ case: "no-fault", outcome, events: snapshot.events, keys });
    expect(outcome.kind).toBe("returned");
    expect(snapshot.events.filter((event) => event.kind === "mutation-request")).toHaveLength(1);
    expect(keys).toHaveLength(1);
  });

  it.each(["label", "displayName"] as const)(
    "does not replay a committed %s create after losing its response",
    async (field) => {
      await control("drop-response");
      const outcome = await create({ [field]: `QA replay lost response ${field}` });
      const snapshot = await control();
      const keys = await verifyCommittedRows(snapshot.events);
      evidence.push({ case: `sent-${field}`, outcome, events: snapshot.events, keys });
      expect(snapshot.events.filter((event) => event.kind === "response-dropped")).toHaveLength(1);
      expect(child.pid).toBe(childPid);
      expect
        .soft(snapshot.events.filter((event) => event.kind === "mutation-request"))
        .toHaveLength(1);
      expect.soft(keys).toHaveLength(1);
      expect.soft(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect.soft(outcome.message).toContain("gateway closed (1006");
        expect.soft(outcome.message).not.toContain("label already in use");
      }
    },
  );

  it("waits for reconnect Hello before sending an unsent mutation once", async () => {
    await holdReconnect();
    const pending = create({ displayName: "QA replay unsent" });
    await setImmediate();
    expect((await control()).events.some((event) => event.kind === "mutation-request")).toBe(false);
    await control("release-hello");
    const outcome = await pending;
    const snapshot = await control();
    const keys = await verifyCommittedRows(snapshot.events);
    evidence.push({ case: "unsent-reconnect", outcome, events: snapshot.events, keys });
    const sent = snapshot.events.filter((event) => event.kind === "mutation-request");
    const release = snapshot.events.find((event) => event.kind === "hello-released");
    expect(outcome.kind).toBe("returned");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sequence).toBeGreaterThan(release!.sequence);
    expect(keys).toHaveLength(1);
  });

  it("does not send an expired mutation after reconnect completes", async () => {
    await holdReconnect();
    const outcome = await create({ displayName: "QA replay expired" }, Date.now() + 250);
    await control("release-hello");
    await child.call("health", {}, { timeoutMs: 10_000 });
    const snapshot = await control();
    evidence.push({ case: "expired-unsent", outcome, events: snapshot.events });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.message).toContain("deadline exceeded");
    }
    expect(snapshot.events.some((event) => event.kind === "mutation-request")).toBe(false);
  });

  it("settles a pending unsent mutation when its child owner stops", async () => {
    await holdReconnect();
    const pending = create({ displayName: "QA replay stopped" });
    const result = await owner.stop();
    const outcome = await pending;
    const events: ProxyEvent[] = (await fs.readFile(recordPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    evidence.push({ case: "stop-unsent", outcome, events, process: result.process });
    expect(result).toEqual({ process: "confirmed-stopped", errors: [] });
    expect(outcome.kind).toBe("rejected");
    expect(events.some((event) => event.kind === "mutation-request")).toBe(false);
  });
});
