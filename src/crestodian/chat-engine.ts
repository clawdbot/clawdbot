// Crestodian chat engine: transport-agnostic conversation over typed operations.
import { isSensitiveConfigPath } from "../config/sensitive-paths.js";
import type { RuntimeEnv } from "../runtime.js";
import { WizardSession, type WizardStep } from "../wizard/session.js";
import {
  cleanupCrestodianAgentSession,
  createCrestodianAgentSession,
  runCrestodianAgentTurn,
  type CrestodianAgentSession,
  type CrestodianAgentTurnRunner,
} from "./agent-turn.js";
import {
  classifyCrestodianApprovalText,
  type CrestodianApprovalClassifier,
  type CrestodianApprovalIntent,
} from "./approval-intent.js";
import type { CrestodianAssistantPlanner, CrestodianAssistantTurn } from "./assistant.js";
import { approvalQuestion } from "./dialogue.js";
import {
  describeCrestodianPersistentOperation,
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  parseCrestodianOperation,
  type CrestodianCommandDeps,
  type CrestodianOperation,
  type CrestodianOperationResult,
} from "./operations.js";
import { loadCrestodianOverview, type CrestodianOverview } from "./overview.js";

/**
 * One conversation with Crestodian, independent of transport. The TUI backend
 * and the gateway `crestodian.chat` RPC both drive this engine, so onboarding
 * behaves the same in a terminal and in the macOS app.
 *
 * The conversation is AI-only: every message is an AI turn (agent loop first,
 * single-turn planner as fallback), and approval of pending mutations is
 * judged from the user's own words by a host-run classifier — never by the
 * conversation model itself, which cannot self-approve (see
 * crestodian-tool.ts). The anchored typed-command grammar is not a chat
 * feature: it only takes over when no model is usable at all (fresh machine,
 * logged-out CLIs, broken config), so repair keeps working configless.
 * Hosted wizards resolve deterministically because they are structured forms,
 * not conversation.
 */
export type CrestodianChatEngineOptions = {
  yes?: boolean;
  deps?: CrestodianCommandDeps;
  planWithAssistant?: CrestodianAssistantPlanner;
  /** Test seam for the embedded agent-loop turn runner. */
  runAgentTurn?: CrestodianAgentTurnRunner;
  /** Test seam for the approval-intent classifier. */
  classifyApproval?: CrestodianApprovalClassifier;
  /** Where side effects run; the gateway surface never manages its own daemon. */
  surface?: "cli" | "gateway";
  /** Test seam for the channel-setup wizard hosted by the chat bridge. */
  runChannelSetupWizard?: (channel: string, prompter: WizardPrompterLike) => Promise<void>;
  /** Test seam for model-provider setup hosted by gateway chat. */
  runModelSetupWizard?: (
    workspace: string | undefined,
    prompter: WizardPrompterLike,
  ) => Promise<void>;
};

export type CrestodianChatReplyAction = "none" | "exit" | "open-tui" | "open-setup";

export type CrestodianChatReply = {
  text: string;
  action: CrestodianChatReplyAction;
  /** The next hosted-wizard reply contains a secret and must be masked/redacted by hosts. */
  sensitive?: boolean;
  /** Present when the host must leave chat for an interactive handoff. */
  handoff?: CrestodianOperation;
};

type WizardPrompterLike = import("../wizard/prompts.js").WizardPrompter;

type ActiveWizardBridge = {
  session: WizardSession;
  step: WizardStep | null;
  kind: "channel" | "model";
  label: string;
  /** Channel to auto-answer in the first selection step ("connect telegram"). */
  autoSelectChannel?: string;
};

type CaptureRuntime = RuntimeEnv & {
  read: () => string;
};

function createHostedWizardRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return {
    ...runtime,
    exit: (code): never => {
      throw new Error(`hosted wizard exited with code ${String(code)}`);
    },
  };
}

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

function defaultChannelSetupWizardRunner(
  channel: string,
): (prompter: WizardPrompterLike) => Promise<void> {
  return async (prompter) => {
    const [
      { readSetupConfigFileSnapshot, writeWizardConfigFile },
      {
        createChannelOnboardingPostWriteHookCollector,
        runCollectedChannelOnboardingPostWriteHooks,
        setupChannels,
      },
    ] = await Promise.all([
      import("../wizard/setup.shared.js"),
      import("../commands/onboard-channels.js"),
    ]);
    const snapshot = await readSetupConfigFileSnapshot();
    const baseConfig = snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
    const { defaultRuntime } = await import("../runtime.js");
    const runtime = createHostedWizardRuntime(defaultRuntime);
    const postWriteHooks = createChannelOnboardingPostWriteHookCollector();
    const nextConfig = await setupChannels(baseConfig, runtime, prompter, {
      initialSelection: [channel],
      forceAllowFromChannels: [channel],
      allowIMessageInstall: true,
      allowSignalInstall: true,
      deferStatusUntilSelection: true,
      quickstartDefaults: true,
      skipDmPolicyPrompt: true,
      skipConfirm: true,
      onPostWriteHook: (hook) => postWriteHooks.collect(hook),
    });
    const committedConfig = await writeWizardConfigFile(nextConfig, {
      allowConfigSizeDrop: false,
      migrationBaseConfig: baseConfig,
    });
    await runCollectedChannelOnboardingPostWriteHooks({
      hooks: postWriteHooks.drain(),
      cfg: committedConfig,
      runtime,
    });
  };
}

function defaultModelSetupWizardRunner(
  workspace: string | undefined,
): (prompter: WizardPrompterLike) => Promise<void> {
  return async (prompter) => {
    const [{ runCrestodianModelSetup }, { defaultRuntime }] = await Promise.all([
      import("./model-setup.js"),
      import("../runtime.js"),
    ]);
    await runCrestodianModelSetup({
      workspace,
      prompter,
      runtime: createHostedWizardRuntime(defaultRuntime),
    });
  };
}

function formatWizardOptions(step: WizardStep): string[] {
  return (step.options ?? []).map((option, index) => {
    const hint = option.hint ? ` — ${option.hint}` : "";
    return `${index + 1}. ${option.label}${hint}`;
  });
}

function renderWizardStep(step: WizardStep): string {
  const lines: string[] = [];
  if (step.title) {
    lines.push(`**${step.title}**`);
  }
  if (step.message) {
    lines.push(step.message);
  }
  switch (step.type) {
    case "select":
      lines.push(...formatWizardOptions(step), "Reply with a number.");
      break;
    case "multiselect":
      lines.push(...formatWizardOptions(step), "Reply with numbers (e.g. 1,3) or `none`.");
      break;
    case "confirm":
      lines.push("Reply yes or no.");
      break;
    case "text":
      if (step.placeholder) {
        lines.push(`(e.g. ${step.placeholder})`);
      }
      lines.push("Type your answer.");
      break;
    default:
      break;
  }
  lines.push("Say `cancel` to stop this setup.");
  return lines.filter(Boolean).join("\n");
}

/** Map a chat reply to a wizard step answer; null means "could not parse". */
function parseWizardAnswer(step: WizardStep, text: string): { value: unknown } | null {
  const trimmed = text.trim();
  if (step.type === "confirm") {
    // Wizard confirms are structured form fields, so the closed-list
    // classifier decides; ambiguous answers re-render the prompt.
    const intent = classifyCrestodianApprovalText(trimmed);
    if (intent === "approve") {
      return { value: true };
    }
    if (intent === "decline") {
      return { value: false };
    }
    return null;
  }
  if (step.type === "text") {
    return { value: trimmed };
  }
  const options = step.options ?? [];
  const matchOption = (token: string) => {
    const index = Number(token);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return options[index - 1];
    }
    const lower = token.toLowerCase();
    return options.find(
      (option) =>
        option.label.toLowerCase() === lower ||
        (typeof option.value === "string" && option.value.toLowerCase() === lower),
    );
  };
  if (step.type === "select") {
    const option = matchOption(trimmed);
    return option ? { value: option.value } : null;
  }
  if (step.type === "multiselect") {
    if (/^none$/i.test(trimmed)) {
      return { value: [] };
    }
    const tokens = trimmed
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const values: unknown[] = [];
    for (const token of tokens) {
      const option = matchOption(token);
      if (!option) {
        return null;
      }
      values.push(option.value);
    }
    return { value: values };
  }
  // note/progress/action steps advance on any input.
  return { value: step.type === "action" ? true : undefined };
}

function formatOperationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `That did not go through: ${message}`;
}

/**
 * A typed `config set` against a sensitive path carries a raw secret; the
 * stored history feeds future planner prompts (and CLI-harness transcripts),
 * so the value is masked the same way hosted-wizard secrets are.
 */
function redactSensitiveCommandText(text: string): string {
  const operation = parseCrestodianOperation(text);
  if (operation.kind === "config-set" && isSensitiveConfigPath(operation.path)) {
    return `config set ${operation.path} <redacted secret>`;
  }
  return text;
}

/**
 * Hard ceiling for one AI turn. Planner backends carry their own timeouts,
 * but a wedged local CLI (heavy user config, hung app-server) must never
 * freeze the conversation — after this we answer deterministically.
 */
const ASSISTANT_TURN_DEADLINE_MS = 60_000;
// Agent-loop turns include tool calls (config writes, doctor); allow longer.
const AGENT_TURN_DEADLINE_MS = 180_000;

async function withDeadline<T>(work: Promise<T>, fallback: T, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), deadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function formatPendingOperationForAssistant(operation: CrestodianOperation): string {
  const description = describeCrestodianPersistentOperation(operation);
  return operation.kind === "setup"
    ? `${description}. Exact setup JSON: ${JSON.stringify(operation)}. Copy inferenceRoutes exactly unless the user explicitly chooses another model.`
    : description;
}

function preservePendingSetupSelection(
  pending: CrestodianOperation | null,
  operation: CrestodianOperation,
): CrestodianOperation {
  if (pending?.kind !== "setup" || operation.kind !== "setup") {
    return operation;
  }
  const pendingModel = pending.model?.trim();
  const requestedModel = operation.model?.trim();
  if (requestedModel && requestedModel !== pendingModel) {
    return operation;
  }
  return {
    ...operation,
    ...(requestedModel ? {} : pendingModel ? { model: pendingModel } : {}),
    ...(pending.inferenceRoutes !== undefined
      ? { inferenceRoutes: pending.inferenceRoutes.map((route) => ({ ...route })) }
      : {}),
  };
}

export class CrestodianChatEngine {
  private pending: CrestodianOperation | null = null;
  private wizardBridge: ActiveWizardBridge | null = null;
  private lastSensitiveChannel: string | undefined;
  private awaitingSetupChannel = false;
  private hostProposalResolution: "approved" | "declined" | undefined;
  private readonly history: CrestodianAssistantTurn[] = [];
  private readonly agentSession: CrestodianAgentSession = createCrestodianAgentSession();
  /** Turns run strictly one at a time; interleaved handles corrupt wizard/pending state. */
  private turnQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: CrestodianChatEngineOptions = {}) {}

  /**
   * Seed a proposed operation that the user's next approval will apply. Used
   * by first-run onboarding: the welcome message states the plan, the user
   * just agrees.
   */
  propose(operation: CrestodianOperation): string {
    this.clearPendingProposals();
    this.pending = operation;
    return describeCrestodianPersistentOperation(operation);
  }

  hasPendingProposal(): boolean {
    return this.pending !== null;
  }

  /** Record a host-rendered assistant message (welcome) so AI turns see it. */
  noteAssistantMessage(text: string): void {
    this.history.push({ role: "assistant", text });
  }

  async dispose(): Promise<void> {
    this.wizardBridge?.session.cancel();
    this.wizardBridge = null;
    this.lastSensitiveChannel = undefined;
    this.awaitingSetupChannel = false;
    await cleanupCrestodianAgentSession(this.agentSession);
  }

  async handle(text: string): Promise<CrestodianChatReply> {
    const turn = this.turnQueue.then(() => this.handleSerialized(text));
    // The queue must survive a failed turn or every later message would reject.
    this.turnQueue = turn.catch(() => undefined);
    return await turn;
  }

  private async handleSerialized(text: string): Promise<CrestodianChatReply> {
    // Snapshot before resolving: wizard answers to sensitive steps (tokens,
    // passwords) must never enter the AI-visible history.
    const sensitiveTurn = this.wizardBridge?.step?.sensitive === true;
    const reply = await this.resolveTurn(text);
    this.history.push({
      role: "user",
      text: sensitiveTurn ? "<redacted secret>" : redactSensitiveCommandText(text),
    });
    if (reply.text) {
      this.history.push({ role: "assistant", text: reply.text });
    }
    return {
      ...reply,
      ...(this.wizardBridge?.step?.sensitive === true ? { sensitive: true } : {}),
    };
  }

  private async resolveTurn(text: string): Promise<CrestodianChatReply> {
    if (this.wizardBridge) {
      // A hosted wizard consumes every reply until it finishes or is cancelled.
      return { text: await this.resolveWizardBridgeReply(text), action: "none" };
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return {
        text: "Tiny claw tap: tell me what you want — setup, repair, channels, anything config.",
        action: "none",
      };
    }
    if (/^(quit|exit)$/i.test(trimmed)) {
      // Leaving the process is a host action, not a conversation the AI owns.
      return { text: "Crestodian retracts into shell. Bye.", action: "exit" };
    }
    if (this.awaitingSetupChannel) {
      if (/^(cancel|abort|stop)$/i.test(trimmed)) {
        this.awaitingSetupChannel = false;
        return { text: "Channel wizard handoff cancelled.", action: "none" };
      }
      if (!/^[a-z0-9_-]+$/i.test(trimmed)) {
        return {
          text: "Reply with one channel id, such as `slack` or `telegram`, or say `cancel`.",
          action: "none",
        };
      }
      this.awaitingSetupChannel = false;
      return await this.runOperation(
        { kind: "open-setup", target: "channels", channel: trimmed.toLowerCase() },
        undefined,
      );
    }

    // Secret hygiene: an exact `config set` on a sensitive path carries a raw
    // token and must never reach a model. It runs on the deterministic path
    // (redacted proposal + approval), matching the wizard's masked-input rules.
    const typed = parseCrestodianOperation(text);
    if (typed.kind === "config-set" && isSensitiveConfigPath(typed.path)) {
      return await this.runOperation(typed, undefined);
    }

    // Approval is judged from the user's own words, host-side. The classifier
    // only runs while a proposal is pending, and "other" (questions, new
    // requests) keeps the proposal pending and lets the AI carry on.
    const intent = await this.classifyApprovalIntent(text);
    if (this.pending) {
      if (intent === "approve") {
        return await this.applyPendingProposal();
      }
      if (intent === "decline") {
        const skippedModelSetup = this.pending.kind === "model-setup";
        this.clearPendingProposals();
        this.hostProposalResolution = "declined";
        return {
          text: skippedModelSetup
            ? "Skipped. Crestodian remains available in deterministic mode; say `configure model provider` when you are ready."
            : "Skipped. No barnacles on config today.",
          action: "none",
        };
      }
    }
    if (intent === "decline") {
      // A declined agent-loop proposal must never stay armable: void the
      // registered hash now and let the AI acknowledge conversationally.
      this.agentSession.proposalRef.current = undefined;
    }

    return await this.resolveAssistantTurn(text, intent === "approve");
  }

  private async classifyApprovalIntent(text: string): Promise<CrestodianApprovalIntent> {
    const hasProposal =
      this.pending !== null || this.agentSession.proposalRef.current !== undefined;
    if (!hasProposal) {
      return "other";
    }
    const classify =
      this.opts.classifyApproval ??
      (await import("./approval-intent.js")).classifyCrestodianApprovalIntent;
    return await classify({
      message: text,
      ...(this.pending ? { proposal: describeCrestodianPersistentOperation(this.pending) } : {}),
    });
  }

  private async applyPendingProposal(): Promise<CrestodianChatReply> {
    const pending = this.pending;
    this.clearPendingProposals();
    this.hostProposalResolution = "approved";
    if (!pending) {
      return { text: "", action: "none" };
    }
    if (pending.kind === "channel-setup") {
      return { text: await this.startChannelSetupWizard(pending.channel), action: "none" };
    }
    if (pending.kind === "model-setup") {
      return await this.startModelSetup(pending.workspace);
    }
    const capture = createCaptureRuntime();
    let result: CrestodianOperationResult | undefined;
    try {
      result = await executeCrestodianOperation(pending, capture, {
        approved: true,
        deps: this.commandDeps(),
      });
    } catch (error) {
      capture.error(formatOperationError(error));
    }
    const verify = result?.applied ? await this.verifyConfigAfterWrite() : null;
    const followUp = this.armFollowUp(result?.followUp);
    return {
      text: [capture.read() || "Applied. Audit entry written.", verify, followUp]
        .filter(Boolean)
        .join("\n\n"),
      action: "none",
    };
  }

  /**
   * AI turn: the custodian persona answers and acts through the ring-zero
   * tool. Falls back to the single-turn planner, then to the anchored typed
   * grammar when no model backend is usable at all.
   */
  private async resolveAssistantTurn(
    text: string,
    approvalArmed: boolean,
  ): Promise<CrestodianChatReply> {
    const overview = await this.loadOverview();

    // Preferred path: the real agent loop (embedded runtime, ring-zero tool,
    // persistent session). It acts through audited tool calls, so its reply is
    // final — no engine-side command extraction or approval bookkeeping.
    const agentTurn = this.opts.runAgentTurn ?? runCrestodianAgentTurn;
    const resolutionMarker = this.hostProposalResolution
      ? `[host-proposal-resolved] The previously host-seeded proposal was ${this.hostProposalResolution}. Do not present it as pending.\n`
      : "";
    try {
      const loopReply = await withDeadline(
        agentTurn({
          input: `${resolutionMarker}${
            this.pending
              ? // Hand a host-seeded proposal (onboarding welcome) to the loop so
                // the conversation can reshape it through the tool handshake.
                `[pending-proposal] Awaiting the user's approval: ${formatPendingOperationForAssistant(this.pending)}. It is already host-seeded; if they want it (or a variant), drive it through the crestodian tool yourself.\n${text}`
              : text
          }`,
          overview,
          surface: this.opts.surface ?? "cli",
          // Mutations unlock only on host-verified approval of THIS message;
          // the model cannot self-approve (see crestodian-tool.ts).
          approvalArmed,
          session: this.agentSession,
        }).catch(() => null),
        null,
        AGENT_TURN_DEADLINE_MS,
      );
      if (loopReply?.text) {
        // The native loop saw this marker. Keep it queued across planner
        // fallback so a recovered persistent session cannot resurrect a
        // host proposal that was already approved or declined.
        this.hostProposalResolution = undefined;
        // A plain answer must not discard the host-seeded approval transaction.
        // Clear it only once the loop registers a replacement or takes a handoff.
        if (loopReply.directive) {
          this.clearPendingProposals();
        } else if (this.agentSession.proposalRef.current !== undefined) {
          // The loop replaced the host proposal. Keep its newly registered hash
          // so the next host-classified approval can arm that exact operation.
          this.pending = null;
        }
        return await this.applyAgentTurnReply(loopReply);
      }
    } catch {
      // Fall through to the single-turn planner.
    }

    const planner =
      this.opts.planWithAssistant ?? (await import("./assistant.js")).planCrestodianCommand;
    const plan: Awaited<ReturnType<CrestodianAssistantPlanner>> = await withDeadline(
      planner({
        input: text,
        overview,
        history: this.history,
        ...(this.pending
          ? { pendingOperation: formatPendingOperationForAssistant(this.pending) }
          : {}),
      }).catch(() => null),
      null,
      ASSISTANT_TURN_DEADLINE_MS,
    ).catch(() => null);
    if (!plan) {
      return this.resolveDeterministicTurn(text);
    }

    const replyText = plan.reply ?? "";
    if (!plan.command) {
      return { text: replyText || "…", action: "none" };
    }
    const operation = preservePendingSetupSelection(
      this.pending,
      parseCrestodianOperation(plan.command),
    );
    if (operation.kind === "none") {
      // The model suggested something outside the vocabulary; show only its reply.
      return { text: replyText || "…", action: "none" };
    }
    // Security contract: surface the interpreted command and model before
    // anything runs (docs/cli/crestodian.md, AI conversation).
    const provenance = `(${plan.modelLabel ?? "model"} → \`${plan.command}\`)`;
    const executed = await this.runOperation(operation, provenance);
    return {
      ...executed,
      text: [replyText, executed.text].filter(Boolean).join("\n\n"),
    };
  }

  private async applyAgentTurnReply(loopReply: {
    text: string;
    directive?: import("./agent-turn.js").CrestodianAgentTurnDirective;
  }): Promise<CrestodianChatReply> {
    if (loopReply.directive?.kind === "channel-setup") {
      const wizardIntro = await this.startChannelSetupWizard(loopReply.directive.channel);
      return {
        text: [loopReply.text, wizardIntro].filter(Boolean).join("\n\n"),
        action: "none",
      };
    }
    if (loopReply.directive?.kind === "model-setup") {
      const setup = await this.startModelSetup(loopReply.directive.workspace);
      return {
        ...setup,
        text: [loopReply.text, setup.text].filter(Boolean).join("\n\n"),
      };
    }
    if (loopReply.directive?.kind === "open-tui") {
      return {
        text: loopReply.text,
        action: "open-tui",
        handoff: loopReply.directive,
      };
    }
    if (loopReply.directive?.kind === "open-setup") {
      const handoff = await this.runOperation(loopReply.directive, undefined);
      return {
        ...handoff,
        text: [loopReply.text, handoff.text].filter(Boolean).join("\n\n"),
      };
    }
    return { text: loopReply.text, action: "none" };
  }

  /**
   * Last resort with zero usable models: the anchored typed grammar keeps
   * setup/repair working on a fresh or broken machine (docs/cli/crestodian.md,
   * configless contract). This is never reached while any model answers.
   */
  private async resolveDeterministicTurn(text: string): Promise<CrestodianChatReply> {
    const direct = parseCrestodianOperation(text);
    if (direct.kind !== "none") {
      return await this.runOperation(direct, undefined);
    }
    return {
      text: [
        "I could not reach a model for that (deterministic mode).",
        "I can run doctor/status/health, check or restart Gateway, list agents/models, configure a model provider, set default model, connect channels (`connect telegram`), show audit, or switch to your agent TUI.",
      ].join("\n"),
      action: "none",
    };
  }

  private async runOperation(
    operation: CrestodianOperation,
    provenance: string | undefined,
  ): Promise<CrestodianChatReply> {
    if (operation.kind === "open-tui") {
      return {
        text: "Opening your normal agent TUI. Use /crestodian there to come back.",
        action: "open-tui",
        handoff: operation,
      };
    }

    if (operation.kind === "open-setup") {
      if (this.opts.surface === "gateway") {
        return {
          text: "The app owns the setup screens here — use Settings, or run `openclaw onboard` in a terminal.",
          action: "none",
        };
      }
      let handoff = operation;
      if (handoff.target === "channels" && !handoff.channel) {
        const channel = this.lastSensitiveChannel;
        if (!channel) {
          this.awaitingSetupChannel = true;
          return {
            text: "Which channel should I open in the masked terminal wizard?",
            action: "none",
          };
        }
        this.lastSensitiveChannel = undefined;
        handoff = { ...handoff, channel };
      }
      this.awaitingSetupChannel = false;
      const label =
        handoff.target === "guided"
          ? "guided setup"
          : handoff.target === "classic"
            ? "classic setup"
            : `${handoff.channel ?? "channel"} setup`;
      return {
        text: `Opening the ${label} wizard.`,
        action: "open-setup",
        handoff,
      };
    }

    if (operation.kind === "channel-setup") {
      // Starting the wizard is not a write; the wizard collects explicit
      // answers and commits only at the end.
      return { text: await this.startChannelSetupWizard(operation.channel), action: "none" };
    }
    if (operation.kind === "model-setup") {
      return await this.startModelSetup(operation.workspace);
    }

    const capture = createCaptureRuntime();
    if (isPersistentCrestodianOperation(operation) && !this.opts.yes) {
      this.clearPendingProposals();
      this.pending = operation;
      await executeCrestodianOperation(operation, capture, {
        approved: false,
        deps: this.commandDeps(),
      });
      return {
        text: [provenance, capture.read(), approvalQuestion(operation)]
          .filter(Boolean)
          .join("\n\n"),
        action: "none",
      };
    }

    let result: CrestodianOperationResult | undefined;
    try {
      result = await executeCrestodianOperation(operation, capture, {
        approved: this.opts.yes === true || !isPersistentCrestodianOperation(operation),
        deps: this.commandDeps(),
      });
    } catch (error) {
      capture.error(formatOperationError(error));
    }
    const verify = result?.applied ? await this.verifyConfigAfterWrite() : null;
    const followUp = this.armFollowUp(result?.followUp);
    const reply = [provenance, capture.read(), verify, followUp].filter(Boolean).join("\n\n");
    if (operation.kind === "none" && reply.includes("Bye.")) {
      return { text: reply, action: "exit" };
    }
    return { text: reply, action: "none" };
  }

  async loadOverview(): Promise<CrestodianOverview> {
    if (this.opts.deps?.loadOverview) {
      return await this.opts.deps.loadOverview();
    }
    return await loadCrestodianOverview();
  }

  /**
   * Post-write hook: re-validate openclaw.json after every applied operation.
   * On failure the exact schema issues go straight back into the conversation
   * (and to the AI, which proposes one corrective command) so a bad write is
   * caught and fixed in the same chat instead of surfacing at gateway start.
   */
  private async verifyConfigAfterWrite(): Promise<string | null> {
    let issuesText: string;
    try {
      const { readConfigFileSnapshot } = await import("../config/config.js");
      const snapshot = await readConfigFileSnapshot();
      if (!snapshot.exists || snapshot.valid) {
        return null;
      }
      const issues = (snapshot.issues ?? []).map(
        (issue: { path?: string; message: string }) =>
          `${issue.path ? `${issue.path}: ` : ""}${issue.message}`,
      );
      issuesText = issues.length > 0 ? issues.join("\n") : "unknown validation failure";
    } catch {
      return null;
    }
    const notice = `⚠ openclaw.json failed validation after that write:\n${issuesText}`;
    const recovery = await this.resolveAssistantTurn(
      `[config-verify] The config file is now invalid:\n${issuesText}\nPropose one corrective command from the allowed list.`,
      false,
    );
    if (!recovery.text || recovery.text.includes("deterministic mode")) {
      return `${notice}\nSay \`doctor fix\` to repair it, or \`config schema <path>\` to check the expected shape.`;
    }
    return `${notice}\n\n${recovery.text}`;
  }

  private commandDeps(): CrestodianCommandDeps | undefined {
    if (!this.opts.deps && !this.opts.surface) {
      return undefined;
    }
    return {
      ...this.opts.deps,
      ...(this.opts.surface ? { setupSurface: this.opts.surface } : {}),
    };
  }

  private clearPendingProposals(): void {
    this.pending = null;
    this.agentSession.proposalRef.current = undefined;
  }

  private armFollowUp(operation: CrestodianOperation | undefined): string | null {
    if (operation?.kind !== "model-setup") {
      return null;
    }
    this.pending = operation;
    return [
      "No usable model provider is configured, so the agent cannot answer yet.",
      "Configure a model provider now? Say yes or no.",
    ].join("\n");
  }

  private async startChannelSetupWizard(channel: string): Promise<string> {
    this.lastSensitiveChannel = undefined;
    const runWizard =
      this.opts.runChannelSetupWizard ??
      ((ch: string, prompter: WizardPrompterLike) => defaultChannelSetupWizardRunner(ch)(prompter));
    const session = new WizardSession((prompter) => runWizard(channel, prompter));
    this.wizardBridge = {
      session,
      step: null,
      kind: "channel",
      label: channel,
      autoSelectChannel: channel,
    };
    return await this.pumpWizardBridge();
  }

  private async startModelSetup(workspace: string | undefined): Promise<CrestodianChatReply> {
    if ((this.opts.surface ?? "cli") === "cli") {
      return {
        text: "Opening masked model-provider setup in the terminal.",
        action: "open-tui",
        handoff: {
          kind: "model-setup",
          ...(workspace ? { workspace } : {}),
        },
      };
    }
    const runWizard =
      this.opts.runModelSetupWizard ??
      ((dir: string | undefined, prompter: WizardPrompterLike) =>
        defaultModelSetupWizardRunner(dir)(prompter));
    const session = new WizardSession((prompter) => runWizard(workspace, prompter));
    this.wizardBridge = { session, step: null, kind: "model", label: "model provider" };
    return { text: await this.pumpWizardBridge(), action: "none" };
  }

  /**
   * "connect telegram" already names the channel; answer the wizard's channel
   * selection step automatically instead of echoing the full channel wall.
   */
  private tryAutoSelectChannel(step: WizardStep): { value: unknown } | null {
    const bridge = this.wizardBridge;
    const channel = bridge?.autoSelectChannel;
    if (!bridge || !channel) {
      return null;
    }
    if (step.type !== "select" && step.type !== "multiselect") {
      return null;
    }
    const match = (step.options ?? []).find(
      (option) => typeof option.value === "string" && option.value.toLowerCase() === channel,
    );
    if (!match) {
      return null;
    }
    bridge.autoSelectChannel = undefined;
    return { value: step.type === "multiselect" ? [match.value] : match.value };
  }

  /** Advance the hosted wizard to the next interactive step (or completion). */
  private async pumpWizardBridge(): Promise<string> {
    const bridge = this.wizardBridge;
    if (!bridge) {
      return "";
    }
    const result = await bridge.session.next();
    if (result.done) {
      this.wizardBridge = null;
      const label = bridge.label;
      if (result.status === "done") {
        if (bridge.kind === "model") {
          const overview = await this.loadOverview();
          const verify = await this.verifyConfigAfterWrite();
          return [
            overview.defaultModel
              ? `Done — default model is ${overview.defaultModel}.`
              : "Model provider setup finished without a default model. Crestodian remains in deterministic mode.",
            verify ?? "",
          ]
            .filter(Boolean)
            .join("\n");
        }
        const { appendCrestodianAuditEntry } = await import("./audit.js");
        await appendCrestodianAuditEntry({
          operation: "channels.setup",
          summary: `Configured channel ${label} via chat setup`,
          details: { channel: label },
        });
        const verify = await this.verifyConfigAfterWrite();
        return [
          `Done — ${label} is configured.`,
          "Say `restart gateway` to apply channel changes, or `channels` to review.",
          verify ?? "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      if (result.status === "cancelled") {
        return bridge.kind === "model"
          ? "Model provider setup cancelled. Crestodian remains in deterministic mode."
          : "Channel setup cancelled. Nothing was changed beyond completed steps.";
      }
      return `${bridge.kind === "model" ? "Model provider" : "Channel"} setup stopped: ${result.error ?? "unknown error"}`;
    }
    bridge.step = result.step ?? null;
    if (bridge.step) {
      const auto = this.tryAutoSelectChannel(bridge.step);
      if (auto) {
        const step = bridge.step;
        bridge.step = null;
        await bridge.session.answer(step.id, auto.value);
        return await this.pumpWizardBridge();
      }
      if (this.opts.surface === "cli" && bridge.step.sensitive === true) {
        bridge.session.cancel();
        this.wizardBridge = null;
        if (bridge.kind === "model") {
          return [
            "Sensitive input is not accepted in the Crestodian chat because terminal input is visible.",
            "Run `openclaw configure --section model` to finish setup with masked prompts.",
          ].join("\n");
        }
        this.lastSensitiveChannel = bridge.label;
        return [
          "Sensitive input is not accepted in the Crestodian chat because terminal input is visible.",
          `Say \`open channel wizard\` and I'll hand you to the masked terminal wizard for ${bridge.label}, or run \`openclaw channels add --channel ${bridge.label}\` yourself later.`,
        ].join("\n");
      }
      if (bridge.step.type === "note" || bridge.step.type === "progress") {
        const step = bridge.step;
        bridge.step = null;
        await bridge.session.answer(step.id, undefined);
        const next = await this.pumpWizardBridge();
        return [renderWizardStep(step), next].filter(Boolean).join("\n\n");
      }
      if (bridge.step.type === "action" && bridge.step.executor !== "client") {
        const step = bridge.step;
        bridge.step = null;
        await bridge.session.answer(step.id, true);
        return await this.pumpWizardBridge();
      }
    }
    return bridge.step ? renderWizardStep(bridge.step) : "";
  }

  private async resolveWizardBridgeReply(text: string): Promise<string> {
    const bridge = this.wizardBridge;
    if (!bridge) {
      return "";
    }
    if (/^(cancel|abort|stop|quit|exit)$/i.test(text.trim())) {
      bridge.session.cancel();
      return await this.pumpWizardBridge();
    }
    const step = bridge.step;
    if (!step) {
      return await this.pumpWizardBridge();
    }
    const answer = parseWizardAnswer(step, text);
    if (!answer) {
      return ["I could not match that answer.", renderWizardStep(step)].join("\n");
    }
    const validationError = await bridge.session.answer(step.id, answer.value);
    if (validationError) {
      return [validationError, renderWizardStep(step)].join("\n\n");
    }
    return await this.pumpWizardBridge();
  }
}
