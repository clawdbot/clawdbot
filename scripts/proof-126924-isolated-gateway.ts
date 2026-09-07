/**
 * Isolated-Gateway proof for PR #126924, composed with main's restart recovery.
 *
 * Requires a build:
 *   pnpm tsx scripts/proof-126924-isolated-gateway.ts
 *   pnpm tsx scripts/proof-126924-isolated-gateway.ts --control
 *
 * A real parent calls sessions_spawn through a real, temporary Gateway. The
 * initial child's model request is in flight when that Gateway is killed.
 * Restart recovery replaces the interrupted run with a higher generation for
 * the SAME child session. The proof follows that explicit replacement instead
 * of waiting on the retired run ID. No registry or task rows are written here.
 *
 * The only fake is the repository's loopback OpenAI provider. Before restart,
 * its existing hold/release control holds the recovery response. This lets the
 * real recovered run's registry wait expire while its HTTP request remains
 * in flight. After observing the nonterminal marker and retained running task,
 * the proof releases that SAME request and requires a succeeded task. It does
 * not create another child turn to manufacture fresh completion evidence.
 *
 * The original process does not survive SIGKILL. The continuous live request
 * proven across expiry and completion belongs to the recovery generation.
 * Gateway transport, sessions_spawn, registry, sweeper and SQLite are real.
 * Every assertion reads the isolated Gateway's durable state read-only.
 * No hosted model, operator config, live Gateway or credentials are used.
 *
 * Control: without restart, the Gateway observes its child's hard timeout and
 * publishes exited/timed_out. Main: with recovery, an expired registry wait
 * remains nonterminal, then the actual recovered child's completion succeeds.
 * Both runs must pass; a clock-only terminal transition fails the main run.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const repoRoot = process.env.PROOF_REPO_ROOT ?? process.cwd();
const entry = path.join(repoRoot, "dist", "entry.js");
const mockServer = path.join(repoRoot, "scripts", "e2e", "mock-openai-server.mjs");

// The whole point of the scenario: the child's model call must outlast the
// parent's run deadline by a wide, unambiguous margin.
const RUN_TIMEOUT_SECONDS = 30;
const CHILD_MODEL_DELAY_MS = 150_000;
const PARENT_SESSION_KEY = "agent:main:proof-126924-parent";
const CHILD_TASK_MARKER = "PROOF126924CHILDTASK";
const CHILD_FINAL_TEXT = "PROOF126924 child finished after the parent wait had already expired.";
// `--control` runs the same scenario without the restart, so the observed-stop
// disposition and the unobserved one come out of one harness.
const CONTROL_MODE = process.argv.includes("--control");

const log = (message: string) => process.stdout.write(`${message}\n`);

function buildFunctionCallEvents(name: string, args: Record<string, unknown>) {
  // Same wire shape the mock's own `toolCallEvents` produces; passed through the
  // mock's `events` passthrough so the tool call is scripted, not inferred.
  const serialized = JSON.stringify(args);
  const callId = `call_proof126924_${name}`;
  const itemId = `fc_proof126924_${name}`;
  const item = { type: "function_call", id: itemId, call_id: callId, name, arguments: serialized };
  return [
    {
      type: "response.output_item.added",
      item: { type: "function_call", id: itemId, call_id: callId, name, arguments: "" },
    },
    { type: "response.function_call_arguments.delta", delta: serialized },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: `resp_proof126924_${name}`,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 64,
          output_tokens: 16,
          total_tokens: 80,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function captureOutput(child: ChildProcessWithoutNullStreams) {
  let buffer = "";
  const append = (chunk: Buffer) => {
    buffer = `${buffer}${chunk.toString()}`.slice(-512 * 1024);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return () => buffer;
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for: ${description}`);
}

type RegistryRow = {
  runId: string;
  childSessionKey?: string;
  generation?: number;
  execution: {
    status?: string;
    startedAt?: number;
    endedAt?: number;
    outcome?: { status?: string; disposition?: string };
  };
  endedReason?: string;
  waitExpiryObservedAt?: number;
};

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-126924-gw-"));
const statePath = path.join(stateRoot, "state", "state", "openclaw.sqlite");
const requestLogPath = path.join(stateRoot, "mock-requests.jsonl");
const responseControlPath = path.join(stateRoot, "mock-responses.json");

let mock: ChildProcessWithoutNullStreams | undefined;
let gateway: ChildProcessWithoutNullStreams | undefined;
let readGatewayOutput: () => string = () => "";
let exitCode = 0;

/** Read the gateway's own persisted registry rows, read-only, from outside it. */
function readRegistryRows(): RegistryRow[] {
  if (!fs.existsSync(statePath)) {
    return [];
  }
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const rows = db
      .prepare("select run_id, child_session_key, payload_json from subagent_runs")
      .all() as Array<{ run_id: string; child_session_key: string; payload_json: string }>;
    return rows.map((row) => {
      const record = JSON.parse(row.payload_json) as RegistryRow;
      record.runId = row.run_id;
      record.childSessionKey = row.child_session_key;
      return record;
    });
  } catch {
    // The gateway may be mid-write or the table may not exist yet.
    return [];
  } finally {
    db.close();
  }
}

/** The gateway's own detached-task projection — what a parent or operator reads. */
function readTaskStatus(childSessionKey: string): string | undefined {
  if (!fs.existsSync(statePath)) {
    return undefined;
  }
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const row = db
      .prepare("select status from task_runs where child_session_key = ? order by created_at desc")
      .get(childSessionKey) as { status?: string } | undefined;
    return row?.status;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function readMockRequests(): Array<Record<string, unknown>> {
  if (!fs.existsSync(requestLogPath)) {
    return [];
  }
  return fs
    .readFileSync(requestLogPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

try {
  const [gatewayPort, mockPort] = await Promise.all([freePort(), freePort()]);

  // The scripted provider. Index 0 and 1 are the parent's two turns (the
  // `sessions_spawn` call, then its wrap-up); everything after falls to the
  // slow default, which is what the child receives.
  fs.writeFileSync(
    responseControlPath,
    JSON.stringify({
      responses: [
        {
          events: buildFunctionCallEvents("sessions_spawn", {
            task: `${CHILD_TASK_MARKER}: take your time and then report back.`,
            label: "proof-126924 child",
            mode: "run",
            cleanup: "keep",
            runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
          }),
        },
        { text: "Spawned the child; nothing else to do." },
      ],
      default: { text: CHILD_FINAL_TEXT, chunkDelayMs: CHILD_MODEL_DELAY_MS },
    }),
  );

  const configPath = path.join(stateRoot, "openclaw.json");
  const config: Record<string, unknown> = {
    browser: { enabled: false },
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "none" },
      controlUi: { enabled: false },
      tailscale: { mode: "off" },
    },
    plugins: { enabled: false },
  };
  applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-5.6-luna" });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  mock = spawn(process.execPath, [mockServer], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      MOCK_PORT: String(mockPort),
      MOCK_REQUEST_LOG: requestLogPath,
      MOCK_RESPONSE_CONTROL: responseControlPath,
    },
  });
  captureOutput(mock);
  await waitFor(
    "the mock provider to listen",
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${mockPort}/v1/models`);
        return res.ok || res.status === 404;
      } catch {
        return false;
      }
    },
    30_000,
  );
  log(`[boot] mock provider listening on ${mockPort}`);

  const startGateway = async (label: string) => {
    gateway = spawn(
      process.execPath,
      [
        entry,
        "gateway",
        "run",
        "--port",
        String(gatewayPort),
        "--bind",
        "loopback",
        "--auth",
        "none",
        "--tailscale",
        "off",
        "--allow-unconfigured",
      ],
      {
        cwd: repoRoot,
        env: {
          CI: "1",
          PATH: process.env.PATH,
          LANG: process.env.LANG ?? "en_US.UTF-8",
          HOME: stateRoot,
          NO_COLOR: "1",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_HOME: stateRoot,
          OPENCLAW_STATE_DIR: path.join(stateRoot, "state"),
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_TEST_DISABLE_UPDATE_CHECK: "1",
          OPENAI_API_KEY: "proof-126924-isolated-gateway",
        },
      },
    );
    readGatewayOutput = captureOutput(gateway);
    await waitFor(
      `the ${label} gateway to report ready`,
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`);
          return res.status === 200;
        } catch {
          return false;
        }
      },
      120_000,
    );
    log(`[boot] ${label} gateway ready on ${gatewayPort}`);
  };
  await startGateway("first");

  const protocol = (await import(
    pathToFileURL(path.join(repoRoot, "dist", "gateway", "protocol", "index.js")).href
  )) as { PROTOCOL_VERSION: number };
  type Rpc = <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;
  let client: ReturnType<typeof createGatewayWsClient> | undefined;
  let rpc: Rpc = async () => {
    throw new Error("gateway client is not connected");
  };
  const connectClient = async () => {
    client?.close();
    const next = createGatewayWsClient({ url: `ws://127.0.0.1:${gatewayPort}` });
    await next.waitOpen();
    client = next;
    rpc = async <T>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> => {
      const response = await next.request(method, params, timeoutMs);
      if (!response.ok) {
        throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
      }
      return response.payload as T;
    };
    await rpc("connect", {
      minProtocol: protocol.PROTOCOL_VERSION,
      maxProtocol: protocol.PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "proof-126924-isolated-gateway",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
    });
  };
  await connectClient();

  // ------------------------------------------------------------ assertion 1
  const parentStartedAt = Date.now();
  const started = await rpc<{ runId?: string; status?: string }>("agent", {
    sessionKey: PARENT_SESSION_KEY,
    message: "Delegate the long task to a subagent.",
    deliver: false,
    idempotencyKey: randomUUID(),
  });
  if (started.status === "accepted") {
    await rpc("agent.wait", { runId: started.runId, timeoutMs: 90_000 }, 120_000);
  }
  await waitFor(
    "the real sessions_spawn tool to create a registry row",
    () => readRegistryRows().some((row) => Boolean(row.childSessionKey)),
    90_000,
  );
  const spawnedRow = readRegistryRows().find((row) => Boolean(row.childSessionKey));
  assert.ok(spawnedRow?.childSessionKey, "the parent turn must really have spawned a child");
  const childSessionKey = spawnedRow.childSessionKey;
  let childRunId = spawnedRow.runId;
  const originalRunId = childRunId;
  log(
    `[1/5] real parent turn spawned a real child: runId=${childRunId} childSessionKey=${childSessionKey}`,
  );

  // ---------------------------------------------------------------- restart
  // Control mode skips the restart: the same harness, the same slow child, a
  // gateway that never loses sight of the run. It must reach the OTHER
  // disposition, which is what makes the restarted run's disposition mean
  // something.
  if (!CONTROL_MODE) {
    await delay(8_000);
    const preRestartRow = readRegistryRows().find((row) => row.runId === childRunId);
    assert.equal(
      preRestartRow?.execution.endedAt,
      undefined,
      "the child's run must still be in flight when the gateway is killed",
    );
    assert.ok(
      readMockRequests().some((request) => JSON.stringify(request).includes(CHILD_TASK_MARKER)),
      "the child's own model request must already be in flight at the restart",
    );
    // Future recovery requests reserve their final response, but cannot finish
    // until the proof releases the mock after observing the expired wait.
    fs.writeFileSync(responseControlPath, JSON.stringify({ hold: true, text: CHILD_FINAL_TEXT }));
    const requestsBeforeRestart = readMockRequests().length;
    gateway?.kill("SIGKILL");
    await delay(2_000);
    await startGateway("restarted");
    await connectClient();
    await waitFor(
      "restart recovery to replace the interrupted run for the same child",
      () =>
        readRegistryRows().some(
          (row) =>
            row.childSessionKey === childSessionKey &&
            row.runId !== originalRunId &&
            (row.generation ?? 0) > (spawnedRow.generation ?? 0),
        ),
      60_000,
    );
    const recovered = readRegistryRows().find(
      (row) => row.childSessionKey === childSessionKey && row.runId !== originalRunId,
    );
    assert.ok(recovered, "restart recovery must retain the original child identity");
    childRunId = recovered.runId;
    assert.ok((recovered.generation ?? 0) > (spawnedRow.generation ?? 0));
    assert.equal(recovered.execution.endedAt, undefined);
    await waitFor(
      "the recovered child's actual provider request to be held in flight",
      () =>
        readMockRequests()
          .slice(requestsBeforeRestart)
          .some((request) => JSON.stringify(request).includes(CHILD_TASK_MARKER)),
      30_000,
    );
    log(`[2/5] restarted Gateway recovered ${originalRunId} as ${childRunId}`);
  } else {
    log("[2/5] control mode: no restart; this gateway keeps observing its own child run");
  }

  // ------------------------------------------------------------ assertion 3
  await waitFor(
    "the restored wait to expire on the run deadline",
    () => {
      const row = readRegistryRows().find((candidate) => candidate.runId === childRunId);
      return CONTROL_MODE
        ? row?.execution.outcome?.status === "timeout"
        : row?.waitExpiryObservedAt !== undefined;
    },
    (RUN_TIMEOUT_SECONDS + 60) * 1_000,
    500,
  );
  const expiredRow = readRegistryRows().find((row) => row.runId === childRunId);
  const disposition = expiredRow?.execution.outcome?.disposition ?? "exited";
  const expiredTaskStatus = readTaskStatus(childSessionKey);
  if (CONTROL_MODE) {
    assert.equal(
      disposition,
      "exited",
      `a gateway that observed its own child's stop must record exited (saw ${disposition})`,
    );
    assert.equal(
      expiredTaskStatus,
      "timed_out",
      "an observed stop is publishable as a terminal timeout",
    );
    log(
      `[3/5] control: disposition=exited, detached task=timed_out — the observed-stop path still terminalizes`,
    );
    log("");
    log("All isolated-Gateway control assertions passed.");
  } else {
    assert.equal(typeof expiredRow?.waitExpiryObservedAt, "number");
    assert.equal(expiredRow?.execution.endedAt, undefined);
    log(
      `[3/5] the restored wait expired on the deadline with a nonterminal expiry observation after ~${Math.round((Date.now() - parentStartedAt) / 1_000)}s`,
    );

    // ---------------------------------------------------------- assertion 4
    await delay(4_000);
    const retainedRow = readRegistryRows().find((row) => row.runId === childRunId);
    assert.ok(retainedRow, "the unconfirmed row must not be retired by a clock");
    assert.equal(
      retainedRow?.execution.endedAt,
      undefined,
      "the row must stay provisional until something observes a stop",
    );
    assert.equal(
      readTaskStatus(childSessionKey),
      "running",
      "the recovered child's task must remain running while its provider response is held",
    );
    log(
      `[4/5] fail-closed: row retained, detached task="${String(readTaskStatus(childSessionKey))}" (the control run reaches "timed_out" here)`,
    );

    // ---------------------------------------------------------- assertion 5
    // Release the already in-flight recovery request. Its own real lifecycle,
    // not a synthetic follow-up turn or a direct store write, supplies the stop.
    fs.writeFileSync(responseControlPath, JSON.stringify({ hold: false, text: CHILD_FINAL_TEXT }));
    // The promotion is observed on the durable projection a parent or operator
    // actually reads. A row promoted through the ordinary lifecycle is then
    // retired by the ordinary owner, so "the registry row is gone" is not by
    // itself the interesting fact — what the provisional state had to protect is
    // the task's ability to publish a non-timeout terminal outcome afterwards.
    await waitFor(
      "the child's own settled record to terminalize the detached task",
      () => {
        const status = readTaskStatus(childSessionKey);
        return status !== undefined && status !== "running" && status !== "queued";
      },
      120_000,
      500,
    );
    const finalTaskStatus = readTaskStatus(childSessionKey);
    assert.equal(
      finalTaskStatus,
      "succeeded",
      "the same recovered child's real successful completion must remain publishable",
    );
    const finalRow = readRegistryRows().find((row) => row.runId === childRunId);
    assert.ok(
      !finalRow || typeof finalRow.execution.endedAt === "number",
      "the row must not still be provisional after its child settled",
    );
    log(
      `[5/5] the child's own real completion promoted the run: detached task="${finalTaskStatus}" (not timed_out), registry row ${finalRow ? `promoted to ${JSON.stringify(finalRow.execution.outcome)}` : "retired by the ordinary terminal owner after promotion"}`,
    );
    log("");
    log("All isolated-Gateway assertions passed.");
  }
} catch (error) {
  exitCode = 1;
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.stderr.write(`--- gateway output tail ---\n${readGatewayOutput().slice(-8_000)}\n`);
} finally {
  gateway?.kill("SIGKILL");
  mock?.kill("SIGKILL");
  fs.rmSync(stateRoot, { recursive: true, force: true });
}
process.exit(exitCode);
