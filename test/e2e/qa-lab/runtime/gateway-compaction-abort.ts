import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  COMPACTION_PROOF_MODEL_ID as MODEL_ID,
  COMPACTION_PROOF_MODEL_REF as MODEL_REF,
  COMPACTION_PROOF_TIMEOUT_MS as CHECKPOINT_TIMEOUT_MS,
  createCompactionProofCase,
  recordCompactionProofCheckpoint,
  stageCompactionProofHook,
  startCompactionProofProvider,
  waitForCompactionProofCheckpoint,
  type CompactionProofCase as ProofCase,
} from "./gateway-compaction-provider.fixture.js";
import {
  assertCommittedCompactionHistory as assertCommittedHistory,
  assertOriginalCompactionRows as assertOriginalRows,
  assertReplacementWriterPreserved,
  assertUncommittedCompactionHistory as assertUncommittedHistory,
  readCompactionEntry as canonicalEntry,
  replaceCompactionWriter as replaceWriter,
  seedCompactionTranscript as seedTranscript,
  snapshotCompactionSession as snapshot,
  waitForCompactionReply,
  waitForCompactionRunSettlement,
  waitForHeldCompactionAccounting,
  type CompactionProofSnapshot as Snapshot,
} from "./gateway-compaction-state.fixture.js";

const SCENARIO_ID = "gateway-compaction-abort";

async function requireOwnedEnvironment() {
  const tmp = process.env.TMPDIR;
  assert.ok(tmp && path.isAbsolute(tmp), "Outer launcher must own TMPDIR before imports");
  const root = await fs.realpath(tmp);
  for (const name of [
    "HOME",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_OAUTH_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ]) {
    const value = process.env[name];
    assert.ok(value && path.isAbsolute(value), `Outer launcher must set ${name} before imports`);
    const relative = path.relative(root, value);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      `${name} must be inside the owned TMPDIR`,
    );
  }
  assert.equal(process.env.OPENCLAW_HOME, process.env.HOME);
  assert.equal(process.env.TMP, tmp);
  assert.equal(process.env.TEMP, tmp);
  return root;
}

async function loadRuntime() {
  const [qa, sessions, store, transcript, guards, evidence, writer, hostStore] = await Promise.all([
    import("../../../../extensions/qa-lab/api.js"),
    import("openclaw/plugin-sdk/agent-sessions"),
    import("openclaw/plugin-sdk/session-store-runtime"),
    import("openclaw/plugin-sdk/session-transcript-runtime"),
    import("openclaw/plugin-sdk/string-coerce-runtime"),
    import("./script-evidence.js"),
    import("../../../../src/agents/embedded-agent-runner/run/session-bootstrap.js"),
    import("../../../../src/config/sessions/session-accessor.js"),
  ]);
  return {
    qa,
    sessions,
    store,
    transcript,
    isRecord: guards.isRecord,
    evidence,
    claimAgentSessionWriter: writer.claimAgentSessionWriter,
    loadSessionEntry: hostStore.loadSessionEntry,
    resolveSessionTranscriptDatabasePath: hostStore.resolveSessionTranscriptDatabasePath,
  };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

async function abortChat(
  runtime: Runtime,
  gateway: QaGatewayChild,
  proof: ProofCase,
  runId: string,
) {
  proof.aborted = true;
  recordCompactionProofCheckpoint(proof, "chat.abort-requested");
  const aborted = await gateway.call("chat.abort", { sessionKey: proof.sessionKey, runId });
  assert.ok(
    runtime.isRecord(aborted) &&
      aborted.aborted === true &&
      Array.isArray(aborted.runIds) &&
      aborted.runIds.includes(runId),
    "chat.abort did not cancel the exact held run",
  );
  recordCompactionProofCheckpoint(proof, "chat.abort-acknowledged");
  return aborted;
}

async function startChat(
  runtime: Runtime,
  gateway: QaGatewayChild,
  proof: ProofCase,
  marker: string,
) {
  const result = await gateway.call("chat.send", {
    sessionKey: proof.sessionKey,
    message: `Reply with only this exact marker: ${marker}`,
    idempotencyKey: randomUUID(),
    deliver: true,
    originatingChannel: "qa-channel",
    originatingTo: "dm:qa-operator",
  });
  assert.ok(
    runtime.isRecord(result) && typeof result.runId === "string",
    "chat.send omitted its runId",
  );
  return result.runId;
}

async function terminal(runtime: Runtime, gateway: QaGatewayChild, runId: string) {
  const result = await gateway.call(
    "agent.wait",
    { runId, timeoutMs: CHECKPOINT_TIMEOUT_MS },
    { timeoutMs: CHECKPOINT_TIMEOUT_MS + 5_000 },
  );
  assert.ok(runtime.isRecord(result), "agent.wait omitted its result");
  assert.ok(
    result.status === "ok" || result.status === "error",
    `Run did not reach a terminal outcome: ${JSON.stringify(result)}`,
  );
  return result;
}

async function runCases(runtime: Runtime, repoRoot: string, artifactBase: string, tmpRoot: string) {
  const state = runtime.qa.createQaBusState();
  const transport = runtime.qa.createQaChannelTransport(state);
  const bus = await runtime.qa.startQaBusServer({ state });
  let provider: Awaited<ReturnType<typeof startCompactionProofProvider>> | undefined;
  const owner = runtime.qa.createQaGatewayChild();
  const failures: string[] = [];
  let active: ProofCase | undefined;
  let retainedGateway: QaGatewayChild | undefined;
  try {
    provider = await startCompactionProofProvider(runtime.isRecord);
    const providerBaseUrl = provider.baseUrl;
    const gateway = await owner.start({
      repoRoot,
      command: {
        executablePath: process.execPath,
        argsPrefix: [path.join(repoRoot, "dist", "index.js")],
        tempParentDir: tmpRoot,
      },
      transport,
      transportBaseUrl: bus.baseUrl,
      providerBaseUrl: provider.baseUrl,
      providerMode: "mock-openai",
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      forcedRuntime: "openclaw",
      controlUiEnabled: false,
      thinkingDefault: "off",
      mutateConfig: (config) => {
        const workspaceDir = config.agents?.defaults?.workspace;
        assert.ok(workspaceDir && path.isAbsolute(workspaceDir), "QA workspace must be explicit");
        assert.ok(
          workspaceDir.startsWith(`${tmpRoot}${path.sep}`),
          "Hook fixture escaped the owned namespace",
        );
        const hookName = stageCompactionProofHook(workspaceDir, providerBaseUrl);
        return {
          ...config,
          hooks: { internal: { enabled: true, entries: { [hookName]: { enabled: true } } } },
          cron: { ...config.cron, enabled: false },
          memory: { ...config.memory, search: { ...config.memory?.search, enabled: false } },
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              heartbeat: { every: "0m" },
              compaction: { mode: "default", memoryFlush: { enabled: false } },
            },
          },
        };
      },
    });
    retainedGateway = gateway;
    assert.equal(
      gateway.runtimeEnv.OPENCLAW_QA_STAGED_RUNTIME_ROOT,
      path.join(repoRoot, ".artifacts", "qa-runtime", path.basename(gateway.tempRoot)),
      "Gateway staging root did not match its owned runtime",
    );
    const selectedProvider = gateway.cfg.models?.providers?.["mock-openai"];
    const selectedModel = selectedProvider?.models.find((model) => model.id === MODEL_ID);
    assert.equal(
      selectedProvider?.baseUrl,
      provider.baseUrl,
      "Gateway changed the provider API prefix",
    );
    assert.equal(
      selectedModel?.api,
      "openai-responses",
      "Fixture selected a different provider protocol",
    );
    assert.ok(
      typeof selectedModel?.contextWindow === "number" && selectedModel.contextWindow > 0,
      "Fixture model omitted its context window",
    );
    await transport.waitReady({ gateway, timeoutMs: CHECKPOINT_TIMEOUT_MS });
    await waitForCompactionProofCheckpoint(
      provider.hookReady,
      "the loaded internal hook startup event",
    );
    for (const mode of [
      "cancel",
      "writer-replaced",
      "active-failure",
      "success",
      "cancelled-after-commit",
    ] as const) {
      const proof = createCompactionProofCase(mode);
      active = proof;
      provider.arm(proof);
      const evidence: Record<string, unknown> = {
        mode,
        sessionKey: proof.sessionKey,
        modelContextWindow: selectedModel.contextWindow,
        timeline: proof.timeline,
      };
      const interrupted = mode !== "active-failure" && mode !== "success";
      const uncommitted = mode === "cancel" || mode === "writer-replaced";
      const invariantFailures: string[] = [];
      evidence.invariantFailures = invariantFailures;
      let runtimeSettled = false;
      let replacementEntry: ReturnType<typeof canonicalEntry> | undefined;
      let committed: Snapshot | undefined;
      const inspectInvariant = (assertion: () => void) => {
        try {
          assertion();
        } catch (error) {
          invariantFailures.push(error instanceof Error ? error.message : String(error));
        }
      };
      try {
        await seedTranscript(runtime, gateway, proof);
        const before = snapshot(runtime, gateway, proof);
        evidence.before = before;
        assert.equal(
          before.toolChars,
          180_000,
          "Fixture must retain the entire oversized tool result",
        );
        assert.equal(
          before.activeTool.length,
          1,
          "Fixture must have one paired retained tool result",
        );
        const runId = await startChat(runtime, gateway, proof, proof.finalMarker);
        evidence.runId = runId;
        await waitForCompactionProofCheckpoint(
          proof.overflowSeen.promise,
          "the real provider context overflow",
        );
        await waitForCompactionProofCheckpoint(
          proof.summaryHeld.promise,
          "the actual compaction summary request",
        );
        const held = snapshot(runtime, gateway, proof);
        evidence.held = held;
        assertUncommittedHistory(before, held);
        if (mode === "cancel") {
          evidence.abort = await abortChat(runtime, gateway, proof, runId);
          const cancellation = snapshot(runtime, gateway, proof);
          evidence.cancellation = cancellation;
          inspectInvariant(() => assertUncommittedHistory(held, cancellation));
        } else if (mode === "writer-replaced") {
          replacementEntry = await replaceWriter(runtime, gateway, proof, runId);
          evidence.replacementEntry = replacementEntry;
        }
        recordCompactionProofCheckpoint(proof, "release-summary");
        proof.releaseSummary.resolve();
        await waitForCompactionProofCheckpoint(
          proof.summarySettled.promise,
          "held HTTP summary handler settlement",
        );
        let ended: Awaited<ReturnType<typeof terminal>>;
        if (mode === "cancelled-after-commit") {
          await waitForCompactionProofCheckpoint(
            proof.afterHookHeld.promise,
            "the real session:compact:after hook",
          );
          committed = snapshot(runtime, gateway, proof);
          evidence.committedBeforeAbort = committed;
          assert.equal(
            committed.compactionIds.length,
            1,
            "After hook ran without a SQLite compaction",
          );
          assertOriginalRows(held, committed);
          recordCompactionProofCheckpoint(proof, "sqlite-compaction-observed");
          const committedSnapshot = committed;
          try {
            evidence.abort = await abortChat(runtime, gateway, proof, runId);
            ended = await terminal(runtime, gateway, runId);
            try {
              evidence.entryWhileHookHeld = await waitForHeldCompactionAccounting(
                runtime,
                gateway,
                proof,
              );
            } catch (error) {
              invariantFailures.push(error instanceof Error ? error.message : String(error));
            }
            const abortedWhileHookHeld = snapshot(runtime, gateway, proof);
            evidence.abortedWhileHookHeld = abortedWhileHookHeld;
            recordCompactionProofCheckpoint(proof, "aborted-bookkeeping-observed-while-hook-held", {
              compactionCount: abortedWhileHookHeld.compactionCount,
              afterHookPending: proof.afterHookPending,
            });
            // The auxiliary compactor may outlive the outer lane. Its unfinished
            // after hook must not hide a compaction that already committed.
            inspectInvariant(() => assertCommittedHistory(committedSnapshot, abortedWhileHookHeld));
          } finally {
            recordCompactionProofCheckpoint(proof, "release-after-hook");
            proof.releaseAfterHook.resolve();
          }
          await waitForCompactionProofCheckpoint(
            proof.afterHookSettled.promise,
            "released after-hook work settlement",
          );
        } else {
          ended = await terminal(runtime, gateway, runId);
        }
        evidence.terminal = ended;
        const afterTerminal = snapshot(runtime, gateway, proof);
        evidence.afterTerminal = afterTerminal;
        if (uncommitted) {
          inspectInvariant(() => assertUncommittedHistory(held, afterTerminal));
        }
        if (replacementEntry) {
          const entryAfterTerminal = await waitForCompactionRunSettlement(
            runtime,
            gateway,
            proof,
            runId,
          );
          evidence.entryAfterTerminal = entryAfterTerminal;
          const replaced = replacementEntry;
          inspectInvariant(() =>
            assertReplacementWriterPreserved(replaced, entryAfterTerminal, ended, runId),
          );
        }
        if (committed) {
          const committedSnapshot = committed;
          inspectInvariant(() => assertCommittedHistory(committedSnapshot, afterTerminal));
        }
        if (proof.aborted) {
          assert.equal(ended.stopReason, "rpc", "Cancellation lost the explicit RPC stop reason");
        } else if (!interrupted) {
          assert.equal(ended.status, "ok", "Active recovery did not complete");
          await waitForCompactionReply(state, runId, proof.finalMarker);
        }
        // Abort emits terminal state before recovery unwinds. A fresh turn's real
        // provider request can only enter after the same session lane releases.
        const successorId = await startChat(runtime, gateway, proof, proof.recoveryMarker);
        evidence.successorId = successorId;
        await waitForCompactionProofCheckpoint(
          proof.successorHeld.promise,
          "same-session successor provider admission",
        );
        const settled = snapshot(runtime, gateway, proof);
        evidence.settled = settled;
        proof.releaseSuccessor.resolve();
        const successorTerminal = await terminal(runtime, gateway, successorId);
        evidence.successorTerminal = successorTerminal;
        assert.equal(successorTerminal.status, "ok", "The same-session successor did not complete");
        await waitForCompactionReply(state, successorId, proof.recoveryMarker);
        if (mode === "cancelled-after-commit") {
          // The held auxiliary compactor can outlive the original session lane.
          // Join only this owned Gateway before the final no-late-write snapshot.
          const stopped = await owner.stop({ keepTemp: true });
          evidence.gatewayStop = stopped.process;
          assert.equal(stopped.process, "confirmed-stopped", "Gateway process tree did not settle");
          assert.deepEqual(stopped.errors, [], "Gateway stop failed before the final snapshot");
          recordCompactionProofCheckpoint(proof, "owned-gateway-joined");
        }
        const after = snapshot(runtime, gateway, proof);
        evidence.after = after;
        runtimeSettled = true;
        assertOriginalRows(before, after);
        const outbound = state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound");
        const successorReplies = outbound.filter(
          (message) => message.text === proof.recoveryMarker,
        );
        assert.equal(successorReplies.length, 1, "Recovery marker was not delivered exactly once");
        assert.equal(
          successorReplies[0]?.replyToId,
          successorId,
          "Recovery marker was not delivered by the admitted successor run",
        );
        assert.equal(
          outbound.filter((message) => message.text === proof.finalMarker).length,
          interrupted ? 0 : 1,
          "Original final delivery did not match run ownership",
        );
        if (proof.aborted) {
          assert.equal(
            outbound.filter((message) => message.replyToId === runId).length,
            0,
            "Cancelled run delivered a late reply",
          );
        }
        assert.equal(proof.successorRequests, 1, "The successor made unexpected model retries");
        assert.equal(proof.summaryRequests, 1, "Recovery repeated compaction summarization");
        if (uncommitted) {
          inspectInvariant(() => assertUncommittedHistory(held, settled));
          inspectInvariant(() => assertUncommittedHistory(held, after));
        }
        if (committed) {
          const committedSnapshot = committed;
          inspectInvariant(() => assertCommittedHistory(committedSnapshot, settled));
          inspectInvariant(() => assertCommittedHistory(committedSnapshot, after));
          assert.equal(proof.afterHookCalls, 1, "Late stop repeated the completed after hook");
        }
        if (interrupted) {
          assert.equal(
            proof.normalRequests,
            1,
            "Interrupted recovery made another original-turn provider request",
          );
        } else if (mode === "active-failure") {
          assert.equal(
            after.compactionCount,
            0,
            "Independent summary failure was counted as compaction",
          );
          assert.equal(after.compactionIds.length, 0);
          assert.ok(
            after.toolChars > 0 && after.toolChars < before.toolChars,
            "Active summary failure did not exercise durable tool-result recovery",
          );
        } else {
          assert.equal(
            after.compactionCount,
            1,
            "Successful compaction was not counted exactly once",
          );
          assert.equal(after.compactionIds.length, 1);
        }
        assert.equal(invariantFailures.length, 0, invariantFailures.join("; "));
        evidence.status = "pass";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        evidence.status = "fail";
        evidence.error = message;
        failures.push(`${mode}: ${message}`);
      } finally {
        proof.releaseSummary.resolve();
        proof.releaseAfterHook.resolve();
        proof.releaseSuccessor.resolve();
        evidence.requestCounts = {
          normal: proof.normalRequests,
          summary: proof.summaryRequests,
          successor: proof.successorRequests,
          afterHook: proof.afterHookCalls,
        };
        await fs.writeFile(
          path.join(artifactBase, `${mode}.json`),
          `${JSON.stringify(evidence, null, 2)}\n`,
        );
      }
      if (!runtimeSettled) {
        break;
      }
    }
    assert.deepEqual(provider.errors, [], "Controlled provider received unexpected traffic");
    await fs.writeFile(
      path.join(artifactBase, "channel-transcript.json"),
      `${JSON.stringify(state.getSnapshot().messages, null, 2)}\n`,
    );
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    active?.releaseSummary.resolve();
    active?.releaseAfterHook.resolve();
    active?.releaseSuccessor.resolve();
    const cleanupErrors: unknown[] = [];
    let gatewayStopped = false;
    const cleanup = [
      async () => {
        const stopOptions = retainedGateway
          ? { keepTemp: true }
          : { preserveToDir: path.join(artifactBase, "gateway-logs") };
        const stopped = await owner.stop(stopOptions);
        assert.notEqual(
          stopped.process,
          "unconfirmed",
          "Gateway process shutdown was not confirmed",
        );
        gatewayStopped = true;
        cleanupErrors.push(...stopped.errors);
      },
      async () => {
        if (!retainedGateway || !gatewayStopped) {
          return;
        }
        const logDir = path.join(artifactBase, "gateway-logs");
        await fs.mkdir(logDir, { recursive: true });
        await fs.writeFile(path.join(logDir, "gateway.log"), retainedGateway.logs());
      },
      async () => {
        if (!retainedGateway || !gatewayStopped) {
          return;
        }
        // Database paths stay in namespace-owned state until the producer exits.
        // Only separately staged code is removed here, after the Gateway joins.
        const stagedRoot = retainedGateway.runtimeEnv.OPENCLAW_QA_STAGED_RUNTIME_ROOT;
        assert.ok(stagedRoot, "Retained Gateway omitted its owned staging root");
        assert.equal(
          stagedRoot,
          path.join(repoRoot, ".artifacts", "qa-runtime", path.basename(retainedGateway.tempRoot)),
          "Refusing to remove an unrelated staging root",
        );
        await fs.rm(stagedRoot, { recursive: true, force: true });
      },
      async () => {
        await provider?.stop();
      },
      () => bus.stop(),
      async () => {
        if (cleanupErrors.length === 0) {
          await fs.writeFile(path.join(tmpRoot, "gateway-stopped"), "confirmed\n");
        }
      },
    ];
    for (const stop of cleanup) {
      try {
        await stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      failures.push(
        `Gateway proof cleanup failed: ${cleanupErrors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
      );
    }
  }
  return failures;
}

async function main() {
  // Only Node built-ins and inert proof fixtures load before this guard.
  // The outer process owns these paths through shutdown, including import-time SQLite state.
  const tmpRoot = await requireOwnedEnvironment();
  const { values } = parseArgs({
    options: {
      "artifact-base": { type: "string" },
      "repo-root": { type: "string" },
      "isolated-child": { type: "boolean" },
    },
  });
  const repoRoot = path.resolve(
    values["repo-root"] ?? fileURLToPath(new URL("../../../..", import.meta.url)),
  );
  const relativeArtifacts =
    values["artifact-base"] ?? `.artifacts/qa-e2e/${SCENARIO_ID}-${randomUUID()}`;
  const artifactBase = path.resolve(repoRoot, relativeArtifacts);
  const artifactRelative = path.relative(repoRoot, artifactBase);
  assert.ok(
    artifactRelative && !artifactRelative.startsWith("..") && !path.isAbsolute(artifactRelative),
    "Artifacts must be inside the repository",
  );
  await fs.access(path.join(repoRoot, "dist", "index.js"));
  await fs.access(path.join(repoRoot, "dist", "plugin-sdk", "qa-lab.js"));
  await fs.mkdir(artifactBase, { recursive: true });
  const runtime = await loadRuntime();
  const writer = runtime.evidence.createQaScriptEvidenceWriter({
    artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: MODEL_REF,
    providerMode: "mock-openai",
    repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Gateway compaction preserves writer ownership and committed facts",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
    },
  });
  const startedAt = Date.now();
  let failure: string | undefined;
  try {
    const failures = await runCases(runtime, repoRoot, artifactBase, tmpRoot);
    failure = failures.length ? failures.join("; ") : undefined;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const artifacts = (await fs.readdir(artifactBase))
    .filter((name) => name.endsWith(".json"))
    .map((filePath) => ({ filePath, kind: "json" }));
  const status = failure ? "fail" : "pass";
  writer.appendLog(
    `${status}: ${failure ?? "Interrupted compaction preserved writer ownership and active tool content; completed compaction survived late cancellation; independent failure and success controls passed."}\n`,
  );
  await writer.write({ status, durationMs: Date.now() - startedAt, details: failure, artifacts });
  console.log(
    `${SCENARIO_ID}: ${status}; evidence=${path.join(artifactRelative, "qa-evidence.json")}`,
  );
  return failure ? 1 : 0;
}

async function launch() {
  if (process.argv.includes("--isolated-child")) {
    return await main();
  }
  // The catalog can invoke this producer directly. Its outer process imports
  // only process tooling and owns the child's namespace until verified shutdown.
  const { runManagedCommand } = await import("../../../../scripts/lib/managed-child-process.mts");
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-proof-")),
  );
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const config = path.join(root, "openclaw.json");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    CI: "1",
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_OAUTH_DIR: path.join(state, "credentials"),
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
  };
  for (const directory of [
    home,
    state,
    env.OPENCLAW_OAUTH_DIR,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_CACHE_HOME,
  ]) {
    assert.ok(directory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await fs.writeFile(config, "{}\n", { mode: 0o600 });
  let joined = false;
  try {
    const code = await runManagedCommand({
      bin: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
        "--isolated-child",
      ],
      env,
      requireProcessTreeExit: true,
      timeoutMs: 10 * 60_000,
    });
    joined = true;
    return code;
  } finally {
    const gatewayStopped = await fs
      .readFile(path.join(root, "gateway-stopped"), "utf8")
      .catch(() => "");
    if (joined && gatewayStopped === "confirmed\n") {
      await fs.rm(root, { recursive: true, force: true });
    } else {
      console.error(
        `Compaction proof retained its namespace because shutdown was not confirmed: ${root}`,
      );
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  launch()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
