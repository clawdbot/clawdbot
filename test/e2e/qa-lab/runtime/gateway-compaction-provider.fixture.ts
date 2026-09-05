// Import-safe test fixture: only Node built-ins and inert declarations. Servers,
// timers, and gates start only through explicit calls after the proof isolates its environment.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";

export const COMPACTION_PROOF_MODEL_ID = "gpt-5.6-luna";
export const COMPACTION_PROOF_MODEL_REF = `mock-openai/${COMPACTION_PROOF_MODEL_ID}`;
export const COMPACTION_PROOF_TOOL_CALL_ID = "qa-retained-read";
export const COMPACTION_PROOF_TIMEOUT_MS = 60_000;
const SUMMARY_INSTRUCTIONS =
  /context summarization assistant[\s\S]*structured summary[\s\S]*do not continue/i;
type CaseMode =
  | "cancel"
  | "writer-replaced"
  | "cancelled-after-commit"
  | "active-failure"
  | "success"
  | "heartbeat-fresh-restricted"
  | "heartbeat-upgraded-native-failure"
  | "heartbeat-upgraded-restart"
  | "heartbeat-substituted"
  | "heartbeat-revoked";
type TimelineEntry = { sequence: number; event: string; [key: string]: unknown };

// The shared deferred helper imports application code before the outer isolation guard.
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function waitForCompactionProofCheckpoint(pending: Promise<unknown>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          COMPACTION_PROOF_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createCompactionProofCase(mode: CaseMode) {
  const id: string = randomUUID();
  return {
    mode,
    sessionId: id,
    sessionKey: `agent:qa:compaction-abort-${id}`,
    finalMarker: `QA-COMPACTION-FINAL-${id}`,
    recoveryMarker: `QA-COMPACTION-NEXT-${id}`,
    overflowSeen: gate(),
    beforeHookHeld: gate(),
    releaseBeforeHook: gate(),
    beforeHookSettled: gate(),
    summaryHeld: gate(),
    releaseSummary: gate(),
    summarySettled: gate(),
    hostCommitHeld: gate(),
    releaseHostCommit: gate(),
    nativeCompactRequestHeld: gate(),
    releaseNativeCompactRequest: gate(),
    afterHookHeld: gate(),
    releaseAfterHook: gate(),
    afterHookSettled: gate(),
    afterHookCalls: 0,
    afterHookPending: false,
    successorHeld: gate(),
    releaseSuccessor: gate(),
    normalRequests: 0,
    summaryRequests: 0,
    successorRequests: 0,
    aborted: false,
    timeline: [] as TimelineEntry[],
  };
}

export type CompactionProofCase = ReturnType<typeof createCompactionProofCase>;

export function recordCompactionProofCheckpoint(
  proof: CompactionProofCase,
  event: string,
  details: Record<string, unknown> = {},
) {
  proof.timeline.push({ sequence: proof.timeline.length + 1, event, ...details });
}

/** Stage the ordinary workspace hook before Gateway startup, inside its owned namespace. */
export function stageCompactionProofHook(workspaceDir: string, baseUrl: string) {
  const hookName = "qa-compaction-commit-barrier";
  const hookDir = path.join(workspaceDir, "hooks", hookName);
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(
    path.join(hookDir, "HOOK.md"),
    [
      "---",
      `name: ${hookName}`,
      "description: Hold a completed compaction until the QA caller cancels",
      'metadata: {"openclaw":{"events":["gateway:startup","session:compact:after"]}}',
      "---",
      "",
    ].join("\n"),
  );
  // The held request spans abort acknowledgement, terminal state, and bookkeeping observation.
  const hookTimeoutMs = 3 * COMPACTION_PROOF_TIMEOUT_MS;
  writeFileSync(
    path.join(hookDir, "handler.js"),
    `export default async function compactionBarrier(event) {
  const phases = event.type === "gateway" ? ["ready"] : ["held", "settled"];
  for (const phase of phases) {
    const response = await fetch(${JSON.stringify(`${baseUrl}/qa/compaction-hook/`)} + phase, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: event.sessionKey, sessionId: event.context.sessionId }),
      signal: AbortSignal.timeout(${hookTimeoutMs}),
    });
    await response.text();
    if (!response.ok) {
      throw new Error("Compaction proof hook checkpoint failed");
    }
  }
}
`,
  );
  return hookName;
}

/** Hold the real context-engine before hook so the caller can mutate exact run authority. */
export function stageHeartbeatCompactionProofHook(workspaceDir: string, baseUrl: string) {
  const hookName = "qa-heartbeat-compaction-authority-barrier";
  const hookDir = path.join(workspaceDir, "hooks", hookName);
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(
    path.join(hookDir, "HOOK.md"),
    [
      "---",
      `name: ${hookName}`,
      "description: Hold heartbeat compaction before provider dispatch",
      'metadata: {"openclaw":{"events":["gateway:startup","session:compact:before"]}}',
      "---",
      "",
    ].join("\n"),
  );
  const hookTimeoutMs = 3 * COMPACTION_PROOF_TIMEOUT_MS;
  writeFileSync(
    path.join(hookDir, "handler.js"),
    `export default async function heartbeatCompactionBarrier(event) {
  const phase = event.type === "gateway" ? "ready" : "before-held";
  const response = await fetch(${JSON.stringify(`${baseUrl}/qa/compaction-hook/`)} + phase, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey: event.sessionKey, sessionId: event.context.sessionId }),
    signal: AbortSignal.timeout(${hookTimeoutMs}),
  });
  await response.text();
  if (!response.ok) {
    throw new Error("Heartbeat compaction proof hook checkpoint failed");
  }
}
`,
  );
  return hookName;
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeAssistant(response: ServerResponse, text: string) {
  // Responses item.done supplies authoritative text even without deltas;
  // response.completed then settles usage and the terminal output snapshot.
  const message = {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `resp_${randomUUID()}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

export async function startCompactionProofProvider(
  isRecord: (value: unknown) => value is Record<string, unknown>,
) {
  let active: CompactionProofCase | undefined;
  const hookReady = gate();
  const requests = new Set<Promise<void>>();
  const errors: string[] = [];
  const textOf = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(textOf).join("\n");
    }
    return isRecord(value) ? textOf(value.text ?? value.content) : "";
  };
  const server = createServer((request, response) => {
    const work = (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        writeJson(response, 200, { data: [{ id: COMPACTION_PROOF_MODEL_ID, object: "model" }] });
        return;
      }
      assert.equal(request.method, "POST", "Unexpected provider HTTP method");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        assert.ok(bytes <= 2 * 1024 * 1024, "Provider request exceeded fixture bound");
        chunks.push(buffer);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(isRecord(body), "Provider request must be an object");
      if (request.url === "/v1/qa/compaction-hook/ready") {
        hookReady.resolve();
        writeJson(response, 200, { ok: true });
        return;
      }
      const proof = active;
      assert.ok(proof, "Provider request arrived outside an owned case");
      assert.ok(proof.timeline.length < 64, "Unexpected provider retry loop");
      if (request.url === "/v1/qa/host-compaction-commit") {
        assert.equal(proof.mode, "heartbeat-upgraded-restart");
        assert.equal(body.sessionKey, proof.sessionKey, "Host commit changed its session key");
        assert.equal(body.sessionId, proof.sessionId, "Host commit changed its session identity");
        recordCompactionProofCheckpoint(proof, "host-compaction-commit-held");
        proof.hostCommitHeld.resolve();
        await proof.releaseHostCommit.promise;
        writeJson(response, 200, { ok: true });
        return;
      }
      if (request.url === "/v1/qa/compaction-hook/before-held") {
        assert.equal(body.sessionKey, proof.sessionKey, "Before hook changed its session key");
        assert.equal(body.sessionId, proof.sessionId, "Before hook changed its session identity");
        recordCompactionProofCheckpoint(proof, "before-hook-held");
        proof.beforeHookHeld.resolve();
        await proof.releaseBeforeHook.promise;
        recordCompactionProofCheckpoint(proof, "before-hook-settled");
        proof.beforeHookSettled.resolve();
        writeJson(response, 200, { ok: true });
        return;
      }
      if (request.url === "/v1/qa/native-compact/held") {
        assert.ok(
          proof.mode === "heartbeat-upgraded-native-failure",
          "Native compaction barrier reached outside the upgraded case",
        );
        assert.equal(
          body.threadId,
          "thread-qa-codex-heartbeat",
          "Native compaction changed Codex thread identity",
        );
        assert.ok(
          typeof body.requestId === "number" || typeof body.requestId === "string",
          "Native compaction callback omitted its request id",
        );
        recordCompactionProofCheckpoint(proof, "native-compact-request-held", {
          requestId: body.requestId,
          threadId: body.threadId,
        });
        proof.nativeCompactRequestHeld.resolve();
        await proof.releaseNativeCompactRequest.promise;
        recordCompactionProofCheckpoint(proof, "native-compact-request-released", {
          requestId: body.requestId,
        });
        writeJson(response, 200, { ok: true });
        return;
      }
      if (
        request.url === "/v1/qa/compaction-hook/held" ||
        request.url === "/v1/qa/compaction-hook/settled"
      ) {
        assert.equal(body.sessionKey, proof.sessionKey, "After hook changed its session key");
        assert.equal(body.sessionId, proof.sessionId, "After hook changed its session identity");
        if (request.url.endsWith("/held")) {
          proof.afterHookCalls += 1;
          proof.afterHookPending = true;
          response.once("close", () => {
            proof.afterHookPending = false;
          });
          recordCompactionProofCheckpoint(proof, "after-hook-held");
          proof.afterHookHeld.resolve();
          if (
            proof.mode === "cancelled-after-commit" ||
            proof.mode === "heartbeat-upgraded-native-failure"
          ) {
            await proof.releaseAfterHook.promise;
          }
        } else {
          recordCompactionProofCheckpoint(proof, "after-hook-settled");
          proof.afterHookSettled.resolve();
        }
        writeJson(response, 200, { ok: true });
        return;
      }
      assert.equal(request.url, "/v1/responses", "Unexpected provider HTTP route");
      assert.equal(body.model, COMPACTION_PROOF_MODEL_ID, "Compaction changed the selected model");
      const input = Array.isArray(body.input) ? body.input.filter(isRecord) : [];
      const instructions = [
        textOf(body.instructions),
        ...input.filter((item) => item.role === "system" || item.role === "developer").map(textOf),
      ].join("\n");
      // Responses places user-role runtime context after the actual request.
      // Match the unique next-turn marker without assuming the final user item owns it.
      const successorRequest = input.some(
        (item) => item.role === "user" && textOf(item).includes(proof.recoveryMarker),
      );
      if (SUMMARY_INSTRUCTIONS.test(instructions)) {
        if (!proof.mode.startsWith("heartbeat-")) {
          assert.ok(
            proof.normalRequests > 0,
            "Compaction started before the injected HTTP overflow",
          );
        }
        proof.summaryRequests += 1;
        recordCompactionProofCheckpoint(proof, "summary-held", {
          bytes,
          afterAbort: proof.aborted,
        });
        response.once("close", () =>
          recordCompactionProofCheckpoint(proof, "summary-client-closed", {
            afterAbort: proof.aborted,
          }),
        );
        proof.summaryHeld.resolve();
        try {
          await proof.releaseSummary.promise;
          if (response.destroyed) {
            recordCompactionProofCheckpoint(proof, "summary-discarded-after-close");
            return;
          }
          recordCompactionProofCheckpoint(proof, "summary-response-released", {
            afterAbort: proof.aborted,
          });
          if (proof.mode === "active-failure") {
            writeJson(response, 400, {
              error: {
                type: "invalid_request_error",
                code: "qa_summary_failure",
                message: "Independent QA summary failure",
              },
            });
          } else {
            writeAssistant(
              response,
              `## Decisions\n- Earlier fixture conversation was summarized.\n\n## Open TODOs\n- Continue the retained request.\n\n## Constraints/Rules\n- Do not repeat the completed read.\n\n## Pending user asks\n- Return ${proof.finalMarker}.\n\n## Exact identifiers\n- ${COMPACTION_PROOF_TOOL_CALL_ID}`,
            );
          }
        } finally {
          proof.summarySettled.resolve();
        }
        return;
      }
      if (successorRequest) {
        proof.successorRequests += 1;
        recordCompactionProofCheckpoint(proof, "same-session-successor-held", { bytes });
        proof.successorHeld.resolve();
        await proof.releaseSuccessor.promise;
        writeAssistant(response, proof.recoveryMarker);
        return;
      }
      proof.normalRequests += 1;
      recordCompactionProofCheckpoint(proof, "agent-request", { bytes, afterAbort: proof.aborted });
      if (proof.normalRequests === 1) {
        recordCompactionProofCheckpoint(proof, "context-overflow");
        writeJson(response, 400, {
          error: {
            type: "invalid_request_error",
            code: "context_length_exceeded",
            message: "This model's maximum context length was exceeded.",
          },
        });
        proof.overflowSeen.resolve();
        return;
      }
      writeAssistant(response, proof.finalMarker);
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.destroyed) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    requests.add(work);
    void work.finally(() => requests.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "Provider did not bind loopback");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    hookReady: hookReady.promise,
    errors,
    arm(proof: CompactionProofCase) {
      active = proof;
    },
    async stop() {
      active?.releaseBeforeHook.resolve();
      active?.releaseSummary.resolve();
      active?.releaseHostCommit.resolve();
      active?.releaseNativeCompactRequest.resolve();
      active?.releaseAfterHook.resolve();
      active?.releaseSuccessor.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await Promise.all(requests);
    },
  };
}
