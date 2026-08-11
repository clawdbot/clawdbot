import { isSensitiveConfigPath } from "../config/sensitive-paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
import type {
  SystemAgentSession,
  SystemAgentTurnDirective,
  SystemAgentTurnRunner,
} from "./agent-turn.js";
import { runSystemAgentTurn } from "./agent-turn.js";
import type { SystemAgentApprovalClassifier } from "./approval-intent.js";
import type { SystemAgentAssistantPlanner, SystemAgentAssistantTurn } from "./assistant.js";
import type {
  ChatWizardAnswerResult,
  ChatWizardHost,
  ChatWizardResult,
  SystemAgentChatReply,
} from "./chat-wizard-host.js";
import { approvalQuestion } from "./dialogue.js";
import {
  SystemAgentInferenceUnavailableError,
  isSystemAgentInferenceUnavailableError,
} from "./inference-error.js";
import {
  describeSystemAgentPersistentOperation,
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation,
  type SystemAgentCommandDeps,
  type SystemAgentOperation,
  type SystemAgentOperationResult,
} from "./operations.js";
import {
  resolveOperatorApprovalDecision,
  resolvePendingOperatorProposal,
  type SystemAgentApprovalIntent,
} from "./operator-approval.js";
import type { SystemAgentOverview } from "./overview.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

const log = createSubsystemLogger("system-agent/chat-engine");

export type SystemAgentChatTurnOptions = {
  uiContext?: { page: string };
};

type ChatTurnRouterOptions = {
  yes?: boolean;
  deps?: SystemAgentCommandDeps;
  planWithAssistant?: SystemAgentAssistantPlanner;
  runAgentTurn?: SystemAgentTurnRunner;
  classifyApproval?: SystemAgentApprovalClassifier;
  surface?: "cli" | "gateway";
  operatorApprovalOnly?: boolean;
};

type CaptureRuntime = RuntimeEnv & { read: () => string };

function createCaptureRuntime(): CaptureRuntime {
  const lines: string[] = [];
  return {
    log: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
    exit: (code) => {
      throw new Error(`OpenClaw operation exited with code ${String(code)}`);
    },
    read: () => lines.join("\n").trim(),
  };
}

function formatOperationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `That did not go through: ${message}`;
}

export function redactSensitiveCommandText(text: string): string {
  const operation = parseSystemAgentOperation(text);
  if (operation.kind === "config-set" && isSensitiveConfigPath(operation.path)) {
    return `config set ${operation.path} <redacted secret>`;
  }
  return text;
}

function formatPendingOperationForAssistant(operation: SystemAgentOperation): string {
  const description = describeSystemAgentPersistentOperation(operation);
  return operation.kind === "setup"
    ? `${description}. Exact setup JSON: ${JSON.stringify(operation)}. Keep the verified model unless the user explicitly asks to leave OpenClaw and reconfigure inference.`
    : description;
}

function preservePendingSetupModel(
  pending: SystemAgentOperation | null,
  operation: SystemAgentOperation,
): SystemAgentOperation {
  if (pending?.kind !== "setup" || operation.kind !== "setup") {
    return operation;
  }
  const pendingModel = pending.model?.trim();
  const requestedModel = operation.model?.trim();
  if (requestedModel && requestedModel !== pendingModel) {
    return operation;
  }
  return { ...operation, ...(requestedModel ? {} : pendingModel ? { model: pendingModel } : {}) };
}

export class ChatTurnRouter {
  private pending: SystemAgentOperation | null = null;
  private awaitingSetupChannel = false;
  private lastSensitiveChannel: string | undefined;
  private proposalResolution: "approved" | "declined" | undefined;

  constructor(
    private readonly options: ChatTurnRouterOptions,
    private readonly dependencies: {
      executeOperation?: typeof executeSystemAgentOperation;
    },
    private readonly agentSession: SystemAgentSession,
    private readonly wizard: ChatWizardHost,
    private readonly callbacks: {
      requireVerifiedInference: () => Promise<unknown>;
      requirePersistentApplyInference: (runtime: RuntimeEnv) => Promise<unknown>;
      rebindVerifiedInference: (binding: SystemAgentVerifiedInferenceBinding) => void;
      getVerifiedInference: () => SystemAgentVerifiedInferenceBinding;
      loadOverview: () => Promise<SystemAgentOverview>;
      getHistory: () => SystemAgentAssistantTurn[];
      verifyConfigAfterWrite: () => Promise<string | null>;
    },
  ) {}

  propose(operation: SystemAgentOperation): string {
    this.clearPendingProposals();
    this.pending = operation;
    return describeSystemAgentPersistentOperation(operation);
  }

  hasPendingProposal(): boolean {
    return this.pending !== null;
  }

  getPendingOperatorProposal(): { operation: SystemAgentOperation; hash: string } | null {
    return resolvePendingOperatorProposal(this.pending, this.agentSession.proposalRef);
  }

  async resolveOperatorApproval(
    decision: "allow-once" | "allow-always" | "deny" | null,
    proposalHash: string,
  ): Promise<SystemAgentChatReply | null> {
    return await resolveOperatorApprovalDecision({
      decision,
      proposalHash,
      getProposal: () => this.getPendingOperatorProposal(),
      clear: () => this.clearPendingProposals(),
      apply: async (operation) => {
        this.proposalResolution = "approved";
        return await this.applyApprovedPersistentOperation(operation);
      },
      denied: () => ({ text: "Denied. No change.", action: "none" as const }),
    });
  }

  clearForInferenceLoss(): void {
    this.pending = null;
    this.proposalResolution = undefined;
    this.agentSession.proposalRef.current = undefined;
    this.agentSession.proposalRef.operation = undefined;
    this.awaitingSetupChannel = false;
    this.lastSensitiveChannel = undefined;
  }

  async answerWizard(result: Promise<ChatWizardAnswerResult>): Promise<ChatWizardAnswerResult> {
    const answer = await result;
    return { ...answer, text: await this.finishWizardText(answer) };
  }

  async resolveTurn(
    text: string,
    options?: SystemAgentChatTurnOptions,
  ): Promise<SystemAgentChatReply> {
    if (this.wizard.active) {
      const result = await this.wizard.resolveReply(text);
      return { text: await this.finishWizardText(result), action: "none" };
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return {
        text: "Tiny claw tap: tell me what you want — setup, repair, channels, anything config.",
        action: "none",
      };
    }
    if (/^(quit|exit)$/i.test(trimmed)) {
      return { text: "OpenClaw retracts into shell. Bye.", action: "exit" };
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
    if (this.options.operatorApprovalOnly && this.getPendingOperatorProposal()) {
      return { text: "Approval pending. Human must decide in OpenClaw UI.", action: "none" };
    }
    const typed = parseSystemAgentOperation(text);
    if (typed.kind === "config-set" && isSensitiveConfigPath(typed.path)) {
      return await this.runOperation(typed, undefined);
    }
    const typedRefusal = this.refuseDelegatedNavigationDirective(typed.kind);
    if (typedRefusal) {
      return { text: typedRefusal, action: "none" };
    }
    if (typed.kind === "open-tui") {
      this.clearPendingProposals();
      return await this.runOperation(typed, undefined);
    }
    if (
      typed.kind === "open-setup" ||
      typed.kind === "channel-setup" ||
      typed.kind === "skills-setup" ||
      typed.kind === "search-setup" ||
      typed.kind === "gateway-config-setup" ||
      typed.kind === "memory-import" ||
      typed.kind === "model-setup"
    ) {
      return await this.runOperation(typed, undefined);
    }

    const intent = this.options.operatorApprovalOnly
      ? "other"
      : await this.classifyApprovalIntent(text);
    if (this.pending) {
      if (intent === "approve") {
        await this.callbacks.requireVerifiedInference();
        return await this.applyPendingProposal(this.pending);
      }
      if (intent === "decline") {
        const skippedModelSetup = this.pending.kind === "model-setup";
        this.clearPendingProposals();
        this.proposalResolution = "declined";
        return {
          text: skippedModelSetup
            ? "Skipped. The current inference route is unchanged."
            : "Skipped. No barnacles on config today.",
          action: "none",
        };
      }
    }
    if (intent === "decline") {
      this.agentSession.proposalRef.current = undefined;
      this.agentSession.proposalRef.operation = undefined;
    }
    return await this.resolveAssistantTurn(
      text,
      this.options.operatorApprovalOnly ? false : intent === "approve",
      options?.uiContext,
    );
  }

  private async classifyApprovalIntent(text: string): Promise<SystemAgentApprovalIntent> {
    const hasProposal =
      this.pending !== null || this.agentSession.proposalRef.current !== undefined;
    if (!hasProposal) {
      return "other";
    }
    const classify =
      this.options.classifyApproval ??
      (await import("./approval-intent.js")).classifySystemAgentApprovalIntent;
    return await classify({
      message: text,
      ...(this.pending ? { proposal: describeSystemAgentPersistentOperation(this.pending) } : {}),
      verifiedInference: this.callbacks.getVerifiedInference(),
    });
  }

  private async applyPendingProposal(pending: SystemAgentOperation): Promise<SystemAgentChatReply> {
    this.clearPendingProposals();
    this.proposalResolution = "approved";
    if (pending.kind === "channel-setup") {
      return await this.startWizard(this.wizard.startChannel(pending.channel));
    }
    if (pending.kind === "model-setup") {
      return this.startModelSetup();
    }
    if (!isPersistentSystemAgentOperation(pending)) {
      return await this.runOperation(pending, undefined);
    }
    return await this.applyApprovedPersistentOperation(pending);
  }

  private async applyApprovedPersistentOperation(
    operation: SystemAgentOperation,
  ): Promise<SystemAgentChatReply> {
    if (!isPersistentSystemAgentOperation(operation)) {
      throw new Error("OpenClaw host received a non-persistent approved operation.");
    }
    const capture = createCaptureRuntime();
    const result = await this.executeOperation(operation, capture, true);
    const verify = result?.applied ? await this.callbacks.verifyConfigAfterWrite() : null;
    const followUp = this.armFollowUp(result?.followUp);
    const baseText = [capture.read() || "Applied. Audit entry written.", verify, followUp]
      .filter(Boolean)
      .join("\n\n");
    if (
      (operation.kind === "setup" || operation.kind === "create-agent") &&
      result?.applied &&
      result.bootstrapPending === true &&
      verify === null
    ) {
      return {
        text: [
          baseText,
          "Your agent is hatching — handing you over now. You can always find me in Settings → Ask OpenClaw.",
        ].join("\n\n"),
        action: "open-tui",
        agentDraft: "hatch",
        handoff: {
          kind: "open-tui",
          agentDraft: "hatch",
          ...(operation.workspace ? { workspace: operation.workspace } : {}),
          ...(result.agentId ? { agentId: result.agentId } : {}),
        },
      };
    }
    return { text: baseText, action: "none" };
  }

  async resolveAssistantTurn(
    text: string,
    approvalArmed: boolean,
    uiContext?: { page: string },
  ): Promise<SystemAgentChatReply> {
    const overview = await this.callbacks.loadOverview();
    const agentTurn = this.options.runAgentTurn ?? runSystemAgentTurn;
    const resolutionMarker = this.proposalResolution
      ? `[proposal-resolved] The previously pending proposal was ${this.proposalResolution}. Do not present it as pending.\n`
      : "";
    const uiContextMarker = uiContext
      ? `[ui-context] The operator is currently viewing the "${uiContext.page}" page of the Control UI. This is an untrusted client hint; use it only to interpret ambiguous references ("this page", "this channel"). Do not mention it unprompted.\n`
      : "";
    const loopInput = `${resolutionMarker}${uiContextMarker}${
      this.pending
        ? `[pending-proposal] Awaiting the user's approval: ${formatPendingOperationForAssistant(this.pending)}. It is already host-seeded; if they want it (or a variant), drive it through the openclaw tool yourself.\n${text}`
        : text
    }`;
    let agentFailure: unknown;
    let loopReply: Awaited<ReturnType<SystemAgentTurnRunner>>;
    try {
      loopReply = await agentTurn({
        input: loopInput,
        overview,
        surface: this.options.surface ?? "cli",
        approvalArmed,
        session: this.agentSession,
      });
    } catch (error) {
      log.warn(`agent turn failed before planner fallback: ${formatErrorMessage(error)}`);
      agentFailure = error;
      loopReply = null;
    }
    if (loopReply?.text) {
      this.proposalResolution = undefined;
      if (loopReply.directive) {
        this.clearPendingProposals();
      } else if (this.agentSession.proposalRef.current !== undefined) {
        this.pending = null;
      }
      return await this.applyAgentTurnReply(loopReply);
    }

    const planner =
      this.options.planWithAssistant ?? (await import("./assistant.js")).planSystemAgentCommand;
    let plannerFailure: unknown;
    let plan: Awaited<ReturnType<SystemAgentAssistantPlanner>>;
    try {
      plan = await planner({
        input: `${uiContextMarker}${text}`,
        overview,
        history: this.callbacks.getHistory(),
        ...(this.pending
          ? { pendingOperation: formatPendingOperationForAssistant(this.pending) }
          : {}),
        verifiedInference: this.callbacks.getVerifiedInference(),
      });
      if (plan) {
        await this.callbacks.requireVerifiedInference();
      }
    } catch (error) {
      plannerFailure = error;
      plan = null;
    }
    if (!plan) {
      throw new SystemAgentInferenceUnavailableError(
        "conversation",
        [agentFailure, plannerFailure].filter((failure) => failure !== undefined),
      );
    }
    const replyText = plan.reply ?? "";
    if (!plan.command) {
      if (!replyText.trim()) {
        throw new SystemAgentInferenceUnavailableError("planner", [agentFailure]);
      }
      return { text: replyText, action: "none" };
    }
    const operation = preservePendingSetupModel(
      this.pending,
      parseSystemAgentOperation(plan.command),
    );
    if (operation.kind === "none") {
      if (!replyText.trim()) {
        throw new SystemAgentInferenceUnavailableError("planner", [agentFailure]);
      }
      return { text: replyText, action: "none" };
    }
    const provenance = `(${plan.modelLabel ?? "model"} → \`${plan.command}\`)`;
    const executed = await this.runOperation(operation, provenance);
    return { ...executed, text: [replyText, executed.text].filter(Boolean).join("\n\n") };
  }

  private async applyAgentTurnReply(loopReply: {
    text: string;
    directive?: SystemAgentTurnDirective;
  }): Promise<SystemAgentChatReply> {
    await this.callbacks.requireVerifiedInference();
    const directive = loopReply.directive;
    const refusal = this.refuseDelegatedNavigationDirective(directive?.kind);
    if (refusal) {
      return { text: [loopReply.text, refusal].filter(Boolean).join("\n\n"), action: "none" };
    }
    if (directive?.kind === "approved-operation") {
      const applied = await this.applyApprovedPersistentOperation(directive.operation);
      return { ...applied, text: [loopReply.text, applied.text].filter(Boolean).join("\n\n") };
    }
    if (directive?.kind === "channel-setup") {
      return await this.prependWizard(loopReply.text, this.wizard.startChannel(directive.channel));
    }
    if (directive?.kind === "skills-setup") {
      return await this.prependWizard(loopReply.text, this.wizard.startSkills());
    }
    if (directive?.kind === "search-setup") {
      return await this.prependWizard(loopReply.text, this.wizard.startSearch());
    }
    if (directive?.kind === "gateway-config-setup") {
      return await this.prependWizard(loopReply.text, this.wizard.startGateway());
    }
    if (directive?.kind === "memory-import") {
      return await this.prependWizard(loopReply.text, this.wizard.startMemoryImport());
    }
    if (directive?.kind === "model-setup") {
      const setup = this.startModelSetup();
      return { ...setup, text: [loopReply.text, setup.text].filter(Boolean).join("\n\n") };
    }
    if (directive?.kind === "open-tui") {
      this.clearPendingProposals();
      return { text: loopReply.text, action: "open-tui", handoff: directive };
    }
    if (directive?.kind === "open-setup") {
      const handoff = await this.runOperation(directive, undefined);
      return { ...handoff, text: [loopReply.text, handoff.text].filter(Boolean).join("\n\n") };
    }
    return { text: loopReply.text, action: "none" };
  }

  private refuseDelegatedNavigationDirective(kind: string | undefined): string | undefined {
    if (!this.options.operatorApprovalOnly) {
      return undefined;
    }
    if (
      kind === "channel-setup" ||
      kind === "skills-setup" ||
      kind === "search-setup" ||
      kind === "gateway-config-setup" ||
      kind === "memory-import" ||
      kind === "model-setup" ||
      kind === "open-setup" ||
      kind === "open-tui"
    ) {
      return "Channel, model, and setup flows need a human operator in the OpenClaw app; they cannot run from a delegated agent request.";
    }
    return undefined;
  }

  private async runOperation(
    operation: SystemAgentOperation,
    provenance: string | undefined,
  ): Promise<SystemAgentChatReply> {
    await this.callbacks.requireVerifiedInference();
    if (operation.kind === "open-tui") {
      this.clearPendingProposals();
      return {
        text: "Opening your normal agent TUI. Use /openclaw there to come back.",
        action: "open-tui",
        handoff: operation,
      };
    }
    if (operation.kind === "open-setup") {
      this.clearPendingProposals();
      if (this.options.surface === "gateway") {
        return {
          text: "Open Settings to change your model or connect a channel. To change providers from a shell, run `openclaw onboard` on the machine running OpenClaw.",
          action: "none",
        };
      }
      if (!["channels", "search", "gateway"].includes(operation.target)) {
        return {
          text: "Setup can replace the inference route powering this session. Exit OpenClaw and run `openclaw onboard`; it saves only a route that passes a live test. Then start OpenClaw again.",
          action: "none",
        };
      }
      let handoff = operation;
      if (handoff.target === "channels" && !handoff.channel) {
        if (!this.lastSensitiveChannel) {
          this.awaitingSetupChannel = true;
          return {
            text: "Which channel should I open in the masked terminal wizard?",
            action: "none",
          };
        }
        handoff = { ...handoff, channel: this.lastSensitiveChannel };
        this.lastSensitiveChannel = undefined;
      }
      this.awaitingSetupChannel = false;
      const label =
        handoff.target === "channels"
          ? `${handoff.channel ?? "channel"} setup`
          : handoff.target === "search"
            ? "web search setup"
            : "Gateway setup";
      return { text: `Opening the ${label} wizard.`, action: "open-setup", handoff };
    }
    if (operation.kind === "channel-setup") {
      return await this.startWizard(this.wizard.startChannel(operation.channel));
    }
    if (operation.kind === "skills-setup") {
      return await this.startWizard(this.wizard.startSkills());
    }
    if (operation.kind === "search-setup") {
      return await this.startWizard(this.wizard.startSearch());
    }
    if (operation.kind === "gateway-config-setup") {
      return await this.startWizard(this.wizard.startGateway());
    }
    if (operation.kind === "memory-import") {
      return await this.startWizard(this.wizard.startMemoryImport());
    }
    if (operation.kind === "model-setup") {
      return this.startModelSetup();
    }

    const capture = createCaptureRuntime();
    if (isPersistentSystemAgentOperation(operation) && !this.options.yes) {
      this.clearPendingProposals();
      this.pending = operation;
      await executeSystemAgentOperation(operation, capture, {
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
    const result = await this.executeOperation(
      operation,
      capture,
      this.options.yes === true || !isPersistentSystemAgentOperation(operation),
    );
    const verify = result?.applied ? await this.callbacks.verifyConfigAfterWrite() : null;
    const followUp = this.armFollowUp(result?.followUp);
    const reply = [provenance, capture.read(), verify, followUp].filter(Boolean).join("\n\n");
    if (result?.exitsInteractive === true) {
      return { text: reply, action: "exit" };
    }
    return { text: reply, action: "none" };
  }

  private async executeOperation(
    operation: SystemAgentOperation,
    capture: CaptureRuntime,
    approved: boolean,
  ): Promise<SystemAgentOperationResult | undefined> {
    try {
      const execute = this.dependencies.executeOperation ?? executeSystemAgentOperation;
      return await execute(operation, capture, {
        approved,
        deps: this.commandDeps(),
        beforePersistentApply: async () => {
          await this.callbacks.requirePersistentApplyInference(capture);
        },
        onVerifiedInferenceChanged: this.callbacks.rebindVerifiedInference,
      });
    } catch (error) {
      if (isSystemAgentInferenceUnavailableError(error)) {
        throw error;
      }
      capture.error(formatOperationError(error));
      return undefined;
    }
  }

  private async startWizard(result: Promise<ChatWizardResult>): Promise<SystemAgentChatReply> {
    // A masked channel handoff belongs only to the immediately preceding wizard.
    this.lastSensitiveChannel = undefined;
    this.clearPendingProposals();
    const resolved = await result;
    if (resolved.sensitiveChannel) {
      this.lastSensitiveChannel = resolved.sensitiveChannel;
    }
    return { text: await this.finishWizardText(resolved), action: "none" };
  }

  private async prependWizard(
    prefix: string,
    result: Promise<ChatWizardResult>,
  ): Promise<SystemAgentChatReply> {
    const reply = await this.startWizard(result);
    return { ...reply, text: [prefix, reply.text].filter(Boolean).join("\n\n") };
  }

  private async finishWizardText(result: ChatWizardResult): Promise<string> {
    const verify = result.configWritten ? await this.callbacks.verifyConfigAfterWrite() : null;
    return [result.text, verify].filter(Boolean).join("\n");
  }

  private startModelSetup(): SystemAgentChatReply {
    this.clearPendingProposals();
    return {
      text: [
        "Changing provider credentials would replace the inference route powering this session.",
        "Stop the OpenClaw host through whatever started it. Run `openclaw onboard` on the machine running OpenClaw: it stages credentials, live-tests the new route, and saves only a passing setup. Then restart the host and return to OpenClaw.",
      ].join("\n"),
      action: "none",
    };
  }

  private commandDeps(): SystemAgentCommandDeps | undefined {
    if (!this.options.deps && !this.options.surface) {
      return undefined;
    }
    return {
      ...this.options.deps,
      ...(this.options.surface ? { setupSurface: this.options.surface } : {}),
    };
  }

  private clearPendingProposals(): void {
    this.pending = null;
    this.agentSession.proposalRef.current = undefined;
    this.agentSession.proposalRef.operation = undefined;
  }

  private armFollowUp(operation: SystemAgentOperation | undefined): string | null {
    return operation?.kind === "model-setup"
      ? [
          "No usable inference route is configured, so OpenClaw cannot continue.",
          "Run `openclaw onboard` on the machine running OpenClaw; it saves only a route that passes a live test.",
        ].join("\n")
      : null;
  }
}
