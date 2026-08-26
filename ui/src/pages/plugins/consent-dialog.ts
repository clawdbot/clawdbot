import { html, nothing, type TemplateResult } from "lit";
import type { CapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginConsentEnglish } from "../../i18n/locales/en-plugin-consent.ts";
import type {
  PluginDeclaredSurface,
  PluginHookGrant,
  PluginInspectSource,
  PluginInstallRequest,
  PluginOperatorGrants,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { pluginArtPath, pluginFallbackGradient, pluginMonogram } from "./presentation.ts";

registerPluginConsentEnglish();

export type PluginConsentIntent =
  | { kind: "install"; request: PluginInstallRequest; installIdentity: string }
  | { kind: "enable"; pluginId: string; rowKey: string };

type PluginConsentFallback = {
  name: string;
  version?: string;
  official?: boolean;
  verificationTier?: string;
};

export type PluginConsentState = {
  intent: PluginConsentIntent;
  pluginId: string | null;
  fallback: PluginConsentFallback | null;
  details?: CapabilityConsentErrorDetails;
};

type PluginConsentDialogProps = {
  consent: PluginConsentState;
  inspection: PluginsInspectResult | null;
  loading: boolean;
  error: string | null;
  iconUrl?: string;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
};

export function renderArtTile(
  slug: string,
  name: string,
  iconUrl?: string,
  onIconError?: () => void,
  className = "plugins-tile",
): TemplateResult {
  const art = pluginArtPath(slug);
  if (art) {
    return html`<span class=${className}>
      <img src=${art} alt="" loading="lazy" decoding="async" />
    </span>`;
  }
  if (iconUrl) {
    return html`<span class=${className}>
      <img
        class="plugins-icon"
        src=${iconUrl}
        alt=""
        loading="lazy"
        decoding="async"
        @error=${onIconError}
      />
    </span>`;
  }
  const [from, to] = pluginFallbackGradient(slug);
  const monogram = pluginMonogram(name);
  return html`<span
    class=${`${className} ${className}--fallback`}
    style=${`--plugins-art-a:${from};--plugins-art-b:${to}`}
    aria-hidden="true"
  >
    ${monogram ? html`<span>${monogram}</span>` : icons.puzzle}
  </span>`;
}

function capabilityRow(label: string, value: TemplateResult | string, warning = false) {
  return html`
    <div class="plugins-detail__meta-row ${warning ? "plugins-consent__row--warning" : ""}">
      <span class="plugins-detail__meta-label">${label}</span>
      <span class="plugins-detail__meta-value">${value}</span>
    </div>
  `;
}

function renderCapabilityItems(items: readonly string[]) {
  return html`<span class="plugins-consent__items">${items.join(", ")}</span>`;
}

function capabilityGroups(): ReadonlyArray<readonly [keyof PluginDeclaredSurface, string]> {
  return [
    ["channels", t("pluginsPage.categoryChannels")],
    ["providers", t("pluginsPage.categoryProviders")],
    ["tools", t("pluginsPage.categoryTools")],
    ["contracts", t("pluginConsent.contracts")],
    ["hooks", t("pluginConsent.hooks")],
    ["mcpServers", t("pluginConsent.mcpServers")],
    ["cliCommands", t("pluginConsent.cliCommands")],
    ["cliBackends", t("pluginConsent.cliBackends")],
    ["skills", t("pluginConsent.skills")],
    ["dangerousConfigFlags", t("pluginConsent.dangerousFlags")],
  ];
}

export function renderPluginDeclaredCapabilities(declared: PluginDeclaredSurface): TemplateResult {
  const rows = capabilityGroups().flatMap(([key, label]) =>
    key !== "dangerousConfigFlags" && declared[key].length > 0
      ? [capabilityRow(label, renderCapabilityItems(declared[key]))]
      : [],
  );
  return html`
    <section class="plugins-consent__section">
      <h3>${t("pluginConsent.declaredTitle")}</h3>
      <p class="plugins-consent__description">${t("pluginConsent.declaredDescription")}</p>
      ${rows.length > 0
        ? html`<div class="plugins-consent__rows">${rows}</div>`
        : html`<p class="plugins-consent__hint">${t("pluginConsent.declaredEmpty")}</p>`}
      ${declared.hooks.length === 0
        ? capabilityRow(t("pluginConsent.hooks"), t("pluginConsent.runtimeHooks"))
        : nothing}
      ${declared.dangerousConfigFlags.length > 0
        ? capabilityRow(
            t("pluginConsent.dangerousFlags"),
            renderCapabilityItems(declared.dangerousConfigFlags),
            true,
          )
        : nothing}
    </section>
  `;
}

function renderWidenedCapabilities(details: CapabilityConsentErrorDetails) {
  if (!details.widened) {
    return nothing;
  }
  const rows = capabilityGroups().flatMap(([key, label]) => {
    const added = details.widened?.[key];
    return added?.length ? [capabilityRow(label, renderCapabilityItems(added), true)] : [];
  });
  if (rows.length === 0) {
    return nothing;
  }
  return html`
    <section class="plugins-consent__section">
      <h3>${t("pluginConsent.widenedTitle")}</h3>
      <p class="plugins-consent__description">
        ${t("pluginConsent.widenedDescription")}
        ${details.acceptedAt
          ? t("pluginConsent.previouslyAccepted", { date: details.acceptedAt })
          : nothing}
      </p>
      <div class="plugins-consent__rows">${rows}</div>
    </section>
  `;
}

function grantValue(grant: PluginHookGrant, on: string, off: string) {
  return `${grant.effective ? on : off} ${t(
    grant.configured === undefined ? "pluginConsent.grantDefault" : "pluginConsent.grantConfigured",
  )}`;
}

function modelOverrideSummary(
  overrides: NonNullable<PluginOperatorGrants["llm"] | PluginOperatorGrants["subagent"]>,
): string {
  const values: string[] = [];
  if (overrides.allowModelOverride !== undefined) {
    values.push(
      t("pluginConsent.modelOverride", {
        value: t(overrides.allowModelOverride ? "pluginConsent.allowed" : "pluginConsent.blocked"),
      }),
    );
  }
  if (overrides.allowedModels?.length) {
    values.push(t("pluginConsent.allowedModels", { models: overrides.allowedModels.join(", ") }));
  }
  if ("allowedCompletionModels" in overrides && overrides.allowedCompletionModels?.length) {
    values.push(
      t("pluginConsent.allowedCompletionModels", {
        models: overrides.allowedCompletionModels.join(", "),
      }),
    );
  }
  if ("allowAuthProfileOverride" in overrides && overrides.allowAuthProfileOverride !== undefined) {
    values.push(
      t("pluginConsent.authProfileOverride", {
        value: t(
          overrides.allowAuthProfileOverride ? "pluginConsent.allowed" : "pluginConsent.blocked",
        ),
      }),
    );
  }
  if ("allowAgentIdOverride" in overrides && overrides.allowAgentIdOverride !== undefined) {
    values.push(
      t("pluginConsent.agentIdOverride", {
        value: t(
          overrides.allowAgentIdOverride ? "pluginConsent.allowed" : "pluginConsent.blocked",
        ),
      }),
    );
  }
  return values.join(" · ") || t("pluginConsent.noOverrides");
}

export function renderPluginGrants(grants: PluginOperatorGrants, origin?: string): TemplateResult {
  const conversation = grants.hooks.allowConversationAccess;
  return html`
    <section class="plugins-consent__section">
      <h3>${t("pluginConsent.grantsTitle")}</h3>
      <p class="plugins-consent__description">${t("pluginConsent.grantsDescription")}</p>
      <div class="plugins-consent__rows">
        ${capabilityRow(
          t("pluginConsent.promptInjection"),
          grantValue(
            grants.hooks.allowPromptInjection,
            t("pluginConsent.allowed"),
            t("pluginConsent.blocked"),
          ),
        )}
        ${capabilityRow(
          t("pluginConsent.conversationAccess"),
          html`
            ${grantValue(conversation, t("pluginConsent.on"), t("pluginConsent.off"))}
            ${!conversation.effective &&
            conversation.configured === undefined &&
            origin !== "bundled"
              ? html`<span class="plugins-consent__hint">
                  ${t("pluginConsent.externalAccessHint")}
                </span>`
              : nothing}
          `,
        )}
        ${grants.llm
          ? capabilityRow(t("pluginConsent.modelOverrides"), modelOverrideSummary(grants.llm))
          : nothing}
        ${grants.subagent
          ? capabilityRow(
              t("pluginConsent.subagentModelOverrides"),
              modelOverrideSummary(grants.subagent),
            )
          : nothing}
      </div>
    </section>
  `;
}

function sourceKindLabel(kind: PluginInspectSource["kind"]): string {
  switch (kind) {
    case "bundled":
      return t("pluginsPage.included");
    case "official-catalog":
      return t("pluginsPage.official");
    case "clawhub":
      return t("pluginConsent.sourceClawHub");
    case "npm":
      return t("pluginConsent.sourceNpm");
    case "git":
      return t("pluginConsent.sourceGit");
    case "path":
      return t("pluginConsent.sourcePath");
    case "archive":
      return t("pluginConsent.sourceArchive");
    case "marketplace":
      return t("pluginConsent.sourceMarketplace");
    default:
      return kind satisfies never;
  }
}

function originLabel(origin: string | undefined, official?: boolean): string | null {
  if (official) {
    return t("pluginsPage.official");
  }
  switch (origin) {
    case "bundled":
      return t("pluginsPage.included");
    case "global":
      return t("pluginsPage.global");
    case "workspace":
      return t("pluginsPage.workspace");
    case "config":
      return t("pluginsPage.config");
    case "official":
      return t("pluginsPage.official");
    default:
      return origin ?? (official === false ? t("pluginConsent.community") : null);
  }
}

function renderProvenance(source: PluginInspectSource | undefined) {
  if (!source) {
    return nothing;
  }
  const integrityLabel =
    source.integrityKind === "sha256"
      ? t("pluginConsent.sha256")
      : source.integrityKind === "git-commit"
        ? t("pluginConsent.commit")
        : t("pluginConsent.integrity");
  return html`
    <div class="plugins-consent__provenance">
      <span
        >${[sourceKindLabel(source.kind), source.spec ?? source.packageName]
          .filter(Boolean)
          .join(" · ")}</span
      >
      ${source.integrity
        ? html`<span title=${source.integrity}>
            ${integrityLabel}: <code>${source.integrity.slice(0, 20)}…</code>
          </span>`
        : nothing}
    </div>
    ${source.integrity
      ? html`<p class="plugins-consent__hint">${t("pluginConsent.pinnedArtifact")}</p>`
      : nothing}
  `;
}

function renderTrust(trust: PluginsInspectResult["trust"]) {
  if (!trust) {
    return nothing;
  }
  const label = t(
    trust.disposition === "clean"
      ? "pluginConsent.verifiedClean"
      : trust.disposition === "review-recommended"
        ? "pluginConsent.reviewRecommended"
        : trust.disposition === "review-required"
          ? "pluginConsent.reviewRequired"
          : "pluginConsent.trustBlocked",
  );
  const kind =
    trust.disposition === "clean" ? "ok" : trust.disposition === "blocked" ? "danger" : "warn";
  return html`
    <section class="plugins-consent__trust">
      ${renderSettingsStatus({ kind, label })}
      ${trust.reasons?.length
        ? html`<ul>
            ${trust.reasons.map((reason) => html`<li>${reason}</li>`)}
          </ul>`
        : nothing}
      ${trust.checkedAt
        ? html`<p class="plugins-consent__hint">
            ${t("pluginConsent.scanDate", { date: trust.checkedAt })}
          </p>`
        : nothing}
    </section>
  `;
}

export function renderPluginConsentDialog(props: PluginConsentDialogProps): TemplateResult {
  const { consent, inspection } = props;
  const details = consent.details;
  const plugin = inspection?.plugin;
  const fallback = consent.fallback;
  const packageName =
    inspection?.source?.packageName ??
    (consent.intent.kind === "install" && consent.intent.request.source === "clawhub"
      ? consent.intent.request.packageName
      : null);
  const slug = consent.pluginId ?? packageName ?? fallback?.name ?? "plugin";
  const name = plugin?.name ?? fallback?.name ?? slug;
  const version = plugin?.version ?? fallback?.version;
  const origin = originLabel(plugin?.origin, fallback?.official);
  const verification =
    fallback?.verificationTier === "source-linked"
      ? t("pluginsPage.verifiedSource")
      : fallback?.verificationTier;
  const meta = [origin, packageName, verification].filter(Boolean).join(" · ");
  const action =
    consent.intent.kind === "install"
      ? props.busy
        ? t("pluginsPage.installing")
        : t("pluginsPage.installNamed", { name })
      : props.busy
        ? t("pluginsPage.working")
        : t("pluginConsent.enableNamed", { name });
  return html`
    <openclaw-modal-dialog
      label=${name}
      style="--openclaw-modal-width: min(560px, calc(100vw - 32px));"
      @modal-cancel=${props.onCancel}
    >
      <section class="plugins-consent" data-plugin-consent=${consent.intent.kind}>
        <header class="plugins-consent__header">
          ${renderArtTile(slug, name, props.iconUrl)}
          <div>
            <div class="plugins-detail__title">
              <h2>${name}</h2>
              ${version ? html`<span class="plugins-version">${`v${version}`}</span>` : nothing}
            </div>
            ${meta ? html`<p class="plugins-consent__description">${meta}</p>` : nothing}
          </div>
        </header>
        ${props.loading
          ? html`<p class="plugins-consent__hint" role="status">${t("pluginConsent.loading")}</p>`
          : props.error
            ? html`<div class="plugins-consent__error" role="alert">
                <span>${props.error}</span>
                <button type="button" class="btn btn--sm" @click=${props.onRetry}>
                  ${t("pluginsPage.tryAgain")}
                </button>
              </div>`
            : inspection
              ? html`
                  ${renderProvenance(inspection.source)} ${renderTrust(inspection.trust)}
                  ${details ? renderWidenedCapabilities(details) : nothing}
                  ${renderPluginDeclaredCapabilities(inspection.declared)}
                  ${renderPluginGrants(inspection.grants, plugin?.origin)}
                `
              : html`<p class="plugins-consent__description">${t("pluginConsent.fallback")}</p>`}
        <footer class="plugins-consent__actions">
          <button type="button" class="btn" @click=${props.onCancel}>
            ${t("pluginsPage.cancel")}
          </button>
          <button
            type="button"
            class="btn primary"
            title=${props.mutationBlockedReason ?? ""}
            ?disabled=${!props.canMutate ||
            props.busy ||
            props.loading ||
            Boolean(props.error) ||
            (!inspection && (consent.intent.kind === "enable" || Boolean(details)))}
            @click=${props.onConfirm}
          >
            ${action}
          </button>
        </footer>
      </section>
    </openclaw-modal-dialog>
  `;
}
