// Fake Codex app server used by media-path E2E scenarios.
import fs from "node:fs";
import readline from "node:readline";

const requestLog =
  process.env.OPENCLAW_CODEX_MEDIA_PATH_APP_SERVER_LOG ??
  "/tmp/openclaw-codex-media-path-app-server.jsonl";
let turnCount = 0;

function appendRequest(request) {
  try {
    fs.appendFileSync(requestLog, `${JSON.stringify(request)}\n`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`fake Codex app-server request log write failed: ${message}\n`);
    if (request?.id != null) {
      sendError(request.id, `fake Codex app-server request log write failed: ${message}`);
    }
    return false;
  }
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function sendError(id, message) {
  process.stdout.write(`${JSON.stringify({ error: { message }, id })}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const request = JSON.parse(line);
  if (!appendRequest(request)) {
    return;
  }
  const { id, method, params } = request;
  if (method === "initialize") {
    send(id, {
      protocolVersion: "2",
      serverInfo: { name: "openclaw-codex-media-path-e2e", version: "0.125.0" },
      userAgent: "openclaw-codex-media-path-e2e/0.125.0 (Docker; test)",
    });
    return;
  }
  if (method === "thread/start") {
    const now = Date.now();
    send(id, {
      thread: {
        id: "thread-codex-media-path-e2e",
        sessionId: "session-codex-media-path-e2e",
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: now,
        updatedAt: now,
        cwd: params?.cwd ?? process.cwd(),
        status: { type: "idle" },
        path: null,
        cliVersion: "0.125.0",
        source: "unknown",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      },
      model: params?.model ?? "gpt-5.5",
      modelProvider: "openai",
      serviceTier: null,
      cwd: params?.cwd ?? process.cwd(),
      instructionSources: [],
      approvalPolicy: params?.approvalPolicy ?? "never",
      approvalsReviewer: params?.approvalsReviewer ?? "user",
      sandbox: { type: "dangerFullAccess" },
      permissionProfile: null,
      reasoningEffort: null,
    });
    return;
  }
  if (method === "turn/start") {
    turnCount += 1;
    send(id, {
      turn: {
        id: `turn-codex-media-path-e2e-${turnCount}`,
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: `msg-codex-media-path-e2e-${turnCount}`,
            text: "CODEX_MEDIA_PATH_E2E_OK",
          },
        ],
      },
    });
    return;
  }
  send(id, {});
});
