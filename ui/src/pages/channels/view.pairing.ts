// DM sender access request queue shared by the Channels hub and detail panels.
import { html, nothing } from "lit";
import type { ChannelsPairingAccount, ChannelsPairingRequest } from "../../api/types.ts";
import { renderChannelPicker } from "../../components/channel-picker.ts";
import "../../components/modal-dialog.ts";
import { renderPicker } from "../../components/select-picker.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { renderChannelRefreshAction } from "./view.shared.ts";
import type { ChannelsProps } from "./view.types.ts";

function accountName(account: ChannelsPairingAccount): string {
  return account.accountLabel || account.accountId;
}

function requestAccountName(request: ChannelsPairingRequest): string {
  return request.accountLabel || request.accountId;
}

function formatRequestTime(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? formatRelativeTimestamp(time) : value;
}

function filteredAccounts(props: ChannelsProps): ChannelsPairingAccount[] {
  const accounts = props.pairingSnapshot?.accounts ?? [];
  return props.pairingChannelFilter
    ? accounts.filter((account) => account.channel === props.pairingChannelFilter)
    : accounts;
}

function filteredRequests(props: ChannelsProps): ChannelsPairingRequest[] {
  return (props.pairingSnapshot?.requests ?? []).filter((request) => {
    if (props.pairingChannelFilter && request.channel !== props.pairingChannelFilter) {
      return false;
    }
    if (props.pairingAccountFilter && request.accountId !== props.pairingAccountFilter) {
      return false;
    }
    return true;
  });
}

function renderFilters(props: ChannelsProps) {
  const accounts = props.pairingSnapshot?.accounts ?? [];
  const channels = Array.from(
    new Map(accounts.map((account) => [account.channel, account.channelLabel])).entries(),
  ).toSorted((left, right) => left[1].localeCompare(right[1]));
  const accountsForChannel = filteredAccounts(props);
  return html`
    <div class="channels-pairing-filters">
      <label>
        <span>${t("channels.pairing.channelFilter")}</span>
        ${renderChannelPicker({
          label: t("channels.pairing.channelFilter"),
          value: props.pairingChannelFilter ?? "",
          options: [
            { value: "", label: t("channels.pairing.allChannels"), kind: "neutral" },
            ...channels.map(([value, label]) => ({ value, label })),
          ],
          onChange: (value) => props.onPairingFilterChange(value || null, null),
        })}
      </label>
      <label>
        <span>${t("channels.pairing.accountFilter")}</span>
        ${renderPicker({
          label: t("channels.pairing.accountFilter"),
          value: props.pairingAccountFilter ?? "",
          options: [
            { value: "", label: t("channels.pairing.allAccounts") },
            ...accountsForChannel.map((account) => ({
              value: account.accountId,
              label: accountName(account),
            })),
          ],
          disabled: !props.pairingChannelFilter,
          onChange: (value) =>
            props.onPairingFilterChange(props.pairingChannelFilter, value || null),
        })}
      </label>
    </div>
  `;
}

function renderRequest(request: ChannelsPairingRequest, props: ChannelsProps) {
  const busy = Boolean(props.pairingBusyRequestId);
  const thisRequestBusy = props.pairingBusyRequestId === request.requestId;
  const metadata = Object.entries(request.metadata ?? {});
  return html`
    <div class="settings-row settings-row--stacked channels-pairing-request">
      <div class="channels-pairing-request__main">
        <div class="settings-row__text">
          <span class="settings-row__title">${request.senderId}</span>
          <span class="settings-row__desc">
            ${request.senderLabel} · ${request.channelLabel} · ${requestAccountName(request)}
            (${request.accountId})
          </span>
          <span class="settings-row__desc">
            ${t("channels.pairing.requested", { ago: formatRequestTime(request.createdAt) })} ·
            ${t("channels.pairing.expires", { ago: formatRequestTime(request.expiresAt) })}
          </span>
        </div>
        <div class="settings-row__control channels-pairing-request__actions">
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${busy || !props.canManagePairing}
            aria-label=${t("channels.pairing.approveAria", {
              sender: request.senderId,
              channel: request.channelLabel,
              account: requestAccountName(request),
            })}
            @click=${() => props.onPairingApprove(request)}
          >
            ${thisRequestBusy ? t("common.loading") : t("channels.pairing.approve")}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${busy || !props.canManagePairing}
            aria-label=${t("channels.pairing.dismissAria", {
              sender: request.senderId,
              channel: request.channelLabel,
              account: requestAccountName(request),
            })}
            @click=${() => props.onPairingDismiss(request)}
          >
            ${t("channels.pairing.dismiss")}
          </button>
        </div>
      </div>
      ${
        metadata.length > 0
          ? html`
              <details class="channels-pairing-request__details">
                <summary>${t("channels.pairing.senderDetails")}</summary>
                <dl class="settings-kv">
                  ${metadata.map(
                    ([key, value]) =>
                      html`<dt>${key}</dt>
                        <dd>${value}</dd>`,
                  )}
                </dl>
              </details>
            `
          : nothing
      }
    </div>
  `;
}

export function renderChannelPairingQueue(props: ChannelsProps) {
  const snapshot = props.canManagePairing ? props.pairingSnapshot : null;
  const accounts = snapshot?.accounts ?? [];
  const requests = props.canManagePairing ? filteredRequests(props) : [];
  const hasFilter = Boolean(props.pairingChannelFilter || props.pairingAccountFilter);
  const count = snapshot?.requests.length ?? 0;
  return html`
    <div id="channels-pairing-requests">
      ${renderSettingsSection(
        {
          title: t("channels.pairing.title"),
          description: t("channels.pairing.subtitle"),
          ...(count > 0 ? { count } : {}),
          actions: renderChannelRefreshAction({
            updatedAt: props.canManagePairing ? props.pairingLastSuccessAt : null,
            disabled: props.pairingLoading || !props.canManagePairing,
            onRefresh: props.onPairingRefresh,
          }),
        },
        !props.canManagePairing
          ? html`
              <div class="settings-row channels-pairing-feedback">
                ${renderSettingsStatus({
                  kind: "warn",
                  label: t("channels.pairing.missingPermission"),
                })}
              </div>
            `
          : html`
              ${
                props.pairingError
                  ? html`
                      <div class="settings-row channels-pairing-feedback" role="alert">
                        ${renderSettingsStatus({ kind: "danger", label: props.pairingError })}
                      </div>
                    `
                  : nothing
              }
              ${
                props.pairingNotice
                  ? html`
                      <div class="settings-row channels-pairing-feedback" role="status">
                        ${renderSettingsStatus({ kind: "ok", label: props.pairingNotice })}
                      </div>
                    `
                  : nothing
              }
              ${snapshot ? renderFilters(props) : nothing}
              ${
                props.pairingLoading && !snapshot
                  ? renderSettingsLoadingSkeleton({ rows: 2 })
                  : accounts.length === 0
                    ? renderSettingsEmpty(t("channels.pairing.noAccounts"))
                    : requests.length === 0
                      ? renderSettingsEmpty(
                          hasFilter
                            ? t("channels.pairing.noFilteredRequests")
                            : t("channels.pairing.noRequests"),
                        )
                      : requests.map((request) => renderRequest(request, props))
              }
              ${
                snapshot
                  ? html`
                      <div class="channels-pairing-help">
                        ${t("channels.pairing.limits", {
                          count: String(snapshot.limits.pendingPerAccount),
                          minutes: String(Math.round(snapshot.limits.ttlMs / 60_000)),
                        })}
                      </div>
                    `
                  : nothing
              }
            `,
      )}
    </div>
  `;
}

export function renderChannelPairingDetail(channelId: string, props: ChannelsProps) {
  if (!props.canManagePairing) {
    return nothing;
  }
  const accounts = (props.pairingSnapshot?.accounts ?? []).filter(
    (account) => account.channel === channelId,
  );
  if (accounts.length === 0) {
    return nothing;
  }
  const requests = props.pairingSnapshot?.requests ?? [];
  return renderSettingsSection(
    {
      title: t("channels.pairing.detailTitle"),
      description: t("channels.pairing.detailSubtitle"),
    },
    accounts.map((account) => {
      const pending = requests.filter(
        (request) => request.channel === account.channel && request.accountId === account.accountId,
      ).length;
      return html`
        <div class="settings-row">
          <div class="settings-row__text">
            <span class="settings-row__title">${accountName(account)}</span>
            <span class="settings-row__desc">${account.accountId}</span>
          </div>
          <div class="settings-row__control">
            ${renderSettingsStatus({
              kind: pending > 0 ? "warn" : "muted",
              label:
                pending > 0
                  ? t("channels.pairing.pendingCount", { count: String(pending) })
                  : t("channels.pairing.noPending"),
            })}
            <button
              type="button"
              class="btn btn--sm"
              @click=${() => props.onPairingReviewAccount(account.channel, account.accountId)}
            >
              ${t("channels.pairing.review")}
            </button>
          </div>
        </div>
      `;
    }),
  );
}

export function renderChannelPairingPrompt(props: ChannelsProps) {
  const prompt = props.pairingPrompt;
  if (!prompt || !props.canManagePairing) {
    return nothing;
  }
  const request = prompt.request;
  const busy = props.pairingBusyRequestId === request.requestId;
  const approving = prompt.kind === "approve";
  const ownerMissing = props.pairingSnapshot?.commandOwnerConfigured === false;
  const dialogTitle = approving
    ? t("channels.pairing.approveDialogTitle")
    : t("channels.pairing.dismissDialogTitle");
  return html`
    <openclaw-modal-dialog label=${dialogTitle} @modal-cancel=${props.onPairingPromptCancel}>
      <div class="channels-pairing-dialog">
        <div class="settings-row__title">${dialogTitle}</div>
        <div class="settings-row__desc">
          ${request.senderId} · ${request.channelLabel} · ${requestAccountName(request)}
          (${request.accountId})
        </div>
        <div class="callout ${approving ? "info" : "warn"}">
          ${
            approving
              ? t("channels.pairing.approveExplanation")
              : t("channels.pairing.dismissExplanation")
          }
        </div>
        ${
          props.pairingError
            ? html`<div class="callout danger" role="alert">${props.pairingError}</div>`
            : nothing
        }
        ${
          approving && request.notifySupported
            ? html`
                <label class="channels-pairing-dialog__option">
                  <input
                    type="checkbox"
                    .checked=${prompt.notify}
                    @change=${(event: Event) =>
                      props.onPairingPromptChange({
                        notify:
                          event.currentTarget instanceof HTMLInputElement
                            ? event.currentTarget.checked
                            : false,
                      })}
                  />
                  <span>${t("channels.pairing.notifyRequester")}</span>
                </label>
              `
            : nothing
        }
        ${
          approving && ownerMissing && props.canAdmin
            ? html`
                <label class="channels-pairing-dialog__option">
                  <input
                    type="checkbox"
                    .checked=${prompt.bootstrapCommandOwner}
                    @change=${(event: Event) =>
                      props.onPairingPromptChange({
                        bootstrapCommandOwner:
                          event.currentTarget instanceof HTMLInputElement
                            ? event.currentTarget.checked
                            : false,
                      })}
                  />
                  <span>${t("channels.pairing.makeCommandOwner")}</span>
                </label>
                <div class="settings-row__desc">${t("channels.pairing.commandOwnerHelp")}</div>
              `
            : nothing
        }
        ${
          approving && ownerMissing && !props.canAdmin
            ? html`<div class="callout warn">${t("channels.pairing.commandOwnerNeedsAdmin")}</div>`
            : nothing
        }
        <div class="channels-pairing-dialog__actions">
          <button
            type="button"
            class=${approving ? "btn primary" : "btn danger"}
            ?disabled=${busy}
            @click=${props.onPairingPromptConfirm}
          >
            ${approving ? t("channels.pairing.approve") : t("channels.pairing.dismiss")}
          </button>
          <button type="button" class="btn" ?disabled=${busy} @click=${props.onPairingPromptCancel}>
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
