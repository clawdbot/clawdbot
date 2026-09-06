import type {
  SystemAgentChatQuestion,
  SystemAgentWizardCancel,
  WizardAnswer,
} from "../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  sanitizeWizardStepForClient,
  WizardSession,
  wizardStepAwaitsInput,
  type WizardStep,
} from "../wizard/session.js";
import type { MemoryImportProviderOutcome } from "../wizard/setup.memory-import.js";
import type { SystemAgentOperation } from "./operations.js";
import { classifySystemAgentApprovalText } from "./operator-approval.js";

type WizardPrompter = import("../wizard/prompts.js").WizardPrompter;
type HostedRuntime = typeof import("./hosted-setup.runtime.js");
type HostedSetupCompletion = import("./hosted-setup.runtime.js").HostedSetupCompletion;
type HostedMemoryImportOutcome = import("./hosted-setup.runtime.js").HostedMemoryImportOutcome;
type HostedWizardRunResult = void | HostedSetupCompletion | HostedMemoryImportOutcome;

type SystemAgentChatReplyAction = "none" | "exit" | "open-tui" | "open-setup";

export type SystemAgentChatReply = {
  text: string;
  action: SystemAgentChatReplyAction;
  applied?: boolean;
  agentDraft?: "hatch";
  sensitive?: boolean;
  wizardInputPending?: boolean;
  handoff?: SystemAgentOperation;
  question?: SystemAgentChatQuestion;
  step?: WizardStep;
};

export type ChatWizardResult = {
  text: string;
  configWritten: boolean;
  sensitiveChannel?: string;
};

export type ChatWizardAnswerResult = ChatWizardResult & {
  userHistoryText: string;
};

export type ChatWizardHostDependencies = {
  runChannelSetupWizard?: (
    channel: string,
    prompter: WizardPrompter,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  ) => Promise<void | HostedSetupCompletion>;
  runSkillsSetupWizard?: (
    prompter: WizardPrompter,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  ) => Promise<void | HostedSetupCompletion>;
  runSearchSetupWizard?: (
    prompter: WizardPrompter,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  ) => Promise<void | HostedSetupCompletion>;
  runGatewaySetupWizard?: (
    prompter: WizardPrompter,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  ) => Promise<void | HostedSetupCompletion>;
  runMemoryImportWizard?: (
    prompter: WizardPrompter,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
    onProviderOutcome: (outcome: MemoryImportProviderOutcome) => void,
  ) => Promise<HostedMemoryImportOutcome>;
  appendAuditEntry?: typeof import("./audit.js").appendSystemAgentAuditEntry;
};

type ActiveWizardBridge = {
  session: WizardSession;
  step: WizardStep | null;
  kind: "channel" | "skills" | "search" | "gateway" | "memory-import";
  label: string;
  completion: {
    status: HostedSetupCompletion;
    memoryImport?: HostedMemoryImportOutcome;
    memoryImportProviders?: MemoryImportProviderOutcome[];
  };
  autoSelectChannel?: string;
};

const log = createSubsystemLogger("system-agent/chat-wizard-host");
const WIZARD_CANCEL_HINT = "Say `cancel` to stop this setup.";
let hostedRuntimePromise: Promise<HostedRuntime> | undefined;

function loadHostedRuntime(): Promise<HostedRuntime> {
  return (hostedRuntimePromise ??= import("./hosted-setup.runtime.js"));
}

function formatWizardOptions(step: WizardStep): string[] {
  return (step.options ?? []).map((option, index) => {
    const hint = option.hint ? ` — ${option.hint}` : "";
    return `${index + 1}. ${option.label}${hint}`;
  });
}

function wizardStepChatQuestion(step: WizardStep | null): SystemAgentChatQuestion | undefined {
  if (!step) {
    return undefined;
  }
  if (step.type === "confirm") {
    const yesRecommended = step.initialValue !== false;
    return {
      id: step.id,
      header: step.title ?? "Confirm",
      question: step.message ?? "Continue?",
      options: [
        { label: "Yes", reply: "yes", ...(yesRecommended ? { recommended: true } : {}) },
        { label: "No", reply: "no", ...(!yesRecommended ? { recommended: true } : {}) },
      ],
    };
  }
  if (step.type !== "select") {
    return undefined;
  }
  const options = step.options ?? [];
  if (options.length < 2 || options.length > 4) {
    return undefined;
  }
  return {
    id: step.id,
    header: step.title ?? "Choose one",
    question: step.message ?? "Choose one.",
    options: options.map((option) => {
      const mapped: SystemAgentChatQuestion["options"][number] = { label: option.label };
      if (option.hint) {
        mapped.description = option.hint;
      }
      if (step.initialValue !== undefined && option.value === step.initialValue) {
        mapped.recommended = true;
      }
      return mapped;
    }),
  };
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
  return lines.filter(Boolean).join("\n");
}

function parseWizardAnswer(step: WizardStep, text: string): { value: unknown } | null {
  const trimmed = text.trim();
  if (step.type === "confirm") {
    const intent = classifySystemAgentApprovalText(trimmed);
    return intent === "approve" ? { value: true } : intent === "decline" ? { value: false } : null;
  }
  if (step.type === "text") {
    return { value: trimmed };
  }
  const options = step.options ?? [];
  const matchOption = (token: string) => {
    if (/^\d+$/.test(token)) {
      const index = Number(token);
      if (Number.isSafeInteger(index) && index >= 1 && index <= options.length) {
        return options[index - 1];
      }
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
    const values: unknown[] = [];
    for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
      const option = matchOption(token);
      if (!option) {
        return null;
      }
      values.push(option.value);
    }
    return { value: values };
  }
  return { value: step.type === "action" ? true : undefined };
}

function formatStructuredWizardAnswerForHistory(step: WizardStep, value: unknown): string {
  if (step.sensitive === true) {
    return "<redacted secret>";
  }
  if (step.type === "text") {
    return ["string", "number", "boolean", "bigint"].includes(typeof value)
      ? String(value)
      : "<wizard answer>";
  }
  if (step.type === "confirm") {
    return typeof value === "boolean" ? (value ? "Yes" : "No") : "<wizard answer>";
  }
  if (step.type === "select") {
    return (
      step.options?.find((option) => Object.is(option.value, value))?.label ?? "<wizard answer>"
    );
  }
  if (step.type === "multiselect") {
    if (!Array.isArray(value)) {
      return "<wizard answer>";
    }
    if (value.length === 0) {
      return "None";
    }
    const labels = value.map(
      (entry) => step.options?.find((option) => Object.is(option.value, entry))?.label,
    );
    return labels.every((label): label is string => label !== undefined)
      ? labels.join(", ")
      : "<wizard answer>";
  }
  return "Continue";
}

export class SystemAgentWizardAnswerError extends Error {}

export class ChatWizardHost {
  private bridge: ActiveWizardBridge | null = null;

  constructor(
    private readonly options: {
      surface?: "cli" | "gateway";
      beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>;
      dependencies?: ChatWizardHostDependencies;
    },
  ) {}

  get active(): boolean {
    return this.bridge !== null;
  }

  get sensitiveInputPending(): boolean {
    return this.bridge?.step?.sensitive === true;
  }

  dispose(): void {
    this.bridge?.session.cancel();
    this.bridge = null;
  }

  decorateReply(reply: SystemAgentChatReply): SystemAgentChatReply {
    const step = this.bridge?.step ?? null;
    const completedReply =
      reply.text && step && wizardStepAwaitsInput(step)
        ? { ...reply, text: `${reply.text}\n${WIZARD_CANCEL_HINT}` }
        : reply;
    const question = wizardStepChatQuestion(step);
    const clientStep = step ? sanitizeWizardStepForClient(step) : null;
    return {
      ...completedReply,
      ...(step?.sensitive === true ? { sensitive: true } : {}),
      ...(this.bridge ? { wizardInputPending: true } : {}),
      ...(question ? { question } : {}),
      ...(clientStep ? { step: clientStep } : {}),
    };
  }

  async answer(answer: WizardAnswer): Promise<ChatWizardAnswerResult> {
    const bridge = this.bridge;
    const step = bridge?.step;
    if (!bridge || !step) {
      throw new SystemAgentWizardAnswerError("No hosted wizard is awaiting an answer.");
    }
    if (answer.stepId !== step.id) {
      throw new SystemAgentWizardAnswerError("The hosted wizard answer targets a stale step.");
    }
    const validationError = await bridge.session.answer(step.id, answer.value);
    const result = validationError
      ? { text: [validationError, renderWizardStep(step)].join("\n\n"), configWritten: false }
      : await this.pump();
    return {
      ...result,
      userHistoryText: formatStructuredWizardAnswerForHistory(step, answer.value),
    };
  }

  async cancel(cancel: SystemAgentWizardCancel): Promise<ChatWizardAnswerResult> {
    const bridge = this.bridge;
    const step = bridge?.step;
    if (!bridge || !step) {
      throw new SystemAgentWizardAnswerError("No hosted wizard is awaiting cancellation.");
    }
    if (cancel.stepId !== step.id) {
      throw new SystemAgentWizardAnswerError("The hosted wizard cancel targets a stale step.");
    }
    if (!bridge.session.cancel()) {
      throw new SystemAgentWizardAnswerError("The hosted wizard cannot be cancelled right now.");
    }
    return { ...(await this.pump()), userHistoryText: "Cancel" };
  }

  async resolveReply(text: string): Promise<ChatWizardResult> {
    const bridge = this.bridge;
    if (!bridge) {
      return { text: "", configWritten: false };
    }
    if (/^(cancel|abort|stop|quit|exit)$/i.test(text.trim())) {
      bridge.session.cancel();
      return await this.pump();
    }
    const step = bridge.step;
    if (!step) {
      return await this.pump();
    }
    const answer = parseWizardAnswer(step, text);
    if (!answer) {
      return {
        text: ["I could not match that answer.", renderWizardStep(step)].join("\n"),
        configWritten: false,
      };
    }
    const validationError = await bridge.session.answer(step.id, answer.value);
    return validationError
      ? { text: [validationError, renderWizardStep(step)].join("\n\n"), configWritten: false }
      : await this.pump();
  }

  async startChannel(channel: string): Promise<ChatWizardResult> {
    const run = this.options.dependencies?.runChannelSetupWizard;
    return await this.start({
      kind: "channel",
      label: channel,
      autoSelectChannel: channel,
      run: async (prompter) =>
        run
          ? await run(channel, prompter, this.options.beforePersistentApply)
          : await (
              await loadHostedRuntime()
            ).runHostedChannelSetup(channel, prompter, this.options.beforePersistentApply),
    });
  }

  async startSkills(): Promise<ChatWizardResult> {
    const run = this.options.dependencies?.runSkillsSetupWizard;
    return await this.start({
      kind: "skills",
      label: "skills",
      run: async (prompter) =>
        run
          ? await run(prompter, this.options.beforePersistentApply)
          : await (
              await loadHostedRuntime()
            ).runHostedSkillsSetup(prompter, this.options.beforePersistentApply),
    });
  }

  async startSearch(): Promise<ChatWizardResult> {
    const run = this.options.dependencies?.runSearchSetupWizard;
    return await this.start({
      kind: "search",
      label: "web search",
      run: async (prompter) =>
        run
          ? await run(prompter, this.options.beforePersistentApply)
          : await (
              await loadHostedRuntime()
            ).runHostedSearchSetup(prompter, this.options.beforePersistentApply),
    });
  }

  async startGateway(): Promise<ChatWizardResult> {
    const run = this.options.dependencies?.runGatewaySetupWizard;
    const result = await this.start({
      kind: "gateway",
      label: "gateway",
      run: async (prompter) =>
        run
          ? await run(prompter, this.options.beforePersistentApply)
          : await (
              await loadHostedRuntime()
            ).runHostedGatewaySetup(prompter, this.options.beforePersistentApply),
    });
    if (this.options.surface !== "gateway" || !this.bridge) {
      return result;
    }
    const warning = [
      "Before we start: changing the Gateway port, bind address, or auth credential requires a Gateway restart to apply.",
      "That restart may disconnect this chat, and you may need to sign in to the Control UI again with the new address or credential.",
    ].join(" ");
    return { ...result, text: [warning, result.text].filter(Boolean).join("\n\n") };
  }

  async startMemoryImport(): Promise<ChatWizardResult> {
    const run = this.options.dependencies?.runMemoryImportWizard;
    const providers: MemoryImportProviderOutcome[] = [];
    return await this.start({
      kind: "memory-import",
      label: "memory import",
      memoryImportProviders: providers,
      run: async (prompter) =>
        run
          ? await run(prompter, this.options.beforePersistentApply, (value) =>
              providers.push(value),
            )
          : await (
              await loadHostedRuntime()
            ).runHostedMemoryImport(prompter, this.options.beforePersistentApply, (value) =>
              providers.push(value),
            ),
    });
  }

  private async start(params: {
    kind: ActiveWizardBridge["kind"];
    label: string;
    autoSelectChannel?: string;
    memoryImportProviders?: MemoryImportProviderOutcome[];
    run: (prompter: WizardPrompter) => Promise<HostedWizardRunResult>;
  }): Promise<ChatWizardResult> {
    const completion: ActiveWizardBridge["completion"] = {
      status: "applied",
      ...(params.memoryImportProviders
        ? { memoryImportProviders: params.memoryImportProviders }
        : {}),
    };
    const session = new WizardSession(async (prompter) => {
      const result = await params.run(prompter);
      if (typeof result === "string") {
        completion.status = result;
      } else if (result) {
        completion.memoryImport = result;
      }
    });
    this.bridge = {
      session,
      step: null,
      kind: params.kind,
      label: params.label,
      completion,
      ...(params.autoSelectChannel ? { autoSelectChannel: params.autoSelectChannel } : {}),
    };
    return await this.pump();
  }

  private tryAutoSelect(step: WizardStep): { value: unknown } | null {
    const bridge = this.bridge;
    const channel = bridge?.autoSelectChannel;
    if (!bridge || !channel || (step.type !== "select" && step.type !== "multiselect")) {
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

  private async pump(): Promise<ChatWizardResult> {
    const bridge = this.bridge;
    if (!bridge) {
      return { text: "", configWritten: false };
    }
    const result = await bridge.session.next();
    if (result.done) {
      this.bridge = null;
      const label = bridge.label;
      if (result.status === "done") {
        if (bridge.kind === "memory-import") {
          try {
            return {
              text: await (
                await loadHostedRuntime()
              ).renderMemoryImport(
                bridge.completion.memoryImport,
                this.options.dependencies?.appendAuditEntry,
              ),
              configWritten: false,
            };
          } catch (error) {
            log.warn(`memory import completed without audit entry: ${formatErrorMessage(error)}`);
            return {
              text: await (
                await loadHostedRuntime()
              ).renderMemoryImport(bridge.completion.memoryImport, async () => ""),
              configWritten: false,
            };
          }
        }
        if (bridge.completion.status === "kept-current") {
          return {
            text: `${label[0]?.toUpperCase() ?? "S"}${label.slice(1)} setup kept the current configuration. Nothing was changed.`,
            configWritten: false,
          };
        }
        await this.auditSetup(bridge);
        const success =
          bridge.kind === "channel"
            ? [
                `Done — ${label} is configured.`,
                "Say `restart gateway` to apply channel changes, or `channels` to review.",
              ]
            : bridge.kind === "skills"
              ? ["Done — skills dependency setup is complete."]
              : bridge.kind === "search"
                ? [
                    "Done — web search setup is complete.",
                    "Restart the Gateway if the selected provider or plugin changed.",
                  ]
                : [
                    "Done — gateway settings saved.",
                    "Restart the Gateway to apply them (`restart gateway`).",
                  ];
        return { text: success.join("\n"), configWritten: true };
      }
      if (bridge.kind === "memory-import") {
        try {
          await (
            await loadHostedRuntime()
          ).auditMemoryImport(
            bridge.completion.memoryImportProviders ?? [],
            this.options.dependencies?.appendAuditEntry,
          );
        } catch (error) {
          log.warn(`memory import completed without audit entry: ${formatErrorMessage(error)}`);
        }
      }
      if (result.status === "cancelled") {
        return {
          text: `${label[0]?.toUpperCase() ?? "S"}${label.slice(1)} setup cancelled. Nothing was changed beyond completed steps.`,
          configWritten: false,
        };
      }
      return {
        text: `${label[0]?.toUpperCase() ?? "S"}${label.slice(1)} setup stopped: ${result.error ?? "unknown error"}`,
        configWritten: false,
      };
    }
    bridge.step = result.step ?? null;
    if (bridge.step) {
      const auto = this.tryAutoSelect(bridge.step);
      if (auto) {
        const step = bridge.step;
        bridge.step = null;
        await bridge.session.answer(step.id, auto.value);
        return await this.pump();
      }
      if (this.options.surface === "cli" && bridge.step.sensitive === true) {
        bridge.session.cancel();
        this.bridge = null;
        const target =
          bridge.kind === "channel"
            ? `Say \`open channel wizard\` and I'll hand you to the masked terminal wizard for ${bridge.label}, or run \`openclaw channels add --channel ${bridge.label}\` yourself later.`
            : bridge.kind === "gateway"
              ? "Say `open gateway wizard` and I'll hand you to the masked terminal wizard, or run `openclaw configure --section gateway` yourself later."
              : "Say `open search wizard` and I'll hand you to the masked terminal wizard, or run `openclaw configure --section web` yourself later.";
        return {
          text: [
            "Sensitive input is not accepted in the OpenClaw chat because terminal input is visible.",
            target,
          ].join("\n"),
          configWritten: false,
          ...(bridge.kind === "channel" ? { sensitiveChannel: bridge.label } : {}),
        };
      }
      if (bridge.step.type === "note" || bridge.step.type === "progress") {
        const step = bridge.step;
        bridge.step = null;
        await bridge.session.answer(step.id, undefined);
        const next = await this.pump();
        return { ...next, text: [renderWizardStep(step), next.text].filter(Boolean).join("\n\n") };
      }
      if (bridge.step.type === "action" && bridge.step.executor !== "client") {
        const step = bridge.step;
        bridge.step = null;
        await bridge.session.answer(step.id, true);
        return await this.pump();
      }
    }
    return { text: bridge.step ? renderWizardStep(bridge.step) : "", configWritten: false };
  }

  private async auditSetup(bridge: ActiveWizardBridge): Promise<void> {
    const entry =
      bridge.kind === "channel"
        ? {
            operation: "channels.setup",
            summary: `Configured channel ${bridge.label} via chat setup`,
            details: { channel: bridge.label },
          }
        : bridge.kind === "skills"
          ? {
              operation: "skills.setup",
              summary: "Completed skills dependency setup via chat",
              details: { capability: "skills" },
            }
          : bridge.kind === "search"
            ? {
                operation: "search.setup",
                summary: "Configured web search via chat setup",
                details: { capability: "web-search" },
              }
            : {
                operation: "gateway.setup",
                summary: "Configured Gateway via chat setup",
                details: { capability: "gateway" },
              };
    try {
      const append =
        this.options.dependencies?.appendAuditEntry ??
        (await import("./audit.js")).appendSystemAgentAuditEntry;
      await append(entry);
    } catch (error) {
      log.warn(`${bridge.kind} setup completed without audit entry: ${formatErrorMessage(error)}`);
    }
  }
}
