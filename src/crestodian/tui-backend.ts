// Crestodian TUI backend runs setup-helper dialogue inside the shared local TUI shell.
import { randomUUID } from "node:crypto";
import type {
  SessionsPatchParams,
  SessionsPatchResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { ChannelsAddOptions } from "../commands/channels/add.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { notifyListeners } from "../shared/listeners.js";
import type {
  ChatSendOptions,
  TuiAgentsList,
  TuiBackend,
  TuiEvent,
  TuiModelChoice,
  TuiSessionList,
  TuiSessionCreateOptions,
} from "../tui/tui-backend.js";
import { runTui as defaultRunTui } from "../tui/tui.js";
import type { CrestodianAssistantPlanner } from "./assistant.js";
import { CrestodianChatEngine, type CrestodianChatEngineOptions } from "./chat-engine.js";
import {
  CrestodianInferenceUnavailableError,
  isCrestodianInferenceUnavailableError,
} from "./inference-error.js";
import { buildOnboardingWelcome } from "./onboarding-welcome.js";
import {
  executeCrestodianOperation,
  type CrestodianCommandDeps,
  type CrestodianOperation,
} from "./operations.js";
import { formatCrestodianStartupMessage, loadCrestodianOverview } from "./overview.js";
import {
  resolveCrestodianVerifiedInferenceRoute,
  type CrestodianVerifiedInferenceBinding,
} from "./verified-inference.js";

type RunTui = typeof defaultRunTui;

export type CrestodianTuiOptions = {
  yes?: boolean;
  deps?: CrestodianCommandDeps;
  planWithAssistant?: CrestodianAssistantPlanner;
  runTui?: RunTui;
  /** "onboarding" swaps the greeting for the first-run setup proposal. */
  welcomeVariant?: "onboarding";
  /** Workspace override for the proposed first-run setup (from --workspace). */
  setupWorkspace?: string;
  /** Test seam for the channel-setup wizard hosted by the chat bridge. */
  runChannelSetupWizard?: CrestodianChatEngineOptions["runChannelSetupWizard"];
  runChannelsAdd?: (
    opts: ChannelsAddOptions,
    runtime: RuntimeEnv,
    params?: { hasFlags?: boolean; beforePersistentEffect?: () => Promise<void> },
  ) => Promise<unknown>;
  readonly verifiedInference: CrestodianVerifiedInferenceBinding;
};

type CrestodianHistoryMessage = {
  role: "assistant" | "user";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
};

const CRESTODIAN_AGENT_ID = "crestodian";
const CRESTODIAN_SESSION_KEY = buildAgentMainSessionKey({ agentId: CRESTODIAN_AGENT_ID });

function createChatEngine(opts: CrestodianTuiOptions): CrestodianChatEngine {
  return new CrestodianChatEngine({
    yes: opts.yes,
    deps: opts.deps,
    planWithAssistant: opts.planWithAssistant,
    surface: "cli",
    verifiedInference: opts.verifiedInference,
    ...(opts.runChannelSetupWizard ? { runChannelSetupWizard: opts.runChannelSetupWizard } : {}),
  });
}

async function loadOverviewForTui(opts: CrestodianTuiOptions) {
  if (opts.deps?.loadOverview) {
    return await opts.deps.loadOverview();
  }
  return await loadCrestodianOverview();
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
  private engine: CrestodianChatEngine;
  private engineDisposal: Promise<void> | null = null;
  private inferenceFailure: CrestodianInferenceUnavailableError | null = null;
  private handoff: CrestodianOperation | null = null;
  private requestExit: (() => void) | null = null;
  private responseQueue: Promise<void> = Promise.resolve();
  private readonly messages: CrestodianHistoryMessage[] = [];

  constructor(
    private readonly opts: CrestodianTuiOptions,
    welcome: string,
    engine: CrestodianChatEngine,
  ) {
    this.engine = engine;
    this.messages.push(message("assistant", welcome));
  }

  setRequestExitHandler(handler: () => void): void {
    this.requestExit = handler;
    if (this.inferenceFailure) {
      queueMicrotask(handler);
    }
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
    // Keep the backend queue ahead of the engine queue so a failed inference
    // turn can retire the session before an already-submitted host command runs.
    const response = this.responseQueue.then(() => this.respond(runId, opts.sessionKey, text));
    this.responseQueue = response.catch(() => undefined);
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
    const overview = await loadOverviewForTui(this.opts);
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
    if (this.inferenceFailure) {
      throw this.inferenceFailure;
    }
    // Reset drops in-flight approvals/wizards along with the transcript.
    await this.disposeEngine();
    this.engine = createChatEngine(this.opts);
    this.engineDisposal = null;
    const overview = await loadOverviewForTui(this.opts);
    this.messages.splice(
      0,
      this.messages.length,
      message("assistant", formatCrestodianStartupMessage(overview)),
    );
    return { ok: true };
  }

  async createSession(_opts: TuiSessionCreateOptions) {
    await this.resetSession();
    return {
      ok: true as const,
      key: CRESTODIAN_SESSION_KEY,
      entry: { sessionId: "crestodian", updatedAt: Date.now() },
    };
  }

  async getGatewayStatus(): Promise<string> {
    const overview = await loadOverviewForTui(this.opts);
    return overview.gateway.reachable ? "Gateway reachable" : "Gateway unreachable";
  }

  async listModels(): Promise<TuiModelChoice[]> {
    return [];
  }

  async dispose(): Promise<void> {
    try {
      await this.disposeEngine();
    } catch (error) {
      if (!this.inferenceFailure) {
        throw error;
      }
      // Inference failure remains authoritative; retirement cleanup is best-effort.
    }
  }

  private disposeEngine(): Promise<void> {
    this.engineDisposal ??= this.engine.dispose();
    return this.engineDisposal;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private emit(event: string, payload: unknown): void {
    const listener = this.onEvent;
    if (!listener) {
      return;
    }
    // A renderer failure must not reject the backend's fire-and-forget response path.
    notifyListeners([listener], {
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
    if (this.inferenceFailure) {
      this.emitError(runId, sessionKey, this.inferenceFailure);
      queueMicrotask(() => this.requestExit?.());
      return;
    }
    try {
      const reply = await this.engine.handle(text);
      if ((reply.action === "open-tui" || reply.action === "open-setup") && reply.handoff) {
        // The outer loop owns interactive handoffs after the Crestodian TUI exits.
        this.handoff = reply.handoff;
        queueMicrotask(() => this.requestExit?.());
      } else if (reply.action === "exit") {
        queueMicrotask(() => this.requestExit?.());
      }
      this.emitFinal(runId, sessionKey, reply.text);
    } catch (error) {
      if (isCrestodianInferenceUnavailableError(error)) {
        // Match the Gateway session boundary: the failed conversation is dead.
        // Clear handoffs and dispose before exit so no queued exact command can
        // bypass the inference-first gate through this backend instance.
        this.inferenceFailure = error;
        this.handoff = null;
        try {
          await this.disposeEngine();
        } catch {
          // The inference error is authoritative; cleanup stays best-effort.
        }
        this.emitError(runId, sessionKey, error);
        queueMicrotask(() => this.requestExit?.());
        return;
      }
      this.emitError(runId, sessionKey, error);
    }
  }
}

async function runSetupHandoff(
  handoff: Extract<CrestodianOperation, { kind: "open-setup" }>,
  opts: CrestodianTuiOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  if (handoff.target !== "channels") {
    runtime.error(
      "Setup cannot replace the inference route powering Crestodian. Exit and run `openclaw onboard`, then start Crestodian again.",
    );
    return;
  }
  const runChannelsAdd =
    opts.runChannelsAdd ?? (await import("../commands/channels/add.js")).channelsAddCommand;
  const beforePersistentEffect = async () => {
    const binding = opts?.verifiedInference;
    if (!binding) {
      throw new CrestodianInferenceUnavailableError("conversation");
    }
    try {
      const { resolveCrestodianInferenceForPersistentApply } = await import("./setup-inference.js");
      const route = await resolveCrestodianInferenceForPersistentApply({
        binding,
        runtime,
        deps: opts.deps,
      });
      if (route) {
        return;
      }
    } catch (error) {
      if (isCrestodianInferenceUnavailableError(error)) {
        throw error;
      }
      throw new CrestodianInferenceUnavailableError("conversation", [error]);
    }
    throw new CrestodianInferenceUnavailableError("conversation");
  };
  await runChannelsAdd(handoff.channel ? { channel: handoff.channel } : {}, runtime, {
    hasFlags: false,
    beforePersistentEffect,
  });
}

export async function runCrestodianTui(
  opts: CrestodianTuiOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const binding = opts?.verifiedInference;
  if (!binding) {
    throw new CrestodianInferenceUnavailableError("conversation");
  }
  // Snapshot the verified owner so an external options mutation cannot swap
  // authority between the chat shell and a later host-owned wizard handoff.
  const boundOpts: CrestodianTuiOptions = { ...opts, verifiedInference: binding };
  let nextInput: string | undefined;
  let welcomeVariant = boundOpts.welcomeVariant;
  for (;;) {
    await requireTuiVerifiedInference(boundOpts);
    // A returned agent request is single-use; a later wizard handoff must not
    // replay it when Crestodian re-enters the chat shell.
    const initialMessage = nextInput;
    const engine = createChatEngine(boundOpts);
    let welcome: string;
    if (welcomeVariant === "onboarding") {
      welcome = await buildOnboardingWelcome({
        engine,
        ...(boundOpts.setupWorkspace ? { workspace: boundOpts.setupWorkspace } : {}),
      });
    } else {
      welcome = formatCrestodianStartupMessage(await loadOverviewForTui(boundOpts));
      engine.noteAssistantMessage(welcome);
    }
    // The onboarding greeting applies to the first shell only; re-entry after
    // an agent handoff uses the normal repair-oriented startup message.
    welcomeVariant = undefined;
    const backend = new CrestodianTuiBackend(boundOpts, welcome, engine);
    const runTui = boundOpts.runTui ?? defaultRunTui;
    try {
      await runTui({
        local: true,
        session: CRESTODIAN_SESSION_KEY,
        historyLimit: 200,
        backend,
        config: {},
        title: "openclaw crestodian",
        ...(initialMessage ? { message: initialMessage } : {}),
      });
    } finally {
      await backend.dispose();
    }

    const handoff = backend.consumeHandoff();
    if (!handoff) {
      return;
    }
    if (handoff.kind === "model-setup") {
      runtime.error(
        "Crestodian cannot replace its active inference route. Run `openclaw onboard` outside this session, then start Crestodian again.",
      );
      return;
    }
    if (handoff.kind === "open-setup") {
      await runSetupHandoff(handoff, boundOpts, runtime);
      return;
    }
    const result = await executeCrestodianOperation(handoff, runtime, {
      approved: true,
      deps: boundOpts.deps,
    });
    nextInput = result.nextInput;
    if (!nextInput?.trim()) {
      return;
    }
  }
}

async function requireTuiVerifiedInference(opts: CrestodianTuiOptions): Promise<void> {
  const binding = opts?.verifiedInference;
  if (!binding) {
    throw new CrestodianInferenceUnavailableError("conversation");
  }
  try {
    const route = await resolveCrestodianVerifiedInferenceRoute(binding, opts.deps);
    if (route) {
      return;
    }
  } catch (error) {
    throw new CrestodianInferenceUnavailableError("conversation", [error]);
  }
  throw new CrestodianInferenceUnavailableError("conversation");
}
