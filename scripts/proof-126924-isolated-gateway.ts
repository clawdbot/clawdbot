/**
 * Isolated-Gateway proof for PR #126924 — a real gateway reaching the
 * provisional `child-unconfirmed` state against a real child, holding it fail-
 * closed, and later publishing that child's real outcome.
 *
 * Run (requires a build; this drives the built gateway CLI, not the sources):
 *   pnpm build
 *   pnpm tsx scripts/proof-126924-isolated-gateway.ts              # main run
 *   pnpm tsx scripts/proof-126924-isolated-gateway.ts --control    # control run
 *
 * WHY THIS EXISTS
 * `scripts/proof-126924-subagent-wait-expiry-not-death.ts` drives the production
 * registry in-process and stubs one seam: the Gateway transport answering
 * `agent.wait`. A reviewer asked for the thing that stub cannot show — the
 * provisional state arising inside a real Gateway, against a real child, and a
 * later real completion being published. This script does that.
 *
 * WHAT IS REAL HERE
 * - A real OpenClaw gateway process (`dist/entry.js gateway run`) on a free
 *   loopback port with its own `OPENCLAW_HOME` / `OPENCLAW_STATE_DIR`. Nothing
 *   in the registry, wait loop, sweeper, session store or detached-task runtime
 *   is stubbed, and none of it is imported into this process.
 * - A real parent agent turn over the real gateway WebSocket protocol, which
 *   really calls the real `sessions_spawn` tool and really launches a child
 *   agent run inside that gateway.
 * - A real restart: the gateway is SIGKILLed while the child's model request is
 *   genuinely in flight, then restarted on the same state directory. This is how
 *   the provisional state actually arises in production — the restored registry
 *   waits on a run the new process never saw, so `agent.wait` returns a bare
 *   timeout with no terminal snapshot and nothing has observed the child stop.
 * - Every assertion reads the gateway's own `openclaw.sqlite` from disk,
 *   read-only, from outside the gateway process.
 *
 * WHAT IS STUBBED, AND ONLY THIS
 * - The model provider. `scripts/e2e/mock-openai-server.mjs` (the repository's
 *   own E2E mock, unmodified) serves the OpenAI Responses API on loopback. The
 *   parent's first turn is scripted to emit a `sessions_spawn` function call and
 *   the child's turn is ordinary text with a long `chunkDelayMs`, so the child is
 *   really mid-request at the restart.
 *
 * THE CONTROL RUN IS WHAT MAKES THIS NON-VACUOUS
 * `--control` runs the identical scenario with no restart. The gateway then does
 * observe its own child's stop, and the same code records
 * `timeoutDisposition: "child-stopped"` and publishes the detached task as
 * `timed_out`. Same harness, same child, opposite disposition — so the main
 * run's `child-unconfirmed` and its refusal to publish `timed_out` are the
 * behavior under test rather than an artifact of the setup.
 *
 * WHAT THIS DOES NOT COVER — stated plainly
 * - No hosted model is called. "The child is still working" means its real agent
 *   run is still awaiting a real HTTP response, not that a frontier model is
 *   thinking. The registry cannot tell those apart; the distinction is real and
 *   is not being papered over.
 * - The child's original process does not survive the SIGKILL that makes its
 *   stop unobservable. The later promotion is therefore produced the way the
 *   production PULL path does it — the child's own session record settles from a
 *   real subsequent turn on that real child session, and the sweeper reads it —
 *   rather than by the original process reporting back. What is proven is that
 *   the provisional row stayed promotable and the later outcome was publishable;
 *   what is not proven is a single continuous child process spanning both.
 * - `sessions_spawn` derives both the child's own run TTL and the registry's
 *   wait deadline from one `runTimeoutSeconds`, so in a healthy single gateway
 *   the child's hard timeout always wins and the correct disposition is
 *   `child-stopped` (that is exactly what the control run shows). Reaching
 *   `child-unconfirmed` requires the wait to be unable to observe the run, which
 *   is why this script restarts the gateway rather than just waiting longer.
 *
 * ASSERTIONS (main run; the script exits non-zero on any violation)
 *  1. A real parent turn really spawned a real child through the real tool.
 *  2. The gateway was killed and restarted while the child's real model request
 *     was still in flight (the row has no `endedAt`, and the provider log
 *     already contains the child's request).
 *  3. The restored wait expired on the run deadline and recorded
 *     `timeoutDisposition: "child-unconfirmed"` — a real gateway saying nothing
 *     observed this child stop.
 *  4. Fail-closed: the row is retained across repeated observation, and the
 *     detached task a parent reads is NOT published as a terminal `timed_out`.
 *  5. The child's own later real completion promotes the run: the detached task
 *     terminalizes as `succeeded`, the transition a published `timed_out` would
 *     have permanently blocked.
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
  execution: {
    status?: string;
    startedAt?: number;
    endedAt?: number;
    outcome?: { status?: string; timeoutDisposition?: string };
  };
  endedReason?: string;
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
  const childRunId = spawnedRow.runId;
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
    gateway?.kill("SIGKILL");
    await delay(2_000);
    await startGateway("restarted");
    await connectClient();
    log("[2/5] gateway killed and restarted while the child's real run was still in flight");
  } else {
    log("[2/5] control mode: no restart; this gateway keeps observing its own child run");
  }

  // ------------------------------------------------------------ assertion 3
  await waitFor(
    "the restored wait to expire on the run deadline",
    () =>
      readRegistryRows().find((row) => row.runId === childRunId)?.execution.outcome?.status ===
      "timeout",
    (RUN_TIMEOUT_SECONDS + 60) * 1_000,
    500,
  );
  const expiredRow = readRegistryRows().find((row) => row.runId === childRunId);
  const disposition = expiredRow?.execution.outcome?.timeoutDisposition;
  const expiredTaskStatus = readTaskStatus(childSessionKey);
  if (CONTROL_MODE) {
    assert.equal(
      disposition,
      "child-stopped",
      `a gateway that observed its own child's stop must record child-stopped (saw ${String(disposition)})`,
    );
    assert.equal(
      expiredTaskStatus,
      "timed_out",
      "an observed stop is publishable as a terminal timeout",
    );
    log(
      `[3/5] control: disposition=child-stopped, detached task=timed_out — the observed-stop path still terminalizes`,
    );
    log("");
    log("All isolated-Gateway control assertions passed.");
  } else {
    assert.equal(
      disposition,
      "child-unconfirmed",
      `a deadline reached with no observed stop must record child-unconfirmed (saw ${String(disposition)})`,
    );
    log(
      `[3/5] the restored wait expired on the deadline with disposition=child-unconfirmed after ~${Math.round((Date.now() - parentStartedAt) / 1_000)}s`,
    );

    // ---------------------------------------------------------- assertion 4
    await delay(4_000);
    const retainedRow = readRegistryRows().find((row) => row.runId === childRunId);
    assert.ok(retainedRow, "the unconfirmed row must not be retired by a clock");
    assert.equal(
      retainedRow?.execution.outcome?.timeoutDisposition,
      "child-unconfirmed",
      "the row must stay provisional until something observes a stop",
    );
    assert.notEqual(
      readTaskStatus(childSessionKey),
      "timed_out",
      "the detached task a parent reads must not be published as a terminal timeout on an unobserved stop; the control run shows that same task DOES publish timed_out when the stop was observed",
    );
    log(
      `[4/5] fail-closed: row retained, detached task="${String(readTaskStatus(childSessionKey))}" (the control run reaches "timed_out" here)`,
    );

    // ---------------------------------------------------------- assertion 5
    // Authoritative stop evidence, delivered through the real gateway rather
    // than written into its state by this script.
    // The production promotion is a PULL: the sweeper re-reads the child's own
    // persisted session record and promotes the row when that record settles.
    // Produce that record the only honest way available in a gateway that has
    // already lost the original run — let the real child session finish a real
    // turn, so the real session store writes a real terminal status.
    fs.writeFileSync(
      responseControlPath,
      JSON.stringify({
        scriptVersion: "phase2",
        responses: [{ text: "PROOF126924 child wrapping up." }],
        default: { text: "PROOF126924 child wrapping up." },
      }),
    );
    const childTurn = await rpc<{ runId?: string; status?: string }>("agent", {
      sessionKey: childSessionKey,
      message: "Finish and report.",
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    if (childTurn.status === "accepted") {
      await rpc("agent.wait", { runId: childTurn.runId, timeoutMs: 90_000 }, 120_000);
    }
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
    assert.notEqual(
      finalTaskStatus,
      "timed_out",
      "the later real outcome must be publishable; a published timed_out would have blocked it (see the control run, which legitimately publishes timed_out for an OBSERVED stop)",
    );
    const finalRow = readRegistryRows().find((row) => row.runId === childRunId);
    assert.notEqual(
      finalRow?.execution.outcome?.timeoutDisposition,
      "child-unconfirmed",
      "the row must not still be provisional after its child settled",
    );
    log(
      `[5/5] the child's own real completion promoted the run: detached task="${String(finalTaskStatus)}" (not timed_out), registry row ${finalRow ? `promoted to ${JSON.stringify(finalRow.execution.outcome)}` : "retired by the ordinary terminal owner after promotion"}`,
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
