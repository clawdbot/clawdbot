import { html, nothing } from "lit";
import type { ToolsGitHubStatusResult } from "../../api/types.ts";
import { handleCopyButton } from "../../components/copy-button.ts";
import {
  renderSettingsRow,
  renderSettingsSecretInput,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import type { GitHubIdentityController } from "./github-identity-controller.ts";

function githubSourceLabel(source: ToolsGitHubStatusResult["effective"]["source"]) {
  switch (source) {
    case "system-configured":
      return t("agentTools.githubSourceSystem");
    case "agent-override":
      return t("agentTools.githubSourceAgent");
    default:
      return t("agentTools.githubSourceDetected");
  }
}

const GITHUB_CREDENTIAL_STATUS = {
  available: { kind: "ok", label: "agentTools.githubStateVerified" },
  unverified: { kind: "warn", label: "agentTools.githubStateUnverified" },
  rate_limited: { kind: "warn", label: "agentTools.githubStateRateLimited" },
  unavailable: { kind: "danger", label: "agentTools.githubStateUnavailable" },
  configured_unavailable: { kind: "danger", label: "agentTools.githubStateConfiguredUnavailable" },
} as const;

function githubEvidenceDetail(status: ToolsGitHubStatusResult["effective"]) {
  switch (status.evidence) {
    case "github-api":
      return t("agentTools.githubEvidenceApi");
    case "rate-limited":
      return t("agentTools.githubEvidenceRateLimited");
    case "unverified":
      return t("agentTools.githubEvidenceUnverified");
    default:
      return undefined;
  }
}

function renderIdentityFacts(
  identity: ToolsGitHubStatusResult["effective"],
  labels: {
    account: string;
    status: string;
    author: string;
    credential: string;
    accessExpiry: string;
    refresh: string;
    scopes: string;
  },
) {
  const credentialStatus = GITHUB_CREDENTIAL_STATUS[identity.credentialState];
  const authorParts = [identity.gitAuthor.name, identity.gitAuthor.email].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return html`
    ${renderSettingsRow({
      title: labels.account,
      description: githubSourceLabel(identity.source),
      control: identity.account
        ? renderSettingsValue(`@${identity.account.login}`, { mono: true })
        : renderSettingsValue(t("agentTools.githubNoAccount")),
    })}
    ${renderSettingsRow({
      title: labels.status,
      description: githubEvidenceDetail(identity),
      control: renderSettingsStatus({
        kind: credentialStatus.kind,
        label: t(credentialStatus.label),
      }),
    })}
    ${renderSettingsRow({
      title: labels.author,
      control: renderSettingsValue(
        authorParts.length > 0 ? authorParts.join(" · ") : t("agentTools.githubAuthorUnset"),
      ),
    })}
    ${renderSettingsRow({
      title: labels.credential,
      control: renderSettingsValue(t(GITHUB_CREDENTIAL_KIND[identity.credentialKind])),
    })}
    ${identity.credentialKind === "managed-oauth"
      ? html`
          ${renderSettingsRow({
            title: labels.accessExpiry,
            control: renderSettingsValue(
              identity.accessExpiresAtMs
                ? formatDateTimeMs(identity.accessExpiresAtMs, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : t("common.na"),
            ),
          })}
          ${renderSettingsRow({
            title: labels.refresh,
            control: renderSettingsValue(t(GITHUB_REFRESH_STATE[identity.refreshState])),
          })}
          ${renderSettingsRow({
            title: labels.scopes,
            control: renderSettingsValue(
              identity.oauthScopes.length ? identity.oauthScopes.join(", ") : t("common.none"),
              { mono: true },
            ),
          })}
        `
      : nothing}
  `;
}

const GITHUB_CREDENTIAL_KIND = {
  native: "agentTools.githubKindNative",
  "managed-pat": "agentTools.githubKindPat",
  "managed-oauth": "agentTools.githubKindOAuth",
} as const;

const GITHUB_REFRESH_STATE = {
  available: "agentTools.githubRefreshAvailable",
  expired: "agentTools.githubRefreshExpired",
  unavailable: "agentTools.githubRefreshUnavailable",
  refreshing: "agentTools.githubRefreshRefreshing",
  failed: "agentTools.githubRefreshFailed",
  not_applicable: "common.na",
} as const;

function renderGitHubAuthorization(controller: GitHubIdentityController) {
  const authorization = controller.authorization;
  if (!controller.connectionReady) {
    return renderSettingsRow({
      title: t("agentTools.githubConnection"),
      control: renderSettingsStatus({ kind: "muted", label: t("agentTools.githubDisconnected") }),
    });
  }
  if (!controller.statusReadable) {
    return renderSettingsRow({
      title: renderSettingsStatus({ kind: "danger", label: t("agentTools.githubAccessRequired") }),
      description: t("agentTools.githubReadRequired"),
    });
  }
  if (!controller.authorizable || !controller.configurable) {
    return renderSettingsRow({
      title: renderSettingsStatus({ kind: "warn", label: t("agentTools.githubAccessRequired") }),
      description: t("agentTools.githubAdminRequired"),
    });
  }
  if (
    authorization.phase === "starting" ||
    (authorization.phase === "cancelling" && !("userCode" in authorization))
  ) {
    return renderSettingsRow({
      title: t("agentTools.githubAuthorization"),
      control: html`
        ${renderSettingsStatus({
          kind: "accent",
          label:
            authorization.phase === "cancelling"
              ? t("agentTools.githubCancelling")
              : t("agentTools.githubStarting"),
        })}
        ${authorization.phase === "starting"
          ? html`<button class="btn btn--sm" @click=${() => void controller.cancelAuthorization()}>
              ${t("common.cancel")}
            </button>`
          : nothing}
      `,
    });
  }
  if (
    authorization.phase === "code" ||
    authorization.phase === "pending" ||
    authorization.phase === "network_error" ||
    authorization.phase === "cancelling" ||
    authorization.phase === "finishing" ||
    authorization.phase === "cancel_error"
  ) {
    if (!("userCode" in authorization)) {
      return nothing;
    }
    const copyLabel = t("agentTools.githubCopyCode");
    const stateLabel =
      authorization.phase === "code"
        ? t("agentTools.githubCodeReady")
        : authorization.phase === "cancelling"
          ? t("agentTools.githubCancelling")
          : authorization.phase === "finishing"
            ? t("agentTools.githubFinishing")
            : authorization.phase === "cancel_error"
              ? t("agentTools.githubCancelFailed")
              : authorization.phase === "network_error"
                ? t("agentTools.githubNetworkRetry")
                : authorization.slowedDown
                  ? t("agentTools.githubSlowDown")
                  : t("agentTools.githubWaiting");
    return html`
      ${renderSettingsRow({
        title: t("agentTools.githubAuthorization"),
        description:
          authorization.phase === "cancel_error"
            ? authorization.message
              ? `${t("agentTools.githubCancelFailedHint")} ${authorization.message}`
              : t("agentTools.githubCancelFailedHint")
            : t("agentTools.githubAuthorizationHint"),
        control: renderSettingsStatus({
          kind:
            authorization.phase === "network_error" || authorization.phase === "cancel_error"
              ? "warn"
              : "accent",
          label: stateLabel,
        }),
      })}
      ${renderSettingsRow({
        title: t("agentTools.githubDeviceCode"),
        description: t("agentTools.githubDeviceCodeHint"),
        control: html`
          <code class="settings-row__value settings-row__value--mono github-device-code"
            >${authorization.userCode}</code
          >
        `,
      })}
      ${renderSettingsRow({
        title: t("agentTools.githubExpires"),
        control: renderSettingsValue(
          formatDateTimeMs(authorization.displayExpiresAtMs, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        ),
      })}
      <div class="settings-row settings-row--actions">
        <div class="settings-row__control">
          <a
            class="btn primary"
            href=${authorization.verificationUri}
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
          >
            ${t("agentTools.githubOpen")}
          </a>
          <button
            type="button"
            class="btn"
            aria-label=${copyLabel}
            @click=${(event: Event) =>
              void handleCopyButton(event, authorization.userCode, copyLabel)}
          >
            <span data-copy-label>${copyLabel}</span>
          </button>
          ${authorization.phase === "cancelling" || authorization.phase === "finishing"
            ? nothing
            : html`<button
                type="button"
                class="btn"
                @click=${() => void controller.cancelAuthorization()}
              >
                ${authorization.phase === "cancel_error"
                  ? t("agentTools.githubRetryCancel")
                  : t("common.cancel")}
              </button>`}
        </div>
      </div>
    `;
  }
  if (controller.patVisible) {
    return nothing;
  }
  if (
    authorization.phase === "access_denied" ||
    authorization.phase === "expired" ||
    authorization.phase === "incorrect_device_code" ||
    authorization.phase === "failed"
  ) {
    const description =
      authorization.phase === "expired"
        ? t("agentTools.githubExpired")
        : authorization.phase === "access_denied"
          ? t("agentTools.githubDenied")
          : authorization.phase === "incorrect_device_code"
            ? t("agentTools.githubIncorrectCode")
            : (authorization.message ?? t("agentTools.githubAuthorizationFailed"));
    return renderSettingsRow({
      title: renderSettingsStatus({
        kind: "danger",
        label: t("agentTools.githubAuthorizationFailed"),
      }),
      description: formatUiExternalText(description),
      control: html`
        <button class="btn primary" @click=${() => void controller.startAuthorization()}>
          ${t("agentTools.githubConnect")}
        </button>
        <button class="btn" @click=${() => controller.showPatFallback()}>
          ${t("agentTools.githubUsePat")}
        </button>
      `,
    });
  }
  return html`
    ${renderSettingsRow({
      title: t("agentTools.githubAuthorization"),
      description: t("agentTools.githubConnectHint"),
      control: html`
        <button class="btn primary" @click=${() => void controller.startAuthorization()}>
          ${t("agentTools.githubConnect")}
        </button>
      `,
    })}
    ${renderSettingsRow({
      title: t("agentTools.githubPatFallback"),
      description: t("agentTools.githubPatFallbackHint"),
      control: html`
        <button class="btn" @click=${() => controller.showPatFallback()}>
          ${t("agentTools.githubUsePat")}
        </button>
      `,
    })}
  `;
}

export function renderGitHubIdentity(controller: GitHubIdentityController) {
  const status = controller.status;
  const draft = controller.draft;
  const disabled = controller.busy || !controller.configurable || controller.authorizationActive;
  const renderAuthorRow = (field: "name" | "email", label: string) =>
    renderSettingsRow({
      title: label,
      control: html`
        <input
          class="settings-input"
          aria-label=${label}
          autocomplete="off"
          .value=${draft[field]}
          ?disabled=${disabled}
          @input=${(event: Event) => {
            if (event.currentTarget instanceof HTMLInputElement) {
              controller.setDraft(field, event.currentTarget.value);
            }
          }}
        />
      `,
    });
  const effective = status?.effective ?? null;
  const selectedIdentity = status?.selected.identity ?? null;
  const selectedDiffers = Boolean(
    effective && selectedIdentity && JSON.stringify(effective) !== JSON.stringify(selectedIdentity),
  );
  const statusRows = !status
    ? renderSettingsRow({
        title: t("agentTools.githubAccount"),
        description: controller.loading ? t("agentTools.githubVerifying") : undefined,
        control: renderSettingsValue(t("agentTools.githubNoAccount")),
      })
    : html`
        ${renderIdentityFacts(status.effective, {
          account: t("agentTools.githubEffectiveAccount"),
          status: t("agentTools.githubEffectiveStatus"),
          author: t("agentTools.githubEffectiveAuthor"),
          credential: t("agentTools.githubEffectiveCredential"),
          accessExpiry: t("agentTools.githubEffectiveAccessExpiry"),
          refresh: t("agentTools.githubEffectiveRefresh"),
          scopes: t("agentTools.githubEffectiveScopes"),
        })}
        ${renderSettingsRow({
          title: t("agentTools.githubSelectedConfiguration", {
            scope:
              controller.scope === "agent"
                ? t("agentTools.githubAgentOverride")
                : t("agentTools.githubSystem"),
          }),
          description: status.selected.configured
            ? t("agentTools.githubConfiguredHere")
            : t("agentTools.githubInheritedHere"),
          control: renderSettingsValue(
            status.selected.configured
              ? t("agentTools.githubSelectedConfigured")
              : t("agentTools.githubSelectedInherited"),
          ),
        })}
        ${selectedDiffers && selectedIdentity
          ? renderIdentityFacts(selectedIdentity, {
              account: t("agentTools.githubSelectedAccount"),
              status: t("agentTools.githubSelectedStatus"),
              author: t("agentTools.githubSelectedAuthor"),
              credential: t("agentTools.githubSelectedCredential"),
              accessExpiry: t("agentTools.githubSelectedAccessExpiry"),
              refresh: t("agentTools.githubSelectedRefresh"),
              scopes: t("agentTools.githubSelectedScopes"),
            })
          : nothing}
      `;
  return renderSettingsSection(
    {
      title: t("agentTools.githubTitle"),
      description: t("agentTools.githubSubtitle"),
      actions: controller.statusReadable
        ? html`<button
            class="btn btn--sm"
            ?disabled=${controller.loading}
            @click=${() => void controller.verify()}
          >
            ${controller.loading ? t("agentTools.githubVerifying") : t("agentTools.githubVerify")}
          </button>`
        : undefined,
    },
    html`
      ${controller.error
        ? renderSettingsRow({
            title: renderSettingsStatus({
              kind: "danger",
              label: t("agentTools.githubErrorTitle"),
            }),
            description: formatUiExternalText(controller.error),
          })
        : nothing}
      ${statusRows}
      ${renderSettingsRow({
        title: t("agentTools.githubScope"),
        description:
          controller.scope === "agent"
            ? t("agentTools.githubScopeAgentDesc")
            : t("agentTools.githubScopeSystemDesc"),
        control: renderSettingsSegmented({
          value: controller.scope,
          options: [
            { value: "system", label: t("agentTools.githubSystem") },
            { value: "agent", label: t("agentTools.githubAgentOverride") },
          ],
          disabled: controller.busy || controller.authorizationActive,
          ariaLabel: t("agentTools.githubScope"),
          onChange: (scope) => controller.selectScope(scope),
        }),
      })}
      ${renderGitHubAuthorization(controller)}
      ${controller.patVisible
        ? html`
            <div class="settings-subrows">
              ${renderSettingsRow({
                title: t("agentTools.githubToken"),
                description: t("agentTools.githubTokenDesc"),
                control: renderSettingsSecretInput({
                  ariaLabel: t("agentTools.githubToken"),
                  value: draft.token,
                  visible: controller.tokenRevealed,
                  disabled,
                  showLabel: t("configForm.revealValue"),
                  hideLabel: t("configForm.hideValue"),
                  toggleLabel: t("agentTools.githubTokenToggle"),
                  onInput: (value) => controller.setDraft("token", value),
                  onToggle: () => controller.toggleTokenVisibility(),
                }),
              })}
              ${renderAuthorRow("name", t("agentTools.githubAuthorName"))}
              ${renderAuthorRow("email", t("agentTools.githubAuthorEmail"))}
              <div class="settings-row settings-row--actions">
                <div class="settings-row__control">
                  <button
                    class="btn"
                    ?disabled=${controller.busy}
                    @click=${() => controller.hidePatFallback()}
                  >
                    ${t("common.cancel")}
                  </button>
                  <button
                    class="btn primary"
                    ?disabled=${disabled}
                    @click=${() => void controller.configure()}
                  >
                    ${controller.busy ? t("common.saving") : t("agentTools.githubConfigure")}
                  </button>
                </div>
              </div>
            </div>
          `
        : nothing}
      <div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">
            ${controller.scope === "agent"
              ? t("agentTools.githubAgentOverride")
              : t("agentTools.githubSystem")}
          </span>
          <span class="settings-row__desc">
            ${controller.scope === "agent"
              ? t("agentTools.githubAgentMutationHint")
              : t("agentTools.githubSystemMutationHint")}
          </span>
        </div>
        <div class="settings-row__control">
          ${status?.selected.configured
            ? html`<button
                class="btn"
                ?disabled=${disabled}
                @click=${() => void controller.inherit()}
              >
                ${controller.scope === "agent"
                  ? t("agentTools.githubUseSystemNewRuns")
                  : t("agentTools.githubUseNativeNewRuns")}
              </button>`
            : nothing}
        </div>
      </div>
      ${renderSettingsRow({
        title: t("agentTools.githubCloudNoteTitle"),
        description: t("agentTools.githubCloudNote"),
      })}
    `,
  );
}
