import type { RuntimeEnv } from "../runtime.js";
import type {
  SystemAgentSession,
  SystemAgentTurnDirective,
  SystemAgentTurnRunner,
} from "./agent-turn.js";
import { runSystemAgentTurn } from "./agent-turn.js";
import type { SystemAgentApprovalClassifier } from "./approval-intent.js";
import type {
  ChatWizardAnswerResult,
  ChatWizardHost,
  ChatWizardResult,
  SystemAgentChatReply,
} from "./chat-wizard-host.js";
import {
  isSystemAgentSensitiveConfigValue,
  redactSystemAgentConfigPath,
} from "./config-redaction.js";
import { approvalQuestion } from "./dialogue.js";
import {
  SystemAgentInferenceUnavailableError,
  isSystemAgentInferenceUnavailableError,
} from "./inference-error.js";
import { isSystemAgentNavigationOperation } from "./operation-types.js";
import { isInvalidConfigSetOperation } from "./operations-internal.js";
import {
  describeSystemAgentPersistentOperation,
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation,
  SYSTEM_AGENT_OPERATOR_NAVIGATION_HANDOFF,
  type SystemAgentCommandDeps,
  type SystemAgentOperation,
  type SystemAgentOperationResult,
} from "./operations.js";
import {
  hashSystemAgentOperation,
  resolveOperatorApprovalDecision,
  resolvePendingOperatorProposal,
  type SystemAgentApprovalIntent,
} from "./operator-approval.js";
import type { SystemAgentOverview } from "./overview.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

export type SystemAgentChatTurnOptions = {
  uiContext?: { page: string };
};

type ChatTurnRouterOptions = {
  yes?: boolean;
  deps?: SystemAgentCommandDeps;
  runAgentTurn?: SystemAgentTurnRunner;
  classifyApproval?: SystemAgentApprovalClassifier;
  surface?: "cli" | "gateway";
  operatorApprovalOnly?: boolean;
  requesterAgentId?: string;
};

type CaptureRuntime = RuntimeEnv & { read: () => string };
type PersistentApplyGuard = () => void;

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
  if (isInvalidConfigSetOperation(operation)) {
    return "config set <invalid path> <redacted secret>";
  }
  if (operation.kind === "config-set") {
    const displayPath = redactSystemAgentConfigPath(operation.path);
    if (
      displayPath !== operation.path ||
      isSystemAgentSensitiveConfigValue(operation.path, operation.value)
    ) {
      return `config set ${displayPath} <redacted secret>`;
    }
  }
  if (operation.kind === "config-set-ref") {
    const displayPath = redactSystemAgentConfigPath(operation.path);
    return `config set-ref ${displayPath} <redacted reference>`;
  }
  return text;
}

function formatPendingOperationForAssistant(operation: SystemAgentOperation): string {
  const description = describeSystemAgentPersistentOperation(operation);
  return operation.kind === "setup"
    ? `${description}. Exact setup JSON: ${JSON.stringify(operation)}. Keep the verified model unless the user explicitly asks to leave OpenClaw and reconfigure inference.`
    : description;
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
      verifyConfigAfterWrite: () => Promise<string | null>;
    },
  ) {}

  propose(operation: SystemAgentOperation): string {
    this.clearPendingProposals();
    this.pending = this.recordCreateAgentRequester(operation);
    return describeSystemAgentPersistentOperation(this.pending);
  }

  getPendingOperatorProposal(): { operation: SystemAgentOperation; hash: string } | null {
    const proposal = resolvePendingOperatorProposal(this.pending, this.agentSession.proposalRef);
    if (!proposal) {
      return null;
    }
    const operation = this.recordCreateAgentRequester(proposal.operation);
    // Request provenance participates in approval identity, but reading the
    // operator projection must not transfer ownership of a host-seeded plan.
    return operation === proposal.operation
      ? proposal
      : { operation, hash: hashSystemAgentOperation(operation) };
  }

  async resolveOperatorApproval(
    decision: "allow-once" | "allow-always" | "deny" | null,
    proposalHash: string,
    beforePersistentApply?: PersistentApplyGuard,
  ): Promise<SystemAgentChatReply | null> {
    return await resolveOperatorApprovalDecision({
      decision,
      proposalHash,
      getProposal: () => this.getPendingOperatorProposal(),
      clear: () => this.clearPendingProposals(),
      apply: async (operation) => {
        this.proposalResolution = "approved";
        return await this.applyApprovedPersistentOperation(operation, beforePersistentApply);
      },
      denied: () => {
        this.proposalResolution = "declined";
        return { text: "Denied. No change.", action: "none" as const, applied: false };
      },
    });
  }

  clearForInferenceLoss(): void {
    this.clearPendingProposals();
    this.proposalResolution = undefined;
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
      return await this.runOperation({
        kind: "open-setup",
        target: "channels",
        channel: trimmed.toLowerCase(),
      });
    }
    if (this.options.operatorApprovalOnly && this.getPendingOperatorProposal()) {
      return { text: "Approval pending. Human must decide in OpenClaw UI.", action: "none" };
    }
    const typed = parseSystemAgentOperation(text);
    if (isInvalidConfigSetOperation(typed)) {
      return { text: typed.message, action: "none" };
    }
    if (
      typed.kind === "config-set" ||
      typed.kind === "config-set-ref" ||
      typed.kind === "config-get" ||
      typed.kind === "config-schema"
    ) {
      return await this.runOperation(typed);
    }
    if (isSystemAgentNavigationOperation(typed)) {
      return await this.runOperation(typed);
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
        this.clearPendingProposals();
        this.proposalResolution = "declined";
        return {
          text: "Skipped. No barnacles on config today.",
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
    return await this.applyApprovedPersistentOperation(pending);
  }

  private async applyApprovedPersistentOperation(
    operation: SystemAgentOperation,
    beforePersistentApply?: PersistentApplyGuard,
  ): Promise<SystemAgentChatReply> {
    if (!isPersistentSystemAgentOperation(operation)) {
      throw new Error("OpenClaw host received a non-persistent approved operation.");
    }
    const capture = createCaptureRuntime();
    const result = await this.executeOperation(operation, capture, true, beforePersistentApply);
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
          `Your agent is hatching — handing you over now. ${this.agentHandoffReturnHint()}`,
        ].join("\n\n"),
        action: "open-tui",
        applied: true,
        agentDraft: "hatch",
        handoff: {
          kind: "open-tui",
          agentDraft: "hatch",
          ...(operation.workspace ? { workspace: operation.workspace } : {}),
          ...(result.agentId ? { agentId: result.agentId } : {}),
        },
      };
    }
    return { text: baseText, action: "none", applied: result?.applied === true };
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
    // The runtime already owns recovery; a terminal failure must not start another inference turn.
    const loopReply = await agentTurn({
      input: loopInput,
      overview,
      surface: this.options.surface ?? "cli",
      approvalArmed,
      ...(this.options.operatorApprovalOnly ? { operatorApprovalOnly: true } : {}),
      session: this.agentSession,
    });
    if (!loopReply?.text) {
      throw new SystemAgentInferenceUnavailableError("agent-turn");
    }
    this.proposalResolution = undefined;
    if (loopReply.directive) {
      this.clearPendingProposals();
    } else if (this.agentSession.proposalRef.current !== undefined) {
      this.pending = null;
    }
    return await this.applyAgentTurnReply(loopReply);
  }

  private async applyAgentTurnReply(loopReply: {
    text: string;
    directive?: SystemAgentTurnDirective;
  }): Promise<SystemAgentChatReply> {
    await this.callbacks.requireVerifiedInference();
    const directive = loopReply.directive;
    if (!directive) {
      return { text: loopReply.text, action: "none" };
    }
    const reply =
      directive.kind === "approved-operation"
        ? await this.applyApprovedPersistentOperation(directive.operation)
        : await this.runOperation(directive);
    return {
      ...reply,
      text:
        directive.kind === "open-tui" && reply.action === "open-tui"
          ? loopReply.text
          : [loopReply.text, reply.text].filter(Boolean).join("\n\n"),
    };
  }

  private async runOperation(operation: SystemAgentOperation): Promise<SystemAgentChatReply> {
    const recordedOperation = this.recordCreateAgentRequester(operation);
    await this.callbacks.requireVerifiedInference();
    // All inputs (typed commands and tool directives) enter
    // here before any wizard or handoff starts.
    if (this.options.operatorApprovalOnly && isSystemAgentNavigationOperation(recordedOperation)) {
      return {
        text: SYSTEM_AGENT_OPERATOR_NAVIGATION_HANDOFF,
        action: "none",
      };
    }
    if (recordedOperation.kind === "open-tui") {
      this.clearPendingProposals();
      return {
        text: `Opening a chat with your agent. ${this.agentHandoffReturnHint()}`,
        action: "open-tui",
        handoff: recordedOperation,
      };
    }
    if (recordedOperation.kind === "model-accounts") {
      this.clearPendingProposals();
      return {
        text:
          this.options.surface === "gateway"
            ? "Opening Settings → Profile → Connected accounts. Check the Gateway, person, and Personal scope, then sign in or select a saved account. Nothing has changed yet; never paste credentials into this conversation."
            : "Run `openclaw models accounts list` to see your personal accounts, or `openclaw models accounts login <provider>` for protected sign-in. Check the Gateway and person shown before signing in. You can also use Settings → Profile → Connected accounts in the Control UI. Nothing has changed; never paste credentials into this conversation.",
        action: "none",
        ...(this.options.surface === "gateway" ? { handoff: recordedOperation } : {}),
      };
    }
    if (recordedOperation.kind === "open-setup") {
      this.clearPendingProposals();
      if (this.options.surface === "gateway") {
        return {
          text: "Open Settings to change your model or connect a channel. To change providers from a shell, run `openclaw onboard` on the machine running OpenClaw.",
          action: "none",
        };
      }
      if (!["channels", "search", "gateway"].includes(recordedOperation.target)) {
        return {
          text: "Setup can replace the inference route powering this session. Exit OpenClaw and run `openclaw onboard`; it saves only a route that passes a live test. Then start OpenClaw again.",
          action: "none",
        };
      }
      let handoff = recordedOperation;
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
    if (recordedOperation.kind === "channel-setup") {
      return await this.startWizard(this.wizard.startChannel(recordedOperation.channel));
    }
    if (recordedOperation.kind === "skills-setup") {
      return await this.startWizard(this.wizard.startSkills());
    }
    if (recordedOperation.kind === "search-setup") {
      return await this.startWizard(this.wizard.startSearch());
    }
    if (recordedOperation.kind === "gateway-config-setup") {
      return await this.startWizard(this.wizard.startGateway());
    }
    if (recordedOperation.kind === "memory-import") {
      return await this.startWizard(this.wizard.startMemoryImport());
    }
    if (recordedOperation.kind === "model-setup") {
      return this.startModelSetup();
    }

    const capture = createCaptureRuntime();
    if (isPersistentSystemAgentOperation(recordedOperation) && !this.options.yes) {
      this.clearPendingProposals();
      // Validate through the executor before staging; delegated handoff copy must
      // not turn a forbidden operation into an approvable proposal.
      await executeSystemAgentOperation(recordedOperation, capture, {
        approved: false,
        operatorApprovalOnly: this.options.operatorApprovalOnly,
        deps: this.commandDeps(),
      });
      this.pending = recordedOperation;
      return {
        text: [
          capture.read(),
          this.options.operatorApprovalOnly ? undefined : approvalQuestion(recordedOperation),
        ]
          .filter(Boolean)
          .join("\n\n"),
        action: "none",
      };
    }
    const result = await this.executeOperation(
      recordedOperation,
      capture,
      this.options.yes === true || !isPersistentSystemAgentOperation(recordedOperation),
    );
    const verify = result?.applied ? await this.callbacks.verifyConfigAfterWrite() : null;
    const followUp = this.armFollowUp(result?.followUp);
    const reply = [capture.read(), verify, followUp].filter(Boolean).join("\n\n");
    if (result?.exitsInteractive === true) {
      return { text: reply, action: "exit" };
    }
    return { text: reply, action: "none" };
  }

  private async executeOperation(
    operation: SystemAgentOperation,
    capture: CaptureRuntime,
    approved: boolean,
    beforePersistentApply?: PersistentApplyGuard,
  ): Promise<SystemAgentOperationResult | undefined> {
    try {
      const execute = this.dependencies.executeOperation ?? executeSystemAgentOperation;
      if (approved) {
        await this.callbacks.requirePersistentApplyInference(capture);
      }
      return await execute(operation, capture, {
        approved,
        deps: this.commandDeps(),
        beforePersistentApply,
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

  private commandDeps(): SystemAgentCommandDeps {
    return {
      ...this.options.deps,
      loadOverview: this.callbacks.loadOverview,
      ...(this.options.surface ? { setupSurface: this.options.surface } : {}),
    };
  }

  private agentHandoffReturnHint(): string {
    // Only the TUI uses /openclaw for navigation; web chat runs rescue in place.
    return this.options.surface === "gateway"
      ? "You can return through Settings → Ask OpenClaw."
      : "Use /openclaw to come back.";
  }

  private clearPendingProposals(): void {
    this.pending = null;
    this.agentSession.proposalRef.current = undefined;
    this.agentSession.proposalRef.operation = undefined;
  }

  private recordCreateAgentRequester(operation: SystemAgentOperation): SystemAgentOperation {
    const requesterAgentId = this.options.requesterAgentId?.trim();
    if (
      operation.kind !== "create-agent" ||
      !requesterAgentId ||
      operation.requesterAgentId === requesterAgentId
    ) {
      return operation;
    }
    return { ...operation, requesterAgentId };
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
