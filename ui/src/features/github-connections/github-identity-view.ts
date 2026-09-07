import { html, nothing, type TemplateResult } from "lit";
import type { GitHubIdentityFacts } from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { handleCopyButton } from "../../components/copy-button.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsRow,
  renderSettingsSecretInput,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import type { GitHubIdentityController } from "./github-identity-controller.ts";

const GITHUB_CREDENTIAL_STATUS = {
  available: { kind: "ok", label: "agentTools.githubStateVerified" },
  unverified: { kind: "warn", label: "agentTools.githubStateUnverified" },
  rate_limited: { kind: "warn", label: "agentTools.githubStateRateLimited" },
  unavailable: { kind: "danger", label: "agentTools.githubStateUnavailable" },
  configured_unavailable: { kind: "danger", label: "agentTools.githubStateConfiguredUnavailable" },
} as const;

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

const GITHUB_AUTHORIZATION_LABEL = {
  code: "agentTools.githubCodeReady",
  pending: "agentTools.githubWaiting",
  cancelling: "agentTools.githubCancelling",
  finishing: "agentTools.githubFinishing",
  cancel_error: "agentTools.githubCancelFailed",
  network_error: "agentTools.githubNetworkRetry",
} as const;

export function renderGitHubUnloadedStatus(
  request: Pick<GitHubIdentityController, "loading" | "error">,
) {
  return renderSettingsStatus({
    kind: request.error ? "warn" : "muted",
    label: request.loading
      ? t("githubConnections.checking")
      : request.error
        ? t("githubConnections.statusUnavailable")
        : t("githubConnections.notLoaded"),
  });
}

export function renderGitHubHealth(
  identity: GitHubIdentityFacts | null,
  request: Pick<GitHubIdentityController, "loading" | "error">,
) {
  if (!identity) {
    return renderGitHubUnloadedStatus(request);
  }
  const status = GITHUB_CREDENTIAL_STATUS[identity.credentialState];
  return renderSettingsStatus({
    kind: status.kind,
    label: t(status.label),
  });
}

export function renderGitHubDetails(identity: GitHubIdentityFacts | null) {
  if (!identity) {
    return nothing;
  }
  const author = [identity.gitAuthor.name, identity.gitAuthor.email].filter(Boolean).join(" · ");
  return html`<details class="settings-row settings-row--stacked">
    <summary class="settings-row__title">${t("githubConnections.details")}</summary>
    <div class="settings-subrows">
      ${renderSettingsRow({
        title: t("agentTools.githubEffectiveAuthor"),
        control: renderSettingsValue(author || t("agentTools.githubAuthorUnset")),
      })}
      ${renderSettingsRow({
        title: t("agentTools.githubEffectiveCredential"),
        control: renderSettingsValue(t(GITHUB_CREDENTIAL_KIND[identity.credentialKind])),
      })}
      ${
        identity.credentialKind === "managed-oauth"
          ? html`
              ${renderSettingsRow({
                title: t("agentTools.githubEffectiveAccessExpiry"),
                control: renderSettingsValue(
                  identity.accessExpiresAtMs
                    ? formatDateTimeMs(identity.accessExpiresAtMs)
                    : t("common.na"),
                ),
              })}
              ${renderSettingsRow({
                title: t("agentTools.githubEffectiveRefresh"),
                control: renderSettingsValue(t(GITHUB_REFRESH_STATE[identity.refreshState])),
              })}
              ${renderSettingsRow({
                title: t("agentTools.githubEffectiveScopes"),
                control: renderSettingsValue(identity.oauthScopes.join(", ") || t("common.none")),
              })}
            `
          : nothing
      }
    </div>
  </details>`;
}

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
  if (!controller.authorizable) {
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
        ${
          authorization.phase === "starting"
            ? html`<button
                class="btn btn--sm"
                @click=${() => void controller.cancelAuthorization()}
              >
                ${t("common.cancel")}
              </button>`
            : nothing
        }
      `,
    });
  }
  if ("userCode" in authorization) {
    const copyLabel = t("agentTools.githubCopyCode");
    const stateLabel = t(
      authorization.phase === "pending" && authorization.slowedDown
        ? "agentTools.githubSlowDown"
        : GITHUB_AUTHORIZATION_LABEL[authorization.phase],
    );
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
          <button
            type="button"
            class="btn btn--sm"
            @click=${(event: Event) =>
              void handleCopyButton(event, authorization.userCode, copyLabel)}
          >
            ${icons.copy}
            <span data-copy-label>${copyLabel}</span>
          </button>
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
          ${
            authorization.phase === "cancelling" || authorization.phase === "finishing"
              ? nothing
              : html`<button
                  type="button"
                  class="btn"
                  @click=${() => void controller.cancelAuthorization()}
                >
                  ${
                    authorization.phase === "cancel_error"
                      ? t("agentTools.githubRetryCancel")
                      : t("common.cancel")
                  }
                </button>`
          }
        </div>
      </div>
    `;
  }
  if (controller.patVisible) {
    return nothing;
  }
  const authorizeButton = html`<button
    class="btn primary"
    @click=${() => void controller.startAuthorization()}
  >
    ${t("githubConnections.continue")}
  </button>`;
  const patButton =
    controller.scope !== "personal"
      ? html`<button class="btn" @click=${() => controller.showPatFallback()}>
          ${t("agentTools.githubUsePat")}
        </button>`
      : nothing;
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
      control: html`${authorizeButton}${patButton}`,
    });
  }
  return html`
    ${renderSettingsRow({
      title: t("agentTools.githubAuthorization"),
      description: t("agentTools.githubConnectHint"),
      control: authorizeButton,
    })}
    ${
      controller.scope !== "personal"
        ? renderSettingsRow({
            title: t("agentTools.githubPatFallback"),
            description: t("agentTools.githubPatFallbackHint"),
            control: patButton,
          })
        : nothing
    }
  `;
}

export function renderGitHubConnectionError(error: string | null, control?: TemplateResult) {
  return error
    ? renderSettingsRow({
        title: t("agentTools.githubErrorTitle"),
        description: html`<span role="alert">${formatUiExternalText(error)}</span>`,
        control,
      })
    : nothing;
}

export function renderGitHubConnectionSetup(controller: GitHubIdentityController) {
  const draft = controller.draft;
  const disabled = controller.busy || !controller.configurable || controller.authorizationActive;
  const renderAuthorRow = (field: "name" | "email", label: string) =>
    renderSettingsRow({
      title: label,
      control: html` <input
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
      />`,
    });
  return html`
    ${renderGitHubAuthorization(controller)}
    ${
      controller.patVisible
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
        : nothing
    }
  `;
}

export function renderGitHubIdentity(
  controller: GitHubIdentityController,
  onOpenConnections: () => void,
) {
  const identity = controller.status?.effective ?? null;
  return renderSettingsSection(
    {
      title: t("githubConnections.agentTitle"),
      actions: controller.statusReadable
        ? html`<button
            class="btn btn--sm"
            ?disabled=${controller.loading || controller.busy || controller.authorizationActive}
            @click=${() => void controller.verify()}
          >
            ${t("agentTools.githubVerify")}
          </button>`
        : undefined,
    },
    html`
      ${renderSettingsRow({
        title: identity?.account ? `@${identity.account.login}` : t("agentTools.githubNoAccount"),
        description:
          identity?.source === "agent-override"
            ? t("githubConnections.agentOverride")
            : t("githubConnections.system"),
        control: html`${renderGitHubHealth(identity, controller)}<button
            class="btn btn--sm"
            @click=${onOpenConnections}
          >
            ${t("githubConnections.manageCommon")}
          </button>`,
      })}
      ${renderGitHubConnectionError(controller.error)}
      ${
        controller.configurable
          ? html`<details class="settings-row settings-row--stacked">
              <summary class="settings-row__title">
                ${t("githubConnections.advancedOverride")}
              </summary>
              <div class="settings-subrows">
                ${renderSettingsRow({
                  title: t("githubConnections.agentOverride"),
                  description: controller.status?.selected.configured
                    ? t("agentTools.githubConfiguredHere")
                    : t("agentTools.githubInheritedHere"),
                })}
                ${renderGitHubConnectionSetup(controller)}
                ${
                  controller.status?.selected.configured
                    ? renderSettingsRow({
                        title: t("agentTools.githubUseSystemNewRuns"),
                        description: t("agentTools.githubAgentMutationHint"),
                        control: html`<button
                          class="btn"
                          ?disabled=${controller.busy || controller.authorizationActive}
                          @click=${() => void controller.inherit()}
                        >
                          ${t("agentTools.githubUseSystemNewRuns")}
                        </button>`,
                      })
                    : nothing
                }
              </div>
            </details>`
          : nothing
      }
      ${renderGitHubDetails(identity)}
    `,
  );
}
