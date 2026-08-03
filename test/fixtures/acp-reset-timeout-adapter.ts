#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ContentBlock,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionId,
} from "@agentclientprotocol/sdk";

type AdapterEvent = {
  at: string;
  event: string;
  instanceId: string;
  pid: number;
  sessionId?: string;
  [key: string]: unknown;
};

type AdapterOptions = {
  controlDir: string;
};

type SessionState = {
  promptAbort?: AbortController;
};

class PromptCancelledError extends Error {
  constructor() {
    super("prompt cancelled");
    this.name = "PromptCancelledError";
  }
}

function parseOptions(argv: string[]): AdapterOptions {
  const controlDirIndex = argv.indexOf("--control-dir");
  const controlDir = controlDirIndex >= 0 ? argv[controlDirIndex + 1]?.trim() : "";
  if (!controlDir) {
    throw new Error("--control-dir is required");
  }
  return { controlDir: path.resolve(controlDir) };
}

function promptText(prompt: ContentBlock[]): string {
  return prompt
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

const options = parseOptions(process.argv.slice(2));
mkdirSync(options.controlDir, { recursive: true });
const instanceId = `adapter-${process.pid}-${randomUUID().slice(0, 8)}`;
const logPath = path.join(options.controlDir, "adapter.jsonl");

function markerPath(name: string): string {
  return path.join(options.controlDir, name);
}

function markerExists(name: string): boolean {
  return existsSync(markerPath(name));
}

function logEvent(
  event: string,
  fields: Omit<AdapterEvent, "at" | "event" | "instanceId" | "pid"> = {},
) {
  const entry: AdapterEvent = {
    at: new Date().toISOString(),
    event,
    instanceId,
    pid: process.pid,
    ...fields,
  };
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function waitForMarker(name: string, signal?: AbortSignal): Promise<void> {
  while (!markerExists(name)) {
    if (signal?.aborted) {
      throw new PromptCancelledError();
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  if (signal?.aborted) {
    throw new PromptCancelledError();
  }
}

class ResetTimeoutProofAgent implements Agent {
  private readonly sessions = new Map<SessionId, SessionState>();

  constructor(private readonly connection: AgentConnection) {}

  async initialize(): Promise<InitializeResponse> {
    logEvent("initialize");
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
        sessionCapabilities: { close: {} },
      },
    };
  }

  async authenticate(): Promise<void> {}

  async setSessionMode(params: { sessionId: SessionId; modeId: string }): Promise<void> {
    logEvent("set_mode_start", { sessionId: params.sessionId, mode: params.modeId });
    if (markerExists("hang-set-mode")) {
      await waitForMarker("release-set-mode");
    }
    logEvent("set_mode_end", { sessionId: params.sessionId, mode: params.modeId });
  }

  async newSession(): Promise<NewSessionResponse> {
    const sessionId = `${instanceId}-session-${randomUUID().slice(0, 8)}`;
    this.sessions.set(sessionId, {});
    logEvent("session_create", { sessionId });
    return { sessionId };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.sessions.set(params.sessionId, this.sessions.get(params.sessionId) ?? {});
    logEvent("session_load", { sessionId: params.sessionId });
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.resourceNotFound(params.sessionId);
    }
    const text = promptText(params.prompt);
    const promptAbort = new AbortController();
    session.promptAbort = promptAbort;
    logEvent("turn_start", { sessionId: params.sessionId, text });

    try {
      if (text === "hold-turn") {
        await waitForMarker("release-turn", promptAbort.signal);
      }
      const reply = `proof-reply instance=${instanceId} session=${params.sessionId} text=${text}`;
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reply },
        },
      });
      logEvent("turn_end", { sessionId: params.sessionId, text, reply, stopReason: "end_turn" });
      return { stopReason: "end_turn" };
    } catch (error) {
      if (error instanceof PromptCancelledError || promptAbort.signal.aborted) {
        logEvent("turn_end", { sessionId: params.sessionId, text, stopReason: "cancelled" });
        return { stopReason: "cancelled" };
      }
      throw error;
    } finally {
      if (session.promptAbort === promptAbort) {
        session.promptAbort = undefined;
      }
    }
  }

  async cancel(params: { sessionId: SessionId }): Promise<void> {
    logEvent("cancel_start", { sessionId: params.sessionId });
    if (markerExists("hang-cancel")) {
      await waitForMarker("release-cancel");
    }
    if (!markerExists("cancel-no-abort")) {
      this.sessions.get(params.sessionId)?.promptAbort?.abort();
    }
    logEvent("cancel_end", { sessionId: params.sessionId });
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    logEvent("close_start", { sessionId: params.sessionId });
    if (markerExists("hang-close")) {
      await waitForMarker("release-close");
    }
    this.sessions.delete(params.sessionId);
    logEvent("close_end", { sessionId: params.sessionId });
    return {};
  }
}

logEvent("process_start");
process.on("exit", (code) => logEvent("process_exit", { code }));
process.once("SIGTERM", () => {
  logEvent("process_signal", { signal: "SIGTERM" });
  process.exit(0);
});
process.once("SIGINT", () => {
  logEvent("process_signal", { signal: "SIGINT" });
  process.exit(0);
});

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(output, input);
const connection = new AgentSideConnection(
  (agentConnection) => new ResetTimeoutProofAgent(agentConnection),
  stream,
);
void connection;
