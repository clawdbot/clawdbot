// Shared stdio transport and response builders for fake Codex App Server E2E processes.
import fs from "node:fs";
import readline from "node:readline";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function createFakeInitializeResponse({ name, userAgent, version }) {
  return {
    protocolVersion: "2",
    serverInfo: { name, version },
    userAgent,
  };
}

export function createFakeThreadStartResponse({ params, sessionId, threadId, version }) {
  const now = Date.now();
  const cwd = params?.cwd ?? process.cwd();
  return {
    thread: {
      id: threadId,
      sessionId,
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      path: null,
      cwd,
      cliVersion: version,
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: params?.model ?? "gpt-5.6-luna",
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: params?.approvalPolicy ?? "never",
    approvalsReviewer: params?.approvalsReviewer ?? "user",
    sandbox: { type: "dangerFullAccess" },
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly",
  };
}

export function runFakeCodexAppServer({ handlers, logMode = "requests", requestLog }) {
  function appendLog(message) {
    try {
      fs.appendFileSync(requestLog, `${JSON.stringify(message)}\n`);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`fake Codex app-server request log write failed: ${detail}\n`);
      return false;
    }
  }

  function emit(message) {
    if (logMode === "messages") {
      appendLog(message);
    }
    writeMessage(message);
  }

  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    const request = JSON.parse(line);
    if (!appendLog(request)) {
      if (request?.id !== undefined) {
        writeMessage({
          error: { message: "fake Codex app-server request log write failed" },
          id: request.id,
        });
      }
      return;
    }

    const { id, method, params } = request;
    if (id === undefined) {
      return;
    }
    const sendResult = (result) => emit({ id, result });
    const notify = (notificationMethod, notificationParams) =>
      emit({ method: notificationMethod, params: notificationParams });
    const handler =
      typeof method === "string" && Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (handler) {
      handler({ id, notify, params, sendResult });
      return;
    }
    sendResult({});
  });
}
