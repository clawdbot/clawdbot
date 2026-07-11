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
  CrestodianInferenceUnavailableError,
  isCrestodianInferenceUnavailableError,
} from "./inference-error.js";
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
import {
  resolveCrestodianVerifiedInferenceRoute,
  type CrestodianVerifiedInferenceBinding,
} from "./verified-inference.js";

/**
 * One conversation with Crestodian, independent of transport. The TUI backend
 * and the gateway `crestodian.chat` RPC both drive this engine, so onboarding
 * behaves the same in a terminal and in the macOS app.
 *
 * The conversation is AI-backed: free-form messages run through the agent loop
 * first and the single-turn planner second. Approval of pending mutations is
 * judged from the user's own words by a host-run classifier — never by the
 * conversation model itself, which cannot self-approve (see
 * crestodian-tool.ts). Hosted wizard replies and host navigation remain
 * deterministic because they are structured UI actions, not conversation.
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
  runChannelSetupWizard?: (
    channel: string,
    prompter: WizardPrompterLike,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  ) => Promise<void>;
  /** Exact route/credential that passed the host's live inference gate. */
  readonly verifiedInference: CrestodianVerifiedInferenceBinding;
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
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
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
    if (!snapshot.exists || !snapshot.valid || !snapshot.hash) {
      throw new Error(
        "Channel setup requires a valid saved config snapshot. Run `openclaw doctor --fix`, then retry.",
      );
    }
    const baseConfig = snapshot.sourceConfig ?? snapshot.config;
    const baseHash = snapshot.hash;
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
      beforePersistentEffect: async () => await beforePersistentApply(runtime),
      onPostWriteHook: (hook) => postWriteHooks.collect(hook),
    });
    await beforePersistentApply(runtime);
    const committedConfig = await writeWizardConfigFile(nextConfig, {
      allowConfigSizeDrop: false,
      baseHash,
      migrationBaseConfig: baseConfig,
    });
    await runCollectedChannelOnboardingPostWriteHooks({
      hooks: postWriteHooks.drain(),
      cfg: committedConfig,
      runtime,
      beforePersistentEffect: async () => await beforePersistentApply(runtime),
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

function formatPendingOperationForAssistant(operation: CrestodianOperation): string {
  const description = describeCrestodianPersistentOperation(operation);
  return operation.kind === "setup"
    ? `${description}. Exact setup JSON: ${JSON.stringify(operation)}. Keep the verified model unless the user explicitly asks to leave Crestodian and reconfigure inference.`
    : description;
}

function preservePendingSetupModel(
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
  };
}

export class CrestodianChatEngine {
  private pending: CrestodianOperation | null = null;
  private wizardBridge: ActiveWizardBridge | null = null;
  private lastSensitiveChannel: string | undefined;
  private awaitingSetupChannel = false;
  private hostProposalResolution: "approved" | "declined" | undefined;
  private readonly history: CrestodianAssistantTurn[] = [];
  private readonly agentSession: CrestodianAgentSession;
  private readonly verifiedInference: CrestodianVerifiedInferenceBinding;
  /** Turns run strictly one at a time; interleaved handles corrupt wizard/pending state. */
  private turnQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: CrestodianChatEngineOptions) {
    const binding = opts?.verifiedInference;
    if (!binding) {
      throw new CrestodianInferenceUnavailableError("conversation");
    }
    this.verifiedInference = binding;
    this.agentSession = createCrestodianAgentSession(binding);
  }

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
    await this.requireVerifiedInference();
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
    // token and must never reach a model. The host handles its redacted
    // proposal + approval directly, matching the wizard's masked-input rules.
    const typed = parseCrestodianOperation(text);
    if (typed.kind === "config-set" && isSensitiveConfigPath(typed.path)) {
      return await this.runOperation(typed, undefined);
    }
    if (typed.kind === "open-tui") {
      // Exact host navigation must not depend on whether a conversation model
      // chooses to call the handoff tool. Clear any stale proposal first.
      this.clearPendingProposals();
      return await this.runOperation(typed, undefined);
    }
    if (
      typed.kind === "open-setup" ||
      typed.kind === "channel-setup" ||
      typed.kind === "model-setup"
    ) {
      // Exact host-navigation commands do not depend on model interpretation.
      // Inference/provider setup still exits this session before onboarding.
      return await this.runOperation(typed, undefined);
    }

    // Approval is judged from the user's own words, host-side. The classifier
    // only runs while a proposal is pending, and "other" (questions, new
    // requests) keeps the proposal pending and lets the AI carry on.
    const intent = await this.classifyApprovalIntent(text);
    if (this.pending) {
      if (intent === "approve") {
        // Approval classification may invoke inference. Its result authorizes
        // only the route that was verified before classification started.
        await this.requireVerifiedInference();
        return await this.applyPendingProposal();
      }
      if (intent === "decline") {
        const skippedModelSetup = this.pending.kind === "model-setup";
        this.clearPendingProposals();
        this.hostProposalResolution = "declined";
        return {
          text: skippedModelSetup
            ? "Skipped. The current inference route is unchanged."
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
      verifiedInference: this.verifiedInference,
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
    if (!isPersistentCrestodianOperation(pending)) {
      return await this.runOperation(pending, undefined);
    }
    return await this.applyApprovedPersistentOperation(pending);
  }

  private async applyApprovedPersistentOperation(
    operation: CrestodianOperation,
  ): Promise<CrestodianChatReply> {
    if (!isPersistentCrestodianOperation(operation)) {
      throw new Error(`Crestodian host received a non-persistent approved operation.`);
    }
    const capture = createCaptureRuntime();
    let result: CrestodianOperationResult | undefined;
    try {
      result = await executeCrestodianOperation(operation, capture, {
        approved: true,
        deps: this.commandDeps(),
        // The model turn, approval classifier, and operation preflight all
        // await. Freeze authority at the actual persistent-apply boundary.
        beforePersistentApply: async () => {
          await this.requirePersistentApplyInference(capture);
        },
      });
    } catch (error) {
      if (isCrestodianInferenceUnavailableError(error)) {
        throw error;
      }
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
   * tool. The single-turn planner is a second inference path; if neither path
   * answers, the turn fails closed instead of executing model-free guesses.
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
    let agentFailure: unknown;
    let loopReply: Awaited<ReturnType<CrestodianAgentTurnRunner>>;
    try {
      loopReply = await agentTurn({
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
      });
    } catch (error) {
      agentFailure = error;
      loopReply = null;
    }
    if (loopReply?.text) {
      // The native loop saw this marker. Keep it queued across planner fallback
      // so a recovered persistent session cannot resurrect resolved host work.
      this.hostProposalResolution = undefined;
      // A plain answer does not discard the host-seeded approval transaction.
      // Clear it only once the loop registers a replacement or takes a handoff.
      if (loopReply.directive) {
        this.clearPendingProposals();
      } else if (this.agentSession.proposalRef.current !== undefined) {
        this.pending = null;
      }
      // Directive/wizard failures are host failures, not inference failures;
      // never replay them through a second model path.
      return await this.applyAgentTurnReply(loopReply);
    }

    const planner =
      this.opts.planWithAssistant ?? (await import("./assistant.js")).planCrestodianCommand;
    let plannerFailure: unknown;
    let plan: Awaited<ReturnType<CrestodianAssistantPlanner>>;
    try {
      plan = await planner({
        input: text,
        overview,
        history: this.history,
        ...(this.pending
          ? { pendingOperation: formatPendingOperationForAssistant(this.pending) }
          : {}),
        verifiedInference: this.verifiedInference,
      });
      if (plan) {
        // Custom planners are test/plugin seams and do not inherit the default
        // planner's post-cleanup guard. Check before exposing any plan text.
        await this.requireVerifiedInference();
      }
    } catch (error) {
      plannerFailure = error;
      plan = null;
    }
    if (!plan) {
      throw new CrestodianInferenceUnavailableError(
        "conversation",
        [agentFailure, plannerFailure].filter((failure) => failure !== undefined),
      );
    }

    const replyText = plan.reply ?? "";
    if (!plan.command) {
      if (!replyText.trim()) {
        throw new CrestodianInferenceUnavailableError("planner", [agentFailure]);
      }
      return { text: replyText, action: "none" };
    }
    const operation = preservePendingSetupModel(
      this.pending,
      parseCrestodianOperation(plan.command),
    );
    if (operation.kind === "none") {
      if (!replyText.trim()) {
        throw new CrestodianInferenceUnavailableError("planner", [agentFailure]);
      }
      // A conversational reply is still valid even when its optional command
      // falls outside the closed operation vocabulary.
      return { text: replyText, action: "none" };
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
    // Recheck after the model turn: the route may have changed while inference
    // was running, and its stale directive must never cross that boundary.
    await this.requireVerifiedInference();
    if (loopReply.directive?.kind === "approved-operation") {
      const applied = await this.applyApprovedPersistentOperation(loopReply.directive.operation);
      return {
        ...applied,
        text: [loopReply.text, applied.text].filter(Boolean).join("\n\n"),
      };
    }
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
      // The Gateway keeps this engine after an open-agent handoff. Retire the
      // abandoned proposal so a later "yes" cannot arm pre-handoff work.
      this.clearPendingProposals();
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

  private async runOperation(
    operation: CrestodianOperation,
    provenance: string | undefined,
  ): Promise<CrestodianChatReply> {
    // Planning and approval classification are asynchronous. Bind every
    // operation to the same inference owner checked at turn start.
    await this.requireVerifiedInference();
    if (operation.kind === "open-tui") {
      this.clearPendingProposals();
      return {
        text: "Opening your normal agent TUI. Use /crestodian there to come back.",
        action: "open-tui",
        handoff: operation,
      };
    }

    if (operation.kind === "open-setup") {
      // Host-owned setup replaces the current conversation branch. Void both
      // proposal stores before any prompt or handoff so a later "yes" cannot
      // approve work from the abandoned branch.
      this.clearPendingProposals();
      if (this.opts.surface === "gateway") {
        return {
          text: "The app owns the setup screens here — use Settings, or run `openclaw onboard` in a terminal.",
          action: "none",
        };
      }
      if (operation.target !== "channels") {
        return {
          text: "Setup can replace the inference route powering this session. Exit Crestodian and run `openclaw onboard`; it saves only a route that passes a live test. Then start Crestodian again.",
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
        handoff.target === "channels" ? `${handoff.channel ?? "channel"} setup` : "setup";
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
        beforePersistentApply: async () => {
          await this.requirePersistentApplyInference(capture);
        },
      });
    } catch (error) {
      if (isCrestodianInferenceUnavailableError(error)) {
        throw error;
      }
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
    const verifiedRoute = await this.requireVerifiedInference();
    const overview = this.opts.deps?.loadOverview
      ? await this.opts.deps.loadOverview()
      : await loadCrestodianOverview();
    return { ...overview, defaultModel: verifiedRoute.modelLabel };
  }

  private async requireVerifiedInference() {
    const binding = this.opts?.verifiedInference;
    if (
      !binding ||
      binding !== this.verifiedInference ||
      this.agentSession.verifiedInference !== this.verifiedInference
    ) {
      return this.throwInferenceUnavailable();
    }
    try {
      const route = await resolveCrestodianVerifiedInferenceRoute(binding, this.opts.deps);
      if (route) {
        return route;
      }
    } catch (error) {
      return this.throwInferenceUnavailable([error]);
    }
    return this.throwInferenceUnavailable();
  }

  private async requirePersistentApplyInference(runtime: RuntimeEnv) {
    const binding = this.opts?.verifiedInference;
    if (
      !binding ||
      binding !== this.verifiedInference ||
      this.agentSession.verifiedInference !== this.verifiedInference
    ) {
      return this.throwInferenceUnavailable();
    }
    try {
      const { resolveCrestodianInferenceForPersistentApply } = await import("./setup-inference.js");
      const route = await resolveCrestodianInferenceForPersistentApply({
        binding,
        runtime,
        deps: this.opts.deps,
      });
      if (route) {
        return route;
      }
    } catch (error) {
      if (isCrestodianInferenceUnavailableError(error)) {
        return this.throwInferenceUnavailable(error.failures, false);
      }
      return this.throwInferenceUnavailable([error], false);
    }
    return this.throwInferenceUnavailable([], false);
  }

  private throwInferenceUnavailable(failures: readonly unknown[] = [], cancelWizard = true): never {
    // Inference loss retires every authority-bearing branch. The engine itself
    // may still be referenced by a host, so leave no proposal, wizard, or CLI
    // continuation that a later call could revive.
    this.pending = null;
    this.hostProposalResolution = undefined;
    this.agentSession.proposalRef.current = undefined;
    delete this.agentSession.cliSession;
    if (cancelWizard) {
      this.wizardBridge?.session.cancel();
    }
    this.wizardBridge = null;
    this.lastSensitiveChannel = undefined;
    this.awaitingSetupChannel = false;
    this.history.splice(0);
    throw new CrestodianInferenceUnavailableError("conversation", failures);
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
      if (!snapshot.exists) {
        return this.configVerificationUnavailable("openclaw.json was not found");
      }
      if (snapshot.valid) {
        return null;
      }
      const issues = (snapshot.issues ?? []).map(
        (issue: { path?: string; message: string }) =>
          `${issue.path ? `${issue.path}: ` : ""}${issue.message}`,
      );
      issuesText = issues.length > 0 ? issues.join("\n") : "unknown validation failure";
    } catch {
      return this.configVerificationUnavailable("openclaw.json could not be read");
    }
    const notice = `⚠ openclaw.json failed validation after that write:\n${issuesText}`;
    let recovery: CrestodianChatReply;
    try {
      recovery = await this.resolveAssistantTurn(
        `[config-verify] The config file is now invalid:\n${issuesText}\nPropose one corrective command from the allowed list.`,
        false,
      );
    } catch (error) {
      if (!isCrestodianInferenceUnavailableError(error)) {
        throw error;
      }
      return `${notice}\nThe write was applied, but inference could not propose a repair. Run \`openclaw doctor --fix\`, then try again.`;
    }
    if (!recovery.text) {
      return `${notice}\nExit Crestodian and run \`openclaw doctor --fix\`, or use \`config schema <path>\` to check the expected shape before leaving.`;
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

  private configVerificationUnavailable(reason: string): string {
    return [
      `⚠ The write was applied, but post-write verification is unavailable: ${reason}.`,
      "Run `openclaw doctor --fix`, then verify the configuration before continuing.",
    ].join("\n");
  }

  private armFollowUp(operation: CrestodianOperation | undefined): string | null {
    if (operation?.kind !== "model-setup") {
      return null;
    }
    return [
      "No usable inference route is configured, so Crestodian cannot continue.",
      "Exit and run `openclaw onboard`; it saves only a route that passes a live test.",
    ].join("\n");
  }

  private async startChannelSetupWizard(channel: string): Promise<string> {
    this.clearPendingProposals();
    this.lastSensitiveChannel = undefined;
    const beforePersistentApply = async (runtime: RuntimeEnv) => {
      await this.requirePersistentApplyInference(runtime);
    };
    const runWizard =
      this.opts.runChannelSetupWizard ??
      ((ch: string, prompter: WizardPrompterLike, guard: (runtime: RuntimeEnv) => Promise<void>) =>
        defaultChannelSetupWizardRunner(ch, guard)(prompter));
    const session = new WizardSession((prompter) =>
      runWizard(channel, prompter, beforePersistentApply),
    );
    this.wizardBridge = {
      session,
      step: null,
      label: channel,
      autoSelectChannel: channel,
    };
    return await this.pumpWizardBridge();
  }

  private async startModelSetup(_workspace: string | undefined): Promise<CrestodianChatReply> {
    this.clearPendingProposals();
    return {
      text: [
        "Changing provider credentials would replace the inference route powering this session.",
        "Exit Crestodian and run `openclaw onboard`; it stages credentials, live-tests the new route, and saves only a passing setup. Then start Crestodian again.",
      ].join("\n"),
      action: "none",
    };
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
        return "Channel setup cancelled. Nothing was changed beyond completed steps.";
      }
      return `Channel setup stopped: ${result.error ?? "unknown error"}`;
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
