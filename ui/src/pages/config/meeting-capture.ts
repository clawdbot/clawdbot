import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import type { TranscriptsStatusResult } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerTranscriptsEnglish } from "../../i18n/locales/en-transcripts.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { COMMUNICATION_SETTINGS_TARGET_IDS } from "./settings-targets.ts";

registerTranscriptsEnglish();

const LOCATOR_FIELDS = ["accountId", "guildId", "channelId", "meetingUrl"] as const;
const SOURCE_FIELDS = ["title", ...LOCATOR_FIELDS, "sessionId"] as const;
type SourceProvider = TranscriptsStatusResult["providers"][number];

function supportsAutoStartSetup(provider: SourceProvider | undefined): boolean {
  return (
    provider?.availability === "enabled" &&
    provider.canStart !== false &&
    Boolean(provider.autoStart)
  );
}

class MeetingCaptureSettings extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @property({ type: Boolean }) mutationDisabled = false;
  @property({ attribute: false }) editor: TemplateResult | typeof nothing = nothing;
  @property({ type: Boolean }) advancedExpanded = false;
  @state() private editing: number | "new" | null = null;
  @state() private editError: string | null = null;
  @state() private editedProviderId = "";
  private editedSource: unknown;
  private sourceDraft: Record<string, unknown> = {};
  private locatorRequirements: SourceProvider["autoStart"];
  private originalLocatorRequirements: SourceProvider["autoStart"];
  private connectionHello: unknown;
  private connectionAuth: unknown;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.statusTask.abort(),
    onSnapshot: ({ snapshot: { hello } }) => {
      // A new handshake or authorization can replace a still-connected client.
      if (hello !== this.connectionHello || hello?.auth !== this.connectionAuth) {
        this.gateway.invalidate();
        this.statusTask.abort();
      }
      this.connectionHello = hello;
      this.connectionAuth = hello?.auth;
    },
  });
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.runtimeConfig,
    (config, notify) => config.subscribe(notify),
  );

  private get client() {
    const snapshot = this.context?.gateway.snapshot;
    return this.isConnected &&
      snapshot?.phase === "connected" &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null)
      ? snapshot.client
      : null;
  }

  private readonly statusTask = new Task(this, {
    args: () =>
      [
        this.client,
        this.gateway.epoch,
        this.context?.runtimeConfig.state.configSnapshot?.hash,
      ] as const,
    task: async ([client, , hash], { signal }) => {
      if (!client) {
        return initialState;
      }
      const scope = this.gateway.capture();
      const gateway = this.context.gateway;
      const hello = gateway.snapshot.hello;
      const auth = hello?.auth;
      const result = await client.request<TranscriptsStatusResult>(
        "transcripts.status",
        {},
        { signal },
      );
      const isCurrent = () =>
        this.client === client &&
        scope !== null &&
        this.gateway.isCurrent(scope) &&
        this.context.gateway === gateway &&
        gateway.snapshot.hello === hello &&
        hello?.auth === auth &&
        this.context.runtimeConfig.state.configSnapshot?.hash === hash;
      return isCurrent() ? { status: result, isCurrent } : initialState;
    },
    onComplete: (result) => {
      if (result.isCurrent()) {
        this.retainLocatorRequirements(result.status);
      }
    },
  });

  override disconnectedCallback() {
    this.statusTask.abort();
    this.subscriptions.clear();
    this.editSource(null);
    super.disconnectedCallback();
  }

  private get disabled() {
    const config = this.context.runtimeConfig;
    return (
      this.mutationDisabled ||
      !config.canSet ||
      !config.state.connected ||
      config.state.configLoading ||
      config.state.configSaving ||
      config.state.configApplying ||
      this.rawDraftPending ||
      !hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null)
    );
  }

  private get rawDraftPending() {
    const configState = this.context.runtimeConfig.state;
    // A whole source-array edit cannot safely be built from the parsed snapshot
    // while the authoritative raw buffer contains a different source list.
    return configState.configFormMode === "raw" && configState.configFormDirty;
  }

  private get config() {
    const configState = this.context.runtimeConfig.state;
    return asNullableRecord(
      asNullableRecord(configState.configForm ?? configState.configSnapshot?.config)?.transcripts,
    );
  }

  private get sources(): unknown[] {
    return Array.isArray(this.config?.autoStart) ? this.config.autoStart : [];
  }

  private editSource(index: number | "new" | null) {
    // The keyed form survives same-editor clicks. Keep its draft and captured
    // source together until Cancel, save, or a different editor ends ownership.
    if (this.editing === index) {
      return;
    }
    this.editing = index;
    this.editedSource = typeof index === "number" ? this.sources[index] : undefined;
    this.sourceDraft = { ...asNullableRecord(this.editedSource) };
    this.locatorRequirements = this.originalLocatorRequirements = undefined;
    const providerId = asNullableRecord(this.editedSource)?.providerId;
    this.selectProvider(typeof providerId === "string" ? providerId : "");
    this.editError = null;
  }

  private selectProvider(providerId: string) {
    if (this.editedProviderId !== providerId) {
      this.locatorRequirements = undefined;
    }
    this.editedProviderId = providerId;
    this.retainLocatorRequirements(this.knownCaptureStatus);
  }

  private retainLocatorRequirements(status: TranscriptsStatusResult | null) {
    if (this.editing === null) {
      return;
    }
    const retain = (providerId: unknown, known: SourceProvider["autoStart"]) => {
      const requirements = status?.providers.find(
        (provider) => provider.providerId === normalizeOptionalString(providerId),
      )?.autoStart;
      return requirements ? { ...known, ...requirements } : known;
    };
    // Returning to the authored source still allows edits after health fails.
    // Temporary provider choices must not erase its validation or confer availability.
    const originalProviderId = asNullableRecord(this.editedSource)?.providerId;
    this.originalLocatorRequirements = retain(originalProviderId, this.originalLocatorRequirements);
    this.locatorRequirements =
      normalizeOptionalString(this.editedProviderId) === normalizeOptionalString(originalProviderId)
        ? this.originalLocatorRequirements
        : retain(this.editedProviderId, this.locatorRequirements);
  }

  private saveSource(event: SubmitEvent) {
    event.preventDefault();
    if (this.disabled || this.editing === null) {
      return;
    }
    const sources = [...this.sources];
    if (this.editing !== "new" && sources[this.editing] !== this.editedSource) {
      this.editError = t("meetingCapture.sourceChanged");
      return;
    }
    // SAFETY: renderSourceEditor calls this synchronously from its native form's submit binding.
    const form = event.currentTarget as HTMLFormElement;
    if (!form.reportValidity()) {
      return;
    }
    const data = new FormData(form);
    const source = { ...asNullableRecord(this.editedSource) };
    const providerId = normalizeOptionalString(data.get("providerId"));
    const provider = this.captureStatus?.providers.find((item) => item.providerId === providerId);
    if (
      (this.editing === "new" || this.editedProviderId !== source.providerId) &&
      !supportsAutoStartSetup(provider)
    ) {
      this.editError = t("meetingCapture.autoStartUnavailable");
      return;
    }
    for (const key of ["providerId", ...SOURCE_FIELDS]) {
      // Drafts record input events; browser URL sanitization must not turn an
      // untouched value into an edit. Absent controls still preserve configured fields.
      const draftValue = key === "providerId" ? this.editedProviderId : this.sourceDraft[key];
      if (!data.has(key) || (this.editing !== "new" && draftValue === source[key])) {
        continue;
      }
      const value = normalizeOptionalString(data.get(key));
      if (value) {
        source[key] = value;
      } else {
        delete source[key];
      }
    }
    const missing = LOCATOR_FIELDS.find(
      (key) =>
        this.locatorRequirements?.[key] === "required" && !normalizeOptionalString(source[key]),
    );
    if (missing) {
      this.editError = t("meetingCapture.requiredLocator", {
        field: t(`meetingCapture.fields.${missing}`),
      });
      return;
    }
    if (this.editing === "new") {
      sources.push(source);
    } else {
      sources[this.editing] = source;
    }
    this.context.runtimeConfig.patchForm(["transcripts", "autoStart"], [...sources]);
    this.editSource(null);
  }

  private renderSourceEditor(status: TranscriptsStatusResult | null) {
    if (this.editing === null) {
      return nothing;
    }
    const source = this.sourceDraft;
    const providers =
      status?.providers
        .filter(supportsAutoStartSetup)
        .toSorted((a, b) => a.name.localeCompare(b.name)) ?? [];
    const configuredProvider = typeof source?.providerId === "string" ? source.providerId : "";
    const providerOptions = providers.map((provider) => ({
      id: provider.providerId,
      label: `${provider.name} · ${t(`meetingCapture.availability.${provider.availability}`)}`,
    }));
    for (const id of [configuredProvider, this.editedProviderId]) {
      if (id && !providerOptions.some((option) => option.id === id)) {
        providerOptions.push({ id, label: id });
      }
    }
    const selectedProvider = status?.providers.find(
      (item) => item.providerId === this.editedProviderId,
    );
    const fields = [
      "title",
      ...LOCATOR_FIELDS.filter(
        (key) => this.locatorRequirements?.[key] || source?.[key] !== undefined,
      ),
      "sessionId",
    ] as const;
    return html`<form @submit=${(event: SubmitEvent) => this.saveSource(event)}>
      ${renderSettingsSection(
        {
          title: t(
            this.editing === "new" ? "meetingCapture.addSource" : "meetingCapture.editSource",
          ),
        },
        html`
          ${renderSettingsRow({
            title: t("meetingCapture.fields.providerId"),
            control: html`<select
              class="settings-select"
              name="providerId"
              aria-label=${t("meetingCapture.fields.providerId")}
              required
              ?disabled=${this.disabled}
              .value=${this.editedProviderId}
              @change=${(event: Event) => {
                // SAFETY: This native select emits the change event handled by its own binding.
                this.selectProvider((event.target as HTMLSelectElement).value);
              }}
            >
              <option value="">${t("meetingCapture.chooseProvider")}</option>
              ${repeat(
                providerOptions,
                (option) => option.id,
                (option) =>
                  html`<option value=${option.id} ?selected=${option.id === this.editedProviderId}>
                    ${option.label}
                  </option>`,
              )}
            </select>`,
          })}
          ${
            this.editedProviderId && !supportsAutoStartSetup(selectedProvider)
              ? renderSettingsEmpty(t("meetingCapture.autoStartUnavailable"))
              : nothing
          }
          ${repeat(
            fields,
            (key) => key,
            (key) =>
              renderSettingsRow({
                title: t(`meetingCapture.fields.${key}`),
                description:
                  key === "sessionId"
                    ? t(
                        source.whenOccupied === true
                          ? "meetingCapture.occupancySessionIdHint"
                          : "meetingCapture.sessionIdHint",
                      )
                    : key === "title"
                      ? t("meetingCapture.titleHint")
                      : undefined,
                control: html`<input
                  class="settings-input"
                  name=${key}
                  type=${key === "meetingUrl" ? "url" : "text"}
                  aria-label=${t(`meetingCapture.fields.${key}`)}
                  ?disabled=${this.disabled || (key === "sessionId" && source.whenOccupied === true)}
                  ?required=${
                    key !== "title" &&
                    key !== "sessionId" &&
                    this.locatorRequirements?.[key] === "required"
                  }
                  .value=${typeof source?.[key] === "string" ? source[key] : ""}
                  @input=${(event: Event) => {
                    // Health refreshes can remove metadata; unsaved locators must survive.
                    // SAFETY: This native input emits the input event handled by its own binding.
                    this.sourceDraft[key] = (event.target as HTMLInputElement).value;
                  }}
                />`,
              }),
          )}
          ${renderSettingsRow({
            title: t("meetingCapture.locatorsHint"),
            control: html` <button
                type="button"
                class="btn"
                @click=${() => {
                  this.editSource(null);
                }}
              >
                ${t("common.cancel")}
              </button>
              <button
                type="submit"
                class="btn"
                ?disabled=${this.disabled || !this.editedProviderId}
              >
                ${t("meetingCapture.saveSource")}
              </button>`,
          })}
          ${
            this.editError
              ? renderSettingsEmpty(html`<span role="alert">${this.editError}</span>`)
              : nothing
          }
        `,
      )}
    </form>`;
  }

  private get knownCaptureStatus() {
    // Task retains its value while pending, including across connection changes.
    // Only the original request owner can seed an editor's validation rules.
    const result = this.statusTask.value;
    return result?.isCurrent() ? result.status : null;
  }

  private get captureStatus() {
    return this.statusTask.status === TaskStatus.COMPLETE ? this.knownCaptureStatus : null;
  }

  override render() {
    const status = this.captureStatus;
    const error =
      this.statusTask.status === TaskStatus.ERROR ? formatUiError(this.statusTask.error) : null;
    const saved = status?.latestTranscript;
    const sourceRows = this.sources.map((raw, index) => {
      const source = asNullableRecord(raw);
      const provider = status?.providers.find((item) => item.providerId === source?.providerId);
      return renderSettingsRow({
        title:
          typeof source?.title === "string"
            ? source.title
            : (normalizeOptionalString(source?.providerId) ?? t("transcripts.unknown")),
        description: [
          provider?.name,
          source?.accountId,
          source?.guildId,
          source?.channelId,
          source?.meetingUrl,
        ]
          .filter((value) => typeof value === "string" && value)
          .join(" · "),
        control: html`<button
            class="btn"
            ?disabled=${this.disabled}
            aria-label=${t("meetingCapture.editSourceNumber", { number: String(index + 1) })}
            @click=${() => this.editSource(index)}
          >
            ${icons.edit}${t("meetingCapture.edit")}
          </button>
          <button
            class="btn"
            ?disabled=${this.disabled}
            aria-label=${t("meetingCapture.removeSourceNumber", { number: String(index + 1) })}
            @click=${() => {
              if (this.disabled) {
                return;
              }
              this.context.runtimeConfig.patchForm(
                ["transcripts", "autoStart"],
                this.sources.filter((_, position) => position !== index),
              );
              this.editSource(null);
            }}
          >
            ${icons.trash}${t("common.remove")}
          </button>`,
      });
    });
    return html`${renderSettingsPage(html`
        <div class="settings-stack" id=${COMMUNICATION_SETTINGS_TARGET_IDS.meetingCapture}>
          ${renderSettingsSection(
            { title: t("meetingCapture.title"), description: t("meetingCapture.description") },
            html`
              ${renderSettingsToggleRow({
                title: t("meetingCapture.enabled"),
                description: t("meetingCapture.enabledHint"),
                checked: this.config?.enabled !== false,
                disabled: this.disabled,
                onChange: (enabled) => {
                  if (!this.disabled) {
                    this.context.runtimeConfig.patchForm(["transcripts", "enabled"], enabled);
                  }
                },
              })}
              ${renderSettingsNavRow({
                title: t("transcripts.library"),
                description: t("meetingCapture.libraryHint"),
                onClick: () => this.context.navigate("meetings"),
              })}
              ${renderSettingsRow({
                title: t("meetingCapture.observedState"),
                description: t("meetingCapture.stateHint"),
                control: renderSettingsStatus({
                  kind: "muted",
                  label: t(
                    status
                      ? status.enabled
                        ? "meetingCapture.states.enabled"
                        : "meetingCapture.states.disabled"
                      : "meetingCapture.states.unknown",
                  ),
                }),
              })}
              ${renderSettingsRow({
                title: t("meetingCapture.latestTranscript"),
                description: saved
                  ? saved.title
                  : t(status ? "meetingCapture.noSaved" : "transcripts.unknown"),
                control: renderSettingsValue(
                  saved
                    ? t("transcripts.savedCount", { count: String(saved.utteranceCount) })
                    : t("transcripts.unknown"),
                ),
              })}
              ${
                saved
                  ? renderSettingsRow({
                      title: t("meetingCapture.lastUtterance"),
                      control: renderSettingsValue(
                        saved.lastUtteranceAt
                          ? new Date(saved.lastUtteranceAt).toLocaleString()
                          : t("transcripts.unknown"),
                      ),
                    })
                  : nothing
              }
              ${renderSettingsRow({
                title: t("meetingCapture.health"),
                control: html`<button
                  class="btn"
                  ?disabled=${!this.client || this.statusTask.status === TaskStatus.PENDING}
                  @click=${() => void this.statusTask.run()}
                >
                  ${icons.refresh}${t("common.refresh")}
                </button>`,
              })}
              ${
                error
                  ? renderSettingsEmpty(
                      html`<span role="alert">${t("meetingCapture.healthError")} ${error}</span>`,
                    )
                  : nothing
              }
              ${
                this.statusTask.status === TaskStatus.PENDING
                  ? renderSettingsEmpty(html`<span role="status">${t("common.loading")}</span>`)
                  : nothing
              }
              ${
                !hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null)
                  ? renderSettingsEmpty(t("configView.adminRequired"))
                  : nothing
              }
              ${
                this.rawDraftPending
                  ? renderSettingsEmpty(t("meetingCapture.rawDraftPending"))
                  : nothing
              }
            `,
          )}
          ${renderSettingsSection(
            {
              title: t("meetingCapture.sources"),
              description: t("meetingCapture.sourcesHint"),
              actions: html`<button
                class="btn"
                ?disabled=${this.disabled || !status?.providers.some(supportsAutoStartSetup)}
                @click=${() => this.editSource("new")}
              >
                ${icons.plus}${t("meetingCapture.addSource")}
              </button>`,
            },
            sourceRows.length ? sourceRows : renderSettingsEmpty(t("meetingCapture.noSources")),
          )}
          ${keyed(this.editing, this.renderSourceEditor(status))}
          ${
            status && !status.providers.some(supportsAutoStartSetup)
              ? renderSettingsEmpty(t("meetingCapture.noAutoStartProviders"))
              : nothing
          }
          ${
            status?.configuredSources.length
              ? renderSettingsSection(
                  {
                    title: t("meetingCapture.sourceHealth"),
                    description: t("meetingCapture.armedHint"),
                  },
                  status.configuredSources.map((item) =>
                    renderSettingsRow({
                      title: item.title ?? item.source.providerId,
                      description: [
                        item.source.accountId,
                        item.source.guildId,
                        item.source.channelId,
                        item.source.meetingUrl,
                        item.startDiagnostic
                          ? t(`meetingCapture.startDiagnostics.${item.startDiagnostic}`)
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                      control: renderSettingsStatus({
                        kind: "muted",
                        label: t(`meetingCapture.states.${item.state}`),
                      }),
                    }),
                  ),
                )
              : nothing
          }
          ${
            status && Object.values(status.omitted).some((count) => count > 0)
              ? html`<p class="settings-page__intro">
                  ${t("meetingCapture.omitted", {
                    count: String(
                      Object.values(status.omitted).reduce((sum, count) => sum + count, 0),
                    ),
                  })}
                </p>`
              : nothing
          }
          <p class="settings-page__intro">${t("meetingCapture.safetyHint")}</p>
          <p class="settings-page__intro">${t("meetingCapture.durationHint")}</p>
          <p class="settings-page__intro">${t("meetingCapture.sttHint")}</p>
        </div>
      `)}
      <details class="settings-page" ?open=${this.advancedExpanded}>
        <summary class="settings-section__heading">${t("meetingCapture.advancedSettings")}</summary>
        ${this.editor}
      </details>`;
  }
}

if (!customElements.get("openclaw-meeting-capture-settings")) {
  customElements.define("openclaw-meeting-capture-settings", MeetingCaptureSettings);
}

export function renderMeetingCapture(props: {
  mutationDisabled: boolean;
  advancedExpanded: boolean;
  editor: TemplateResult | typeof nothing;
}) {
  return html`<openclaw-meeting-capture-settings
    .mutationDisabled=${props.mutationDisabled}
    .advancedExpanded=${props.advancedExpanded}
    .editor=${props.editor}
  ></openclaw-meeting-capture-settings>`;
}
