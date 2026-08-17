// OpenClaw chat engine: stable transport-agnostic facade over turn and wizard owners.
import type {
  SystemAgentWizardCancel,
  WizardAnswer,
} from "../../packages/gateway-protocol/src/index.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  cleanupSystemAgentSession,
  createSystemAgentSession,
  type SystemAgentSession,
  type SystemAgentTurnRunner,
} from "./agent-turn.js";
import type { SystemAgentApprovalClassifier } from "./approval-intent.js";
import type { SystemAgentAssistantPlanner, SystemAgentAssistantTurn } from "./assistant.js";
import {
  ChatTurnRouter,
  redactSensitiveCommandText,
  type SystemAgentChatTurnOptions,
} from "./chat-turn-router.js";
import {
  ChatWizardHost,
  type ChatWizardHostDependencies,
  type SystemAgentChatReply,
} from "./chat-wizard-host.js";
import type {
  SystemAgentGreetingFacts,
  SystemAgentGreetingPlan,
  SystemAgentGreetingPlanner,
} from "./greeting.js";
import {
  SystemAgentInferenceUnavailableError,
  isSystemAgentInferenceUnavailableError,
} from "./inference-error.js";
import type { SystemAgentCommandDeps, SystemAgentOperation } from "./operations.js";
import { loadSystemAgentOverview, type SystemAgentOverview } from "./overview.js";
import { verifyConfigAfterSystemAgentWrite } from "./post-write-verification.js";
import {
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
} from "./verified-inference.js";

export { SystemAgentWizardAnswerError } from "./chat-wizard-host.js";

export type SystemAgentChatEngineOptions = {
  yes?: boolean;
  deps?: SystemAgentCommandDeps;
  planWithAssistant?: SystemAgentAssistantPlanner;
  planGreeting?: SystemAgentGreetingPlanner;
  runAgentTurn?: SystemAgentTurnRunner;
  classifyApproval?: SystemAgentApprovalClassifier;
  surface?: "cli" | "gateway";
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
  operatorApprovalOnly?: boolean;
  /** Host-recorded origin for delegated create-agent proposals. */
  requesterAgentId?: string;
};

type SystemAgentChatEngineInternals = {
  wizardDependencies?: ChatWizardHostDependencies;
  executeOperation?: typeof import("./operations.js").executeSystemAgentOperation;
};

/**
 * One conversation with OpenClaw, independent of transport. The facade owns
 * serialization, history, and the verified inference session; concept owners
 * route turns and host setup wizards behind the stable public entrypoint.
 */
export class SystemAgentChatEngine {
  private readonly history: SystemAgentAssistantTurn[] = [];
  private readonly agentSession: SystemAgentSession;
  private readonly wizard: ChatWizardHost;
  private readonly router: ChatTurnRouter;
  private verifiedInference: SystemAgentVerifiedInferenceBinding;
  private turnQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: SystemAgentChatEngineOptions,
    internals: SystemAgentChatEngineInternals = {},
  ) {
    const binding = options?.verifiedInference;
    if (!binding) {
      throw new SystemAgentInferenceUnavailableError("conversation");
    }
    this.verifiedInference = binding;
    this.agentSession = createSystemAgentSession(binding);
    this.wizard = new ChatWizardHost({
      surface: options.surface,
      beforePersistentApply: async (runtime) => {
        await this.requirePersistentApplyInference(runtime);
      },
      dependencies: internals.wizardDependencies,
    });
    this.router = new ChatTurnRouter(
      options,
      { executeOperation: internals.executeOperation },
      this.agentSession,
      this.wizard,
      {
        requireVerifiedInference: async () => await this.requireVerifiedInference(),
        requirePersistentApplyInference: async (runtime) =>
          await this.requirePersistentApplyInference(runtime),
        rebindVerifiedInference: (next) => this.rebindVerifiedInference(next),
        getVerifiedInference: () => this.verifiedInference,
        loadOverview: async () => await this.loadOverview(),
        getHistory: () => this.history,
        verifyConfigAfterWrite: async () => await this.verifyConfigAfterWrite(),
      },
    );
  }

  propose(operation: SystemAgentOperation): string {
    return this.router.propose(operation);
  }

  hasPendingProposal(): boolean {
    return this.router.hasPendingProposal();
  }

  getPendingOperatorProposal(): { operation: SystemAgentOperation; hash: string } | null {
    return this.router.getPendingOperatorProposal();
  }

  async resolveOperatorApproval(
    decision: "allow-once" | "allow-always" | "deny" | null,
    proposalHash: string,
  ): Promise<SystemAgentChatReply | null> {
    const turn = this.turnQueue.then(async () => {
      const reply = await this.router.resolveOperatorApproval(decision, proposalHash);
      if (reply?.text) {
        this.history.push({ role: "assistant", text: reply.text });
      }
      return reply;
    });
    this.turnQueue = turn.catch(() => undefined);
    return await turn;
  }

  noteAssistantMessage(text: string): void {
    this.history.push({ role: "assistant", text });
  }

  seedHistory(turns: readonly SystemAgentAssistantTurn[]): void {
    this.history.push(
      ...turns.map((turn) => ({
        ...turn,
        text: turn.role === "user" ? redactSensitiveCommandText(turn.text) : turn.text,
      })),
    );
  }

  historyLength(): number {
    return this.history.length;
  }

  historySince(index: number): SystemAgentAssistantTurn[] {
    return this.history.slice(index).map((turn) => ({ role: turn.role, text: turn.text }));
  }

  async dispose(): Promise<void> {
    this.wizard.dispose();
    await cleanupSystemAgentSession(this.agentSession);
  }

  async handle(text: string, options?: SystemAgentChatTurnOptions): Promise<SystemAgentChatReply> {
    const turn = this.turnQueue.then(async () => {
      await this.requireVerifiedInference();
      const sensitiveTurn = this.wizard.sensitiveInputPending;
      const reply = await this.router.resolveTurn(text, options);
      return this.completeTurn(
        reply,
        sensitiveTurn ? "<redacted secret>" : redactSensitiveCommandText(text),
      );
    });
    this.turnQueue = turn.catch(() => undefined);
    return await turn;
  }

  async answerWizard(answer: WizardAnswer): Promise<SystemAgentChatReply> {
    const turn = this.turnQueue.then(async () => {
      await this.requireVerifiedInference();
      const result = await this.router.answerWizard(this.wizard.answer(answer));
      return this.completeTurn({ text: result.text, action: "none" }, result.userHistoryText);
    });
    this.turnQueue = turn.catch(() => undefined);
    return await turn;
  }

  async cancelWizard(cancel: SystemAgentWizardCancel): Promise<SystemAgentChatReply> {
    const turn = this.turnQueue.then(async () => {
      const result = await this.router.answerWizard(this.wizard.cancel(cancel));
      return this.completeTurn({ text: result.text, action: "none" }, result.userHistoryText);
    });
    this.turnQueue = turn.catch(() => undefined);
    return await turn;
  }

  private completeTurn(reply: SystemAgentChatReply, userHistoryText: string): SystemAgentChatReply {
    const completed = this.wizard.decorateReply(reply);
    this.history.push({ role: "user", text: userHistoryText });
    if (completed.text) {
      this.history.push({ role: "assistant", text: completed.text });
    }
    return completed;
  }

  async loadOverview(): Promise<SystemAgentOverview> {
    const route = await this.requireVerifiedInference();
    const overview = this.options.deps?.loadOverview
      ? await this.options.deps.loadOverview()
      : await loadSystemAgentOverview();
    return { ...overview, defaultModel: route.modelLabel };
  }

  async planGreeting(params: {
    overview: SystemAgentOverview;
    facts: SystemAgentGreetingFacts;
    timeoutMs: number;
  }): Promise<SystemAgentGreetingPlan | null> {
    const planner = this.options.planGreeting;
    const plan = planner
      ? await planner(params)
      : await import("./assistant.js").then(({ planSystemAgentGreetingWithConfiguredModel }) =>
          planSystemAgentGreetingWithConfiguredModel({
            ...params,
            verifiedInference: this.verifiedInference,
            deps: this.options.deps,
          }),
        );
    if (plan) {
      await this.requireVerifiedInference();
    }
    return plan;
  }

  private async requireVerifiedInference() {
    const binding = this.verifiedInference;
    if (this.agentSession.verifiedInference !== binding) {
      return this.throwInferenceUnavailable();
    }
    try {
      const route = await resolveSystemAgentVerifiedInferenceRoute(binding, this.options.deps);
      if (route) {
        return route;
      }
    } catch (error) {
      return this.throwInferenceUnavailable([error]);
    }
    return this.throwInferenceUnavailable();
  }

  private async requirePersistentApplyInference(runtime: RuntimeEnv) {
    const binding = this.verifiedInference;
    if (this.agentSession.verifiedInference !== binding) {
      return this.throwInferenceUnavailable();
    }
    try {
      const { resolvePersistentApplyInference } = await import("./setup-inference.js");
      const route = await resolvePersistentApplyInference({
        binding,
        runtime,
        deps: this.options.deps,
      });
      if (route) {
        return route;
      }
    } catch (error) {
      if (isSystemAgentInferenceUnavailableError(error)) {
        return this.throwInferenceUnavailable(error.failures, false);
      }
      return this.throwInferenceUnavailable([error], false);
    }
    return this.throwInferenceUnavailable([], false);
  }

  private rebindVerifiedInference(binding: SystemAgentVerifiedInferenceBinding): void {
    if (binding.execution.agentId !== this.verifiedInference.execution.agentId) {
      return;
    }
    delete this.agentSession.cliSession;
    this.verifiedInference = binding;
    this.agentSession.verifiedInference = binding;
  }

  private throwInferenceUnavailable(failures: readonly unknown[] = [], cancelWizard = true): never {
    this.router.clearForInferenceLoss();
    delete this.agentSession.cliSession;
    if (cancelWizard) {
      this.wizard.dispose();
    }
    this.history.splice(0);
    throw new SystemAgentInferenceUnavailableError("conversation", failures);
  }

  private async verifyConfigAfterWrite(): Promise<string | null> {
    return await verifyConfigAfterSystemAgentWrite((message) =>
      this.router.resolveAssistantTurn(message, false),
    );
  }
}
