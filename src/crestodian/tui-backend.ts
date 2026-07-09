// Crestodian TUI backend runs setup-helper dialogue inside the shared local TUI shell.
import { randomUUID } from "node:crypto";
import type {
  SessionsPatchParams,
  SessionsPatchResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { ChannelsAddOptions } from "../commands/channels/add.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
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
import type { CrestodianModelSetupResult } from "./model-setup.js";
import { buildOnboardingWelcome } from "./onboarding-welcome.js";
import {
  executeCrestodianOperation,
  type CrestodianCommandDeps,
  type CrestodianOperation,
} from "./operations.js";
import { formatCrestodianStartupMessage, loadCrestodianOverview } from "./overview.js";

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
  /** Risk acknowledgement already collected by the calling onboarding flow. */
  setupAcceptRisk?: boolean;
  /** Test seam for the channel-setup wizard hosted by the chat bridge. */
  runChannelSetupWizard?: CrestodianChatEngineOptions["runChannelSetupWizard"];
  /** Test seam for masked terminal model setup after the TUI exits. */
  runModelSetup?: (params: {
    workspace?: string;
    prompter: import("../wizard/prompts.js").WizardPrompter;
    runtime: RuntimeEnv;
  }) => Promise<CrestodianModelSetupResult>;
  runGuidedSetup?: (opts: OnboardOptions, runtime: RuntimeEnv) => Promise<void>;
  runClassicSetup?: (opts: OnboardOptions, runtime: RuntimeEnv) => Promise<void>;
  runChannelsAdd?: (
    opts: ChannelsAddOptions,
    runtime: RuntimeEnv,
    params?: { hasFlags?: boolean },
  ) => Promise<unknown>;
};

type CrestodianHistoryMessage = {
  role: "assistant" | "user";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
};

const CRESTODIAN_AGENT_ID = "crestodian";
const CRESTODIAN_SESSION_KEY = buildAgentMainSessionKey({ agentId: CRESTODIAN_AGENT_ID });

function createEmbeddedModelSetupRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return {
    ...runtime,
    exit: (code): never => {
      throw new Error(`embedded model setup exited with code ${String(code)}`);
    },
  };
}

function createChatEngine(opts: CrestodianTuiOptions): CrestodianChatEngine {
  return new CrestodianChatEngine({
    yes: opts.yes,
    deps: opts.deps,
    planWithAssistant: opts.planWithAssistant,
    surface: "cli",
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
  private handoff: CrestodianOperation | null = null;
  private requestExit: (() => void) | null = null;
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
    // Reset drops in-flight approvals/wizards along with the transcript.
    await this.engine.dispose();
    this.engine = createChatEngine(this.opts);
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
    await this.engine.dispose();
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
      this.emitError(runId, sessionKey, error);
    }
  }
}

async function runSetupHandoff(
  handoff: Extract<CrestodianOperation, { kind: "open-setup" }>,
  opts: CrestodianTuiOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  if (handoff.target === "guided") {
    const runGuided =
      opts.runGuidedSetup ?? (await import("../commands/onboard-guided.js")).runGuidedOnboarding;
    await runGuided(
      {
        ...(opts.setupWorkspace ? { workspace: opts.setupWorkspace } : {}),
        ...(opts.setupAcceptRisk === true ? { acceptRisk: true } : {}),
      },
      runtime,
    );
    return;
  }
  if (handoff.target === "classic") {
    const runClassic =
      opts.runClassicSetup ??
      (await import("../commands/onboard-interactive.js")).runInteractiveSetup;
    await runClassic(
      {
        classic: true,
        ...(opts.setupWorkspace ? { workspace: opts.setupWorkspace } : {}),
        ...(opts.setupAcceptRisk === true ? { acceptRisk: true } : {}),
      },
      runtime,
    );
    return;
  }
  const runChannelsAdd =
    opts.runChannelsAdd ?? (await import("../commands/channels/add.js")).channelsAddCommand;
  await runChannelsAdd(handoff.channel ? { channel: handoff.channel } : {}, runtime, {
    hasFlags: false,
  });
}

export async function runCrestodianTui(
  opts: CrestodianTuiOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  let nextInput: string | undefined;
  let welcomeVariant = opts.welcomeVariant;
  for (;;) {
    // A returned agent request is single-use; a later wizard handoff must not
    // replay it when Crestodian re-enters the chat shell.
    const initialMessage = nextInput;
    nextInput = undefined;
    const engine = createChatEngine(opts);
    let welcome: string;
    if (welcomeVariant === "onboarding") {
      welcome = await buildOnboardingWelcome({
        engine,
        ...(opts.setupWorkspace ? { workspace: opts.setupWorkspace } : {}),
      });
    } else {
      welcome = formatCrestodianStartupMessage(await loadOverviewForTui(opts));
      engine.noteAssistantMessage(welcome);
    }
    // The onboarding greeting applies to the first shell only; re-entry after
    // an agent handoff uses the normal repair-oriented startup message.
    welcomeVariant = undefined;
    const backend = new CrestodianTuiBackend(opts, welcome, engine);
    const runTui = opts.runTui ?? defaultRunTui;
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
      const [{ createClackPrompter }, { runCrestodianModelSetup }] = await Promise.all([
        import("../wizard/clack-prompter.js"),
        import("./model-setup.js"),
      ]);
      const runModelSetup = opts.runModelSetup ?? runCrestodianModelSetup;
      try {
        const result = await runModelSetup({
          ...(handoff.workspace ? { workspace: handoff.workspace } : {}),
          prompter: createClackPrompter(),
          runtime: createEmbeddedModelSetupRuntime(runtime),
        });
        runtime.log(
          result.model
            ? `Default model configured: ${result.model}`
            : "Model provider setup finished without a default model.",
        );
      } catch (error) {
        const { WizardCancelledError } = await import("../wizard/prompts.js");
        if (!(error instanceof WizardCancelledError)) {
          runtime.error(
            `Model provider setup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      continue;
    }
    if (handoff.kind === "open-setup") {
      await runSetupHandoff(handoff, opts, runtime);
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
