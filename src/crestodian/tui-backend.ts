import { randomUUID } from "node:crypto";
import type { SessionsPatchParams, SessionsPatchResult } from "../gateway/protocol/index.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type {
  ChatSendOptions,
  TuiAgentsList,
  TuiBackend,
  TuiEvent,
  TuiModelChoice,
  TuiSessionList,
} from "../tui/tui-backend.js";
import { runTui } from "../tui/tui.js";
import type { CrestodianAssistantPlanner } from "./assistant.js";
import { approvalQuestion, isYes, resolveCrestodianOperation } from "./dialogue.js";
import {
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  type CrestodianCommandDeps,
  type CrestodianOperation,
} from "./operations.js";
import { formatCrestodianStartupMessage, loadCrestodianOverview } from "./overview.js";

export type CrestodianTuiOptions = {
  yes?: boolean;
  deps?: CrestodianCommandDeps;
  planWithAssistant?: CrestodianAssistantPlanner;
};

type CrestodianHistoryMessage = {
  role: "assistant" | "user";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
};

type CaptureRuntime = RuntimeEnv & {
  read: () => string;
};

const CRESTODIAN_AGENT_ID = "crestodian";
const CRESTODIAN_SESSION_KEY = buildAgentMainSessionKey({ agentId: CRESTODIAN_AGENT_ID });

function createCaptureRuntime(): CaptureRuntime {
  const lines: string[] = [];
  return {
    log: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
    exit: (code) => {
      throw new Error(`Crestodian operation exited with code ${String(code)}`);
    },
    read: () => lines.join("\n").trim(),
  };
}

function message(role: "assistant" | "user", text: string): CrestodianHistoryMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function splitModelRef(ref: string | undefined): { provider?: string; model?: string } {
  const trimmed = ref?.trim();
  if (!trimmed) {
    return {};
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return { model: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

class CrestodianTuiBackend implements TuiBackend {
  readonly connection = { url: "crestodian local" };

  onEvent?: (evt: TuiEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;

  private seq = 0;
  private pending: CrestodianOperation | null = null;
  private handoff: CrestodianOperation | null = null;
  private requestExit: (() => void) | null = null;
  private readonly messages: CrestodianHistoryMessage[] = [];

  constructor(
    private readonly opts: CrestodianTuiOptions,
    welcome: string,
  ) {
    this.messages.push(message("assistant", welcome));
  }

  setRequestExitHandler(handler: () => void): void {
    this.requestExit = handler;
  }

  consumeHandoff(): CrestodianOperation | null {
    const handoff = this.handoff;
    this.handoff = null;
    return handoff;
  }

  start(): void {
    queueMicrotask(() => {
      this.onConnected?.();
    });
  }

  stop(): void {
    // The enclosing TUI owns terminal shutdown; Crestodian has no transport to close.
  }

  async sendChat(opts: ChatSendOptions): Promise<{ runId: string }> {
    const runId = opts.runId ?? randomUUID();
    const text = opts.message.trim();
    this.messages.push(message("user", opts.message));
    void this.respond(runId, opts.sessionKey, text);
    return { runId };
  }

  async abortChat(): Promise<{ ok: boolean; aborted: boolean }> {
    return { ok: true, aborted: false };
  }

  async loadHistory(): Promise<{
    sessionId: string;
    messages: CrestodianHistoryMessage[];
    thinkingLevel: string;
    verboseLevel: string;
  }> {
    return {
      sessionId: "crestodian",
      messages: this.messages,
      thinkingLevel: "off",
      verboseLevel: "off",
    };
  }

  async listSessions(): Promise<TuiSessionList> {
    const overview = await loadCrestodianOverview();
    const model = splitModelRef(overview.defaultModel);
    return {
      ts: Date.now(),
      path: "crestodian",
      count: 1,
      defaults: {
        model: model.model ?? null,
        modelProvider: model.provider ?? null,
        contextTokens: null,
      },
      sessions: [
        {
          key: CRESTODIAN_SESSION_KEY,
          sessionId: "crestodian",
          displayName: "Crestodian",
          updatedAt: Date.now(),
          thinkingLevel: "off",
          verboseLevel: "off",
          model: model.model,
          modelProvider: model.provider,
        },
      ],
    };
  }

  async listAgents(): Promise<TuiAgentsList> {
    return {
      defaultId: CRESTODIAN_AGENT_ID,
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: CRESTODIAN_AGENT_ID, name: "Crestodian" }],
    };
  }

  async patchSession(opts: SessionsPatchParams): Promise<SessionsPatchResult> {
    const model = splitModelRef(typeof opts.model === "string" ? opts.model : undefined);
    return {
      ok: true,
      path: "crestodian",
      key: CRESTODIAN_SESSION_KEY,
      entry: {
        sessionId: "crestodian",
        displayName: "Crestodian",
        updatedAt: Date.now(),
        ...(model.model ? { model: model.model } : {}),
        ...(model.provider ? { modelProvider: model.provider } : {}),
      },
      resolved: {
        modelProvider: model.provider,
        model: model.model,
      },
    };
  }

  async resetSession(): Promise<{ ok: boolean }> {
    this.pending = null;
    const overview = await loadCrestodianOverview();
    this.messages.splice(
      0,
      this.messages.length,
      message("assistant", formatCrestodianStartupMessage(overview)),
    );
    return { ok: true };
  }

  async getGatewayStatus(): Promise<string> {
    const overview = await loadCrestodianOverview();
    return overview.gateway.reachable ? "Gateway reachable" : "Gateway unreachable";
  }

  async listModels(): Promise<TuiModelChoice[]> {
    return [];
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private emit(event: string, payload: unknown): void {
    this.onEvent?.({
      event,
      payload,
      seq: this.nextSeq(),
    });
  }

  private emitFinal(runId: string, sessionKey: string, text: string): void {
    const assistant = message(
      "assistant",
      text || "Crestodian listened and found nothing to change.",
    );
    this.messages.push(assistant);
    this.emit("chat", {
      runId,
      sessionKey,
      state: "final",
      message: assistant,
    });
  }

  private emitError(runId: string, sessionKey: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.emit("chat", {
      runId,
      sessionKey,
      state: "error",
      errorMessage,
    });
  }

  private async respond(runId: string, sessionKey: string, text: string): Promise<void> {
    try {
      const reply = await this.resolveReply(text);
      this.emitFinal(runId, sessionKey, reply);
    } catch (error) {
      this.emitError(runId, sessionKey, error);
    }
  }

  private async resolveReply(text: string): Promise<string> {
    if (this.pending) {
      if (isYes(text)) {
        const pending = this.pending;
        this.pending = null;
        const capture = createCaptureRuntime();
        await executeCrestodianOperation(pending, capture, {
          approved: true,
          deps: this.opts.deps,
        });
        return capture.read() || "Applied. Audit entry written.";
      }
      this.pending = null;
      return "Skipped. No barnacles on config today.";
    }

    const capture = createCaptureRuntime();
    const operation = await resolveCrestodianOperation(text, capture, this.opts);

    if (operation.kind === "open-tui") {
      this.handoff = operation;
      queueMicrotask(() => this.requestExit?.());
      return "Opening your normal agent TUI. Use /crestodian there to come back.";
    }

    if (isPersistentCrestodianOperation(operation) && !this.opts.yes) {
      this.pending = operation;
      await executeCrestodianOperation(operation, capture, {
        approved: false,
        deps: this.opts.deps,
      });
      return [capture.read(), approvalQuestion(operation)].filter(Boolean).join("\n\n");
    }

    await executeCrestodianOperation(operation, capture, {
      approved: this.opts.yes === true || !isPersistentCrestodianOperation(operation),
      deps: this.opts.deps,
    });
    const reply = capture.read();
    if (operation.kind === "none" && reply.includes("Bye.")) {
      queueMicrotask(() => this.requestExit?.());
    }
    return reply;
  }
}

export async function runCrestodianTui(
  opts: CrestodianTuiOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  let nextInput: string | undefined;
  for (;;) {
    const overview = await loadCrestodianOverview();
    const backend = new CrestodianTuiBackend(opts, formatCrestodianStartupMessage(overview));
    await runTui({
      local: true,
      session: CRESTODIAN_SESSION_KEY,
      historyLimit: 200,
      backend,
      config: {},
      title: "openclaw crestodian",
      ...(nextInput ? { message: nextInput } : {}),
    });

    const handoff = backend.consumeHandoff();
    if (!handoff) {
      return;
    }
    const result = await executeCrestodianOperation(handoff, runtime, {
      approved: true,
      deps: opts.deps,
    });
    nextInput = result.nextInput;
    if (!nextInput?.trim()) {
      return;
    }
  }
}
