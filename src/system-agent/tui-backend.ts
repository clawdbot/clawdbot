// OpenClaw TUI backend runs setup-helper dialogue inside the shared local TUI shell.
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
import { SYSTEM_AGENT_ID } from "./agent-id.js";
import { SystemAgentChatEngine, type SystemAgentChatEngineOptions } from "./chat-engine.js";
import {
  SystemAgentInferenceUnavailableError,
  isSystemAgentInferenceUnavailableError,
} from "./inference-error.js";
import { buildOnboardingWelcome } from "./onboarding-welcome.js";
import { executeSystemAgentOperation, type SystemAgentOperation } from "./operations.js";
import { formatSystemAgentStartupMessage, loadSystemAgentOverview } from "./overview.js";
import { resolveSystemAgentVerifiedInferenceState } from "./verified-inference.js";

type RunTui = typeof import("../tui/tui.js").runTui;

async function loadHostedSetupForTui() {
  const [{ createClackPrompter }, hostedSetup] = await Promise.all([
    import("../wizard/clack-prompter.js"),
    import("./hosted-setup.runtime.js"),
  ]);
  return { createClackPrompter, hostedSetup };
}

export type SystemAgentTuiOptions = Pick<
  SystemAgentChatEngineOptions,
  "yes" | "deps" | "planWithAssistant" | "verifiedInference"
> & {
  runTui?: RunTui;
  /** "onboarding" swaps the greeting for the first-run setup proposal. */
  welcomeVariant?: "onboarding";
  /** Workspace override for the proposed first-run setup (from --workspace). */
  setupWorkspace?: string;
  /** Selected first-agent name for the proposed onboarding setup. */
  setupAgentName?: string;
  runChannelsAdd?: (
    opts: ChannelsAddOptions,
    runtime: RuntimeEnv,
    params?: { hasFlags?: boolean; beforePersistentEffect?: () => Promise<void> },
  ) => Promise<unknown>;
  runSearchSetupHandoff?: (
    runtime: RuntimeEnv,
    beforePersistentEffect: () => Promise<void>,
  ) => Promise<void>;
  runGatewaySetupHandoff?: (
    runtime: RuntimeEnv,
    beforePersistentEffect: () => Promise<void>,
  ) => Promise<void>;
};

type SystemAgentHistoryMessage = {
  role: "assistant" | "user";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
};

type SystemAgentTuiRoute = {
  model?: string;
  modelProvider?: string;
  thinkingLevel: string;
};

const SYSTEM_AGENT_SESSION_KEY = buildAgentMainSessionKey({ agentId: SYSTEM_AGENT_ID });
const SYSTEM_AGENT_HISTORY_LIMIT = 200;

function createChatEngine(opts: SystemAgentTuiOptions): SystemAgentChatEngine {
  return new SystemAgentChatEngine({
    yes: opts.yes,
    deps: opts.deps,
    planWithAssistant: opts.planWithAssistant,
    surface: "cli",
    verifiedInference: opts.verifiedInference,
  });
}

async function loadOverviewForTui(opts: SystemAgentTuiOptions) {
  if (opts.deps?.loadOverview) {
    return await opts.deps.loadOverview();
  }
  return await loadSystemAgentOverview();
}

function message(role: "assistant" | "user", text: string): SystemAgentHistoryMessage {
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

class SystemAgentTuiBackend implements TuiBackend {
  readonly connection = { url: "openclaw local" };

  onEvent?: (evt: TuiEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;

  private seq = 0;
  private engine: SystemAgentChatEngine;
  private engineDisposal: Promise<void> | null = null;
  private inferenceFailure: SystemAgentInferenceUnavailableError | null = null;
  private handoff: SystemAgentOperation | null = null;
  private requestExit: (() => void) | null = null;
  private responseQueue: Promise<void> = Promise.resolve();
  private readonly messages: SystemAgentHistoryMessage[] = [];

  constructor(
    private readonly opts: SystemAgentTuiOptions,
    welcome: string,
    engine: SystemAgentChatEngine,
    private readonly route: SystemAgentTuiRoute,
  ) {
    this.engine = engine;
    this.appendMessage(message("assistant", welcome));
  }

  setRequestExitHandler(handler: () => void): void {
    this.requestExit = handler;
    if (this.inferenceFailure) {
      queueMicrotask(handler);
    }
  }

  consumeHandoff(): SystemAgentOperation | null {
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
    // The enclosing TUI owns terminal shutdown; OpenClaw has no transport to close.
  }

  async sendChat(opts: ChatSendOptions): Promise<{ runId: string }> {
    const runId = opts.runId ?? randomUUID();
    const text = opts.message.trim();
    this.appendMessage(message("user", opts.message));
    // Keep the backend queue ahead of the engine queue so a failed inference
    // turn can retire the session before an already-submitted host command runs.
    const response = this.responseQueue.then(() => this.respond(runId, opts.sessionKey, text));
    this.responseQueue = response.catch(() => undefined);
    return { runId };
  }

  async abortChat(): Promise<{ ok: boolean; aborted: boolean }> {
    return { ok: true, aborted: false };
  }

  async loadHistory(opts: { sessionKey: string; agentId?: string; limit?: number }): Promise<{
    sessionId: string;
    messages: SystemAgentHistoryMessage[];
    thinkingLevel: string;
    verboseLevel: string;
  }> {
    const limit = Math.min(opts.limit ?? SYSTEM_AGENT_HISTORY_LIMIT, SYSTEM_AGENT_HISTORY_LIMIT);
    return {
      sessionId: "openclaw",
      messages: limit > 0 ? this.messages.slice(-limit) : [],
      thinkingLevel: this.route.thinkingLevel,
      verboseLevel: "off",
    };
  }

  async listSessions(): Promise<TuiSessionList> {
    return {
      ts: Date.now(),
      path: "openclaw",
      count: 1,
      defaults: {
        model: this.route.model ?? null,
        modelProvider: this.route.modelProvider ?? null,
        contextTokens: null,
      },
      sessions: [
        {
          key: SYSTEM_AGENT_SESSION_KEY,
          sessionId: "openclaw",
          displayName: "OpenClaw",
          updatedAt: Date.now(),
          thinkingLevel: this.route.thinkingLevel,
          verboseLevel: "off",
          model: this.route.model,
          modelProvider: this.route.modelProvider,
        },
      ],
    };
  }

  async listAgents(): Promise<TuiAgentsList> {
    return {
      defaultId: SYSTEM_AGENT_ID,
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: SYSTEM_AGENT_ID, kind: "system", name: "OpenClaw" }],
    };
  }

  async patchSession(opts: SessionsPatchParams): Promise<SessionsPatchResult> {
    if (opts.model !== undefined) {
      throw new Error(
        "OpenClaw cannot change the model inside its active verified session. Exit and run `openclaw onboard`, then start OpenClaw again.",
      );
    }
    return {
      ok: true,
      path: "openclaw",
      key: SYSTEM_AGENT_SESSION_KEY,
      entry: {
        sessionId: "openclaw",
        displayName: "OpenClaw",
        updatedAt: Date.now(),
      },
      resolved: {},
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
    this.messages.length = 0;
    this.appendMessage(message("assistant", formatSystemAgentStartupMessage(overview)));
    return { ok: true };
  }

  async createSession(_opts: TuiSessionCreateOptions) {
    await this.resetSession();
    return {
      ok: true as const,
      key: SYSTEM_AGENT_SESSION_KEY,
      entry: { sessionId: "openclaw", updatedAt: Date.now() },
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

  private appendMessage(entry: SystemAgentHistoryMessage): void {
    this.messages.push(entry);
    if (this.messages.length > SYSTEM_AGENT_HISTORY_LIMIT) {
      this.messages.splice(0, this.messages.length - SYSTEM_AGENT_HISTORY_LIMIT);
    }
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
      text || "OpenClaw listened and found nothing to change.",
    );
    this.appendMessage(assistant);
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
        // The outer loop owns interactive handoffs after the OpenClaw TUI exits.
        this.handoff = reply.handoff;
        queueMicrotask(() => this.requestExit?.());
      } else if (reply.action === "exit") {
        queueMicrotask(() => this.requestExit?.());
      }
      this.emitFinal(runId, sessionKey, reply.text);
    } catch (error) {
      if (isSystemAgentInferenceUnavailableError(error)) {
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
  handoff: Extract<SystemAgentOperation, { kind: "open-setup" }>,
  opts: SystemAgentTuiOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  if (
    handoff.target !== "channels" &&
    handoff.target !== "search" &&
    handoff.target !== "gateway"
  ) {
    runtime.error(
      "Setup cannot replace the inference route powering OpenClaw. Exit and run `openclaw onboard`, then start OpenClaw again.",
    );
    return;
  }
  const beforePersistentEffect = async () => {
    const binding = opts?.verifiedInference;
    if (!binding) {
      throw new SystemAgentInferenceUnavailableError("conversation");
    }
    try {
      const { resolvePersistentApplyInference } = await import("./setup-inference.js");
      const route = await resolvePersistentApplyInference({
        binding,
        runtime,
        deps: opts.deps,
      });
      if (route) {
        return;
      }
    } catch (error) {
      if (isSystemAgentInferenceUnavailableError(error)) {
        throw error;
      }
      throw new SystemAgentInferenceUnavailableError("conversation", [error]);
    }
    throw new SystemAgentInferenceUnavailableError("conversation");
  };
  if (handoff.target === "gateway") {
    if (opts.runGatewaySetupHandoff) {
      await opts.runGatewaySetupHandoff(runtime, beforePersistentEffect);
      runtime.log("Done — gateway settings saved. Run `openclaw gateway restart` to apply them.");
      return;
    }
    const { createClackPrompter, hostedSetup } = await loadHostedSetupForTui();
    await hostedSetup.runHostedGatewaySetup(
      createClackPrompter(),
      async () => await beforePersistentEffect(),
      runtime,
    );
    runtime.log("Done — gateway settings saved. Run `openclaw gateway restart` to apply them.");
    return;
  }
  if (handoff.target === "search") {
    if (opts.runSearchSetupHandoff) {
      await opts.runSearchSetupHandoff(runtime, beforePersistentEffect);
      return;
    }
    const { createClackPrompter, hostedSetup } = await loadHostedSetupForTui();
    await hostedSetup.runHostedSearchSetup(
      createClackPrompter(),
      async () => await beforePersistentEffect(),
      runtime,
    );
    return;
  }
  const runChannelsAdd =
    opts.runChannelsAdd ?? (await import("../commands/channels/add.js")).channelsAddCommand;
  await runChannelsAdd(handoff.channel ? { channel: handoff.channel } : {}, runtime, {
    hasFlags: false,
    beforePersistentEffect,
  });
}

export async function runSystemAgentTui(
  opts: SystemAgentTuiOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const binding = opts?.verifiedInference;
  if (!binding) {
    throw new SystemAgentInferenceUnavailableError("conversation");
  }
  // Snapshot the verified owner so an external options mutation cannot swap
  // authority between the chat shell and a later host-owned wizard handoff.
  const boundOpts: SystemAgentTuiOptions = { ...opts, verifiedInference: binding };
  let nextInput: string | undefined;
  let welcomeVariant = boundOpts.welcomeVariant;
  for (;;) {
    const route = await requireTuiVerifiedInference(boundOpts);
    // A returned agent request is single-use; a later wizard handoff must not
    // replay it when OpenClaw re-enters the chat shell.
    const initialMessage = nextInput;
    const engine = createChatEngine(boundOpts);
    let welcome: string;
    if (welcomeVariant === "onboarding") {
      // The terminal renders prose only; the typed card question is web-only.
      welcome = (
        await buildOnboardingWelcome({
          engine,
          localRecovery: true,
          ...(boundOpts.setupWorkspace ? { workspace: boundOpts.setupWorkspace } : {}),
          ...(boundOpts.setupAgentName ? { agentName: boundOpts.setupAgentName } : {}),
        })
      ).text;
    } else {
      welcome = formatSystemAgentStartupMessage(await loadOverviewForTui(boundOpts));
      engine.noteAssistantMessage(welcome);
    }
    // The onboarding greeting applies to the first shell only; re-entry after
    // an agent handoff uses the normal repair-oriented startup message.
    welcomeVariant = undefined;
    const backend = new SystemAgentTuiBackend(boundOpts, welcome, engine, route);
    const runTui = boundOpts.runTui ?? (await import("../tui/tui.js")).runTui;
    try {
      await runTui({
        local: true,
        session: SYSTEM_AGENT_SESSION_KEY,
        historyLimit: SYSTEM_AGENT_HISTORY_LIMIT,
        backend,
        config: {},
        title: "openclaw setup",
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
        "OpenClaw cannot replace its active inference route. Run `openclaw onboard` outside this session, then start OpenClaw again.",
      );
      return;
    }
    if (handoff.kind === "open-setup") {
      await runSetupHandoff(handoff, boundOpts, runtime);
      return;
    }
    const result = await executeSystemAgentOperation(handoff, runtime, {
      approved: true,
      deps: boundOpts.deps,
    });
    nextInput = result.nextInput;
    if (!nextInput?.trim() && !result.returnToShell) {
      return;
    }
  }
}

async function requireTuiVerifiedInference(
  opts: SystemAgentTuiOptions,
): Promise<SystemAgentTuiRoute> {
  const binding = opts?.verifiedInference;
  if (!binding) {
    throw new SystemAgentInferenceUnavailableError("conversation");
  }
  try {
    const verified = await resolveSystemAgentVerifiedInferenceState(binding, opts.deps);
    if (verified) {
      const { config, route } = verified;
      const [{ getPreparedModelCatalogSnapshot }, { resolveThinkingDefault }] = await Promise.all([
        import("../agents/prepared-model-catalog.js"),
        import("../agents/model-thinking-default.js"),
      ]);
      // Catalog metadata improves the label but must not become a new startup
      // dependency after this exact inference route has already been verified.
      const catalog = getPreparedModelCatalogSnapshot({
        config,
        agentId: route.agentId,
        agentDir: route.agentDir,
        readOnly: true,
      })?.entries;
      const model = splitModelRef(route.modelLabel);
      return {
        model: model.model,
        modelProvider: model.provider,
        thinkingLevel: resolveThinkingDefault({
          cfg: route.runConfig,
          provider: route.provider,
          model: route.model,
          catalog,
        }),
      };
    }
  } catch (error) {
    throw new SystemAgentInferenceUnavailableError("conversation", [error]);
  }
  throw new SystemAgentInferenceUnavailableError("conversation");
}
