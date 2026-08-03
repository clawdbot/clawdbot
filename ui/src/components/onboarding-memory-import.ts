import { initialState, Task, TaskStatus } from "@lit/task";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  MemoryMigrationProviderPlan,
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../../packages/gateway-protocol/src/schema/migrations.js";
import type { RouteId } from "../app-routes.ts";
import type { ApplicationContext } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import "../styles/onboarding-memory-import.css";
import "./modal-dialog.ts";

const ONBOARDING_MEMORY_IMPORT_KEY = "openclaw.onboarding.memory-import";

type ProviderResult =
  | { kind: "success"; result: MigrationsMemoryApplyResult }
  | { kind: "partial"; result: MigrationsMemoryApplyResult }
  | { kind: "error"; message: string };

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : typeof error === "string"
      ? error
      : t("onboarding.memoryImport.unknownError");
}

function createIdempotencyKey(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return [...globalThis.crypto.getRandomValues(new Uint32Array(4))]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}

function plannedItems(provider: MemoryMigrationProviderPlan) {
  return provider.items.filter((item) => item.status === "planned");
}

function offeredProviders(plan: MigrationsMemoryPlanResult | null) {
  return (
    plan?.providers.filter(
      (provider) => provider.found && provider.planFingerprint && plannedItems(provider).length > 0,
    ) ?? []
  );
}

function guardIsDone(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(ONBOARDING_MEMORY_IMPORT_KEY) === "done";
  } catch {
    return false;
  }
}

function setGuardDone() {
  try {
    globalThis.sessionStorage?.setItem(ONBOARDING_MEMORY_IMPORT_KEY, "done");
  } catch {
    // Storage can be unavailable in hardened browser contexts; closing still works for this load.
  }
}

class OnboardingMemoryImport extends OpenClawLightDomElement {
  @property({ attribute: false }) context?: ApplicationContext<RouteId>;
  @property({ type: Boolean }) active = false;

  @state() private selectedByProvider: Record<string, boolean> = {};
  @state() private applyingProviderId: string | null = null;
  @state() private results: Record<string, ProviderResult> = {};
  @state() private done = false;
  @state() private closed = false;
  private agentsListRequest: ApplicationContext<RouteId>["agents"] | undefined;

  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    )
    .watch(
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
    );

  private readonly planTask = new Task(this, {
    args: () => {
      const snapshot = this.context?.gateway.snapshot;
      return [
        this.active,
        this.closed,
        guardIsDone(),
        this.isConnected && snapshot?.phase === "connected" ? (snapshot.client ?? null) : null,
        snapshot ? hasOperatorAdminAccess(snapshot.hello?.auth ?? null) : false,
        this.currentAgentId(),
      ] as const;
    },
    task: async ([active, closed, guarded, client, admin, agentId], { signal }) => {
      if (
        !active ||
        closed ||
        guarded ||
        !client ||
        !admin ||
        !agentId ||
        this.applyingProviderId !== null ||
        this.done
      ) {
        return initialState;
      }
      const plan = await client.request<MigrationsMemoryPlanResult>(
        "migrations.memory.plan",
        { agentId, overwrite: false },
        { signal },
      );
      if (plan.agentId !== agentId) {
        return initialState;
      }
      if (
        offeredProviders(plan).length === 0 &&
        plan.providers.some((provider) => provider.error)
      ) {
        return initialState;
      }
      return { client, agentId, plan };
    },
    onComplete: ({ plan }) => {
      const providers = offeredProviders(plan);
      if (providers.length === 0) {
        if (!plan.providers.some((provider) => provider.error)) {
          setGuardDone();
          this.closed = true;
        }
        return;
      }
      this.results = {};
      this.done = false;
      this.selectedByProvider = Object.fromEntries(
        providers.map((provider) => [provider.providerId, true]),
      );
    },
  });

  override disconnectedCallback() {
    void this.planTask.run([false, true, true, null, false, null]);
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  protected override updated() {
    if (this.context?.agents.state.agentsList) {
      this.agentsListRequest = undefined;
    } else if (this.context && this.agentsListRequest !== this.context.agents) {
      const agents = this.context.agents;
      this.agentsListRequest = agents;
      void agents
        .ensureList()
        .catch(() => null)
        .then(() => {
          if (this.context?.agents === agents && !agents.state.agentsList) {
            this.agentsListRequest = undefined;
          }
        });
    }
  }

  private currentAgentId(): string | null {
    const list = this.context?.agents.state.agentsList;
    if (!list) {
      return null;
    }
    const selected = this.context?.agentSelection.state.selectedId;
    if (selected && list.agents.some((agent) => agent.id === selected)) {
      return selected;
    }
    return list.defaultId ?? list.agents[0]?.id ?? null;
  }

  private get planBinding() {
    const value = this.planTask.value;
    const snapshot = this.context?.gateway.snapshot;
    const agentId = this.currentAgentId();
    if (this.planTask.status !== TaskStatus.COMPLETE || !value) {
      return null;
    }
    return value.client === snapshot?.client && value.agentId === agentId ? value : null;
  }

  private get plan(): MigrationsMemoryPlanResult | null {
    return this.planBinding?.plan ?? null;
  }

  private toggleProvider(providerId: string, selected: boolean) {
    this.selectedByProvider = { ...this.selectedByProvider, [providerId]: selected };
  }

  private async importSelected() {
    const context = this.context;
    const binding = this.planBinding;
    const plan = binding?.plan;
    const client = binding?.client;
    const agentId = binding?.agentId;
    if (!context || !client || !plan || !agentId || this.applyingProviderId !== null || this.done) {
      return;
    }
    const providers = offeredProviders(plan).filter(
      (provider) => this.selectedByProvider[provider.providerId],
    );
    if (providers.length === 0) {
      return;
    }

    for (const provider of providers) {
      // The batch is frozen to the client/agent it started on. If either
      // changes mid-batch, stop instead of mutating through a stale binding.
      if (
        !this.isConnected ||
        this.closed ||
        this.context?.gateway.snapshot.client !== client ||
        this.currentAgentId() !== agentId
      ) {
        this.results = {
          ...this.results,
          [provider.providerId]: {
            kind: "error",
            message: t("onboarding.memoryImport.connectionChanged"),
          },
        };
        continue;
      }
      const itemIds = plannedItems(provider).map((item) => item.id);
      const planFingerprint = provider.planFingerprint;
      if (!planFingerprint || itemIds.length === 0) {
        continue;
      }
      this.applyingProviderId = provider.providerId;
      try {
        const result = await client.request<MigrationsMemoryApplyResult>(
          "migrations.memory.apply",
          {
            idempotencyKey: createIdempotencyKey(),
            agentId,
            providerId: provider.providerId,
            planFingerprint,
            itemIds,
            overwrite: false,
          },
        );
        this.results = {
          ...this.results,
          [provider.providerId]: {
            kind: result.summary.errors > 0 || result.summary.conflicts > 0 ? "partial" : "success",
            result,
          },
        };
      } catch (error) {
        this.results = {
          ...this.results,
          [provider.providerId]: { kind: "error", message: toErrorMessage(error) },
        };
      }
    }
    this.applyingProviderId = null;
    this.done =
      this.context?.gateway.snapshot.client === client && this.currentAgentId() === agentId;
    if (!this.done) {
      void this.planTask.run();
    }
  }

  private finish() {
    setGuardDone();
    this.closed = true;
  }

  private reviewDetails() {
    this.finish();
    this.context?.navigate("memory-import");
  }

  private handleModalCancel(event: Event) {
    if (this.applyingProviderId !== null) {
      event.preventDefault();
      return;
    }
    this.finish();
  }

  private renderProvider(provider: MemoryMigrationProviderPlan) {
    const planned = plannedItems(provider).length;
    const conflicts = provider.items.filter((item) => item.status === "conflict").length;
    const result = this.results[provider.providerId];
    const applying = this.applyingProviderId === provider.providerId;
    return html`
      <li class="onboarding-memory-import__provider" data-provider-id=${provider.providerId}>
        <label>
          <input
            type="checkbox"
            .checked=${this.selectedByProvider[provider.providerId] ?? false}
            ?disabled=${this.applyingProviderId !== null || this.done}
            @change=${(event: Event) =>
              this.toggleProvider(
                provider.providerId,
                (event.currentTarget as HTMLInputElement).checked,
              )}
          />
          <span class="onboarding-memory-import__provider-copy">
            <strong>${provider.label}</strong>
            <code title=${provider.source ?? ""}
              >${provider.source ?? t("onboarding.memoryImport.sourceUnavailable")}</code
            >
            <small>
              ${t("onboarding.memoryImport.plannedCount", { count: String(planned) })}
              ${conflicts > 0
                ? html`<span>
                    ${t("onboarding.memoryImport.alreadyImported", {
                      count: String(conflicts),
                    })}
                  </span>`
                : nothing}
            </small>
          </span>
        </label>
        <div class="onboarding-memory-import__provider-status" aria-live="polite">
          ${applying
            ? t("onboarding.memoryImport.importingProvider")
            : result?.kind === "success"
              ? t("onboarding.memoryImport.providerResult", {
                  migrated: String(result.result.summary.migrated),
                  skipped: String(result.result.summary.skipped),
                })
              : result?.kind === "partial"
                ? html`<span role="alert">
                    ${t("onboarding.memoryImport.providerIncomplete", {
                      conflicts: String(result.result.summary.conflicts),
                      errors: String(result.result.summary.errors),
                      migrated: String(result.result.summary.migrated),
                      skipped: String(result.result.summary.skipped),
                    })}
                  </span>`
                : result?.kind === "error"
                  ? html`<span role="alert">
                      ${t("onboarding.memoryImport.providerError", { error: result.message })}
                    </span>`
                  : nothing}
        </div>
      </li>
    `;
  }

  override render() {
    const context = this.context;
    const snapshot = context?.gateway.snapshot;
    const providers = offeredProviders(this.plan);
    if (
      !this.active ||
      this.closed ||
      guardIsDone() ||
      !context ||
      snapshot?.phase !== "connected" ||
      !snapshot.client ||
      !hasOperatorAdminAccess(snapshot.hello?.auth ?? null) ||
      providers.length === 0
    ) {
      return nothing;
    }

    const selectedCount = providers.filter(
      (provider) => this.selectedByProvider[provider.providerId],
    ).length;
    const completedResults = Object.values(this.results).filter(
      (result): result is Exclude<ProviderResult, { kind: "error" }> => result.kind !== "error",
    );
    const migrated = completedResults.reduce(
      (total, result) => total + result.result.summary.migrated,
      0,
    );
    const skipped = completedResults.reduce(
      (total, result) => total + result.result.summary.skipped,
      0,
    );
    const title = t("onboarding.memoryImport.title");
    const body = t("onboarding.memoryImport.body");
    return html`
      <openclaw-modal-dialog
        class="onboarding-memory-import-dialog"
        label=${title}
        description=${body}
        @modal-cancel=${(event: Event) => this.handleModalCancel(event)}
      >
        <section class="onboarding-memory-import">
          <header>
            <h2>${this.done ? t("onboarding.memoryImport.doneTitle") : title}</h2>
            <p>
              ${this.done
                ? t("onboarding.memoryImport.doneBody", {
                    migrated: String(migrated),
                    skipped: String(skipped),
                  })
                : body}
            </p>
          </header>
          <ul>
            ${providers.map((provider) => this.renderProvider(provider))}
          </ul>
          <footer>
            ${this.done
              ? html`<button
                  class="btn primary"
                  type="button"
                  data-test-id="onboarding-memory-import-continue"
                  @click=${() => this.finish()}
                >
                  ${t("common.continue")}
                </button>`
              : html`
                  <button
                    class="btn primary"
                    type="button"
                    data-test-id="onboarding-memory-import-import"
                    ?disabled=${selectedCount === 0 || this.applyingProviderId !== null}
                    @click=${() => void this.importSelected()}
                  >
                    ${this.applyingProviderId
                      ? t("common.importing")
                      : t("onboarding.memoryImport.import")}
                  </button>
                  <button
                    class="btn"
                    type="button"
                    data-test-id="onboarding-memory-import-skip"
                    ?disabled=${this.applyingProviderId !== null}
                    @click=${() => this.finish()}
                  >
                    ${t("onboarding.memoryImport.skip")}
                  </button>
                  <button
                    class="btn btn--ghost onboarding-memory-import__review"
                    type="button"
                    ?disabled=${this.applyingProviderId !== null}
                    @click=${() => this.reviewDetails()}
                  >
                    ${t("onboarding.memoryImport.reviewDetails")}
                  </button>
                `}
          </footer>
        </section>
      </openclaw-modal-dialog>
    `;
  }
}

if (!customElements.get("openclaw-onboarding-memory-import")) {
  customElements.define("openclaw-onboarding-memory-import", OnboardingMemoryImport);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-onboarding-memory-import": OnboardingMemoryImport;
  }
}
