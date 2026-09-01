// Curated Updates settings presentation. The existing update config remains
// the source of authored policy; the Gateway schedule DTO owns runtime status.
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import type { UpdateAvailable, UpdateScheduleState } from "../../api/types.ts";
import type {
  ApplicationStatusBanner,
  RecordedUpdateAttempt,
} from "../../app/update-overlay-helpers.ts";
import {
  formatUpdateCampaignLabel,
  formatUpdateTargetLabel,
} from "../../app/update-overlay-helpers.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatDateTimeMs, formatTimeAgo } from "../../lib/format.ts";

registerSettingsEnglish();

type UpdatesChannel = "stable" | "beta" | "dev" | "extended-stable";

type UpdatesViewProps = {
  configObject: Record<string, unknown>;
  gatewayVersion: string | null;
  controlUiCommit: string | null;
  controlUiCommitAt: string | null;
  controlUiBuiltAt: string | null;
  schedule: UpdateScheduleState | null;
  heldUpdateCampaignId: string | null;
  updateAvailable: UpdateAvailable | null;
  statusBanner: ApplicationStatusBanner | null;
  recordedAttempt: RecordedUpdateAttempt | null;
  configBusy: boolean;
  canAdmin: boolean;
  canUpdate: boolean;
  canCheckStatus: boolean;
  canHoldUpdate: boolean;
  updateBusy: boolean;
  nowMs?: number;
  onChannelChange: (channel: UpdatesChannel) => void;
  onUpdateChecksChange: (enabled: boolean) => void;
  onAutomaticUpdatesChange: (enabled: boolean) => void;
  onUpdateNow: () => void;
  onHoldUpdate: () => Promise<boolean>;
  onCheckStatus: () => Promise<void>;
};

function formatAttemptIdentity(version: string | null, sha: string | null): string {
  return version ? `v${version}` : sha ? sha.slice(0, 12) : t("common.unknown");
}

function renderRecordedAttempt(props: UpdatesViewProps) {
  const attempt = props.recordedAttempt;
  if (!attempt && !props.statusBanner) {
    return nothing;
  }
  const canRetry = props.canUpdate && !props.updateBusy;
  return renderSettingsSection({ title: t("updates.page.latestAttempt") }, [
    attempt
      ? renderSettingsRow({
          title: t("updates.page.attemptedAt"),
          control: renderTimestamp(attempt.timestampMs, props.nowMs),
        })
      : nothing,
    attempt
      ? renderSettingsRow({
          title: t("updates.page.beforeUpdate"),
          control: renderSettingsValue(
            formatAttemptIdentity(attempt.beforeVersion, attempt.beforeSha),
            { mono: true },
          ),
        })
      : nothing,
    attempt
      ? renderSettingsRow({
          title: t("updates.page.afterAttempt"),
          control: renderSettingsValue(
            formatAttemptIdentity(attempt.afterVersion, attempt.afterSha),
            { mono: true },
          ),
        })
      : nothing,
    attempt?.installKind
      ? renderSettingsRow({
          title: t("updates.page.attemptInstallKind"),
          control: renderSettingsValue(attempt.installKind),
        })
      : nothing,
    attempt
      ? renderSettingsRow({
          title: t("updates.page.attemptReason"),
          control: renderSettingsValue(html`<code>${attempt.reason}</code>`, { mono: true }),
        })
      : nothing,
    attempt?.failure
      ? renderSettingsRow({
          title: t("updates.page.failedStep"),
          stacked: true,
          control: html`<details class="updates-attempt-details">
            <summary>${t("updates.page.viewDetails")}</summary>
            <div><code>${attempt.failure.step}</code></div>
            <pre>${attempt.failure.detail}</pre>
          </details>`,
        })
      : nothing,
    renderSettingsRow({
      title: t("updates.page.recoveryActions"),
      control: html`<div class="updates-status-control">
        <button
          class="btn btn--sm"
          type="button"
          title=${props.canCheckStatus ? "" : t("updates.adminRequired")}
          ?disabled=${!props.canCheckStatus || props.updateBusy}
          @click=${() => void props.onCheckStatus()}
        >
          ${t("updates.page.checkStatus")}
        </button>
        <button
          class="btn btn--sm primary"
          type="button"
          title=${canRetry ? "" : t("updates.adminRequired")}
          ?disabled=${!canRetry}
          @click=${props.onUpdateNow}
        >
          ${t("updates.page.retryUpdate")}
        </button>
      </div>`,
    }),
    renderSettingsRow({
      title: t("updates.page.cliFallback"),
      stacked: true,
      control: html`<details class="updates-attempt-details">
        <summary>${t("updates.page.showCliFallback")}</summary>
        <pre><code>openclaw update status --json
openclaw update</code></pre>
      </details>`,
    }),
  ]);
}

function readUpdatesSettings(
  configObject: Record<string, unknown>,
  schedule: UpdateScheduleState | null,
): { channel: UpdatesChannel; autoEnabled: boolean; extendedStableAuthored: boolean } {
  const update = asConfigRecord(configObject.update);
  const auto = asConfigRecord(update?.auto);
  const authoredChannel = update?.channel;
  const extendedStableAuthored = authoredChannel === "extended-stable";
  const channel =
    authoredChannel === "stable" ||
    authoredChannel === "beta" ||
    authoredChannel === "dev" ||
    extendedStableAuthored
      ? authoredChannel
      : schedule?.channel === "beta" || schedule?.channel === "dev"
        ? schedule.channel
        : "stable";
  return {
    channel,
    autoEnabled:
      typeof auto?.enabled === "boolean" ? auto.enabled : (schedule?.autoEnabled ?? false),
    extendedStableAuthored,
  };
}

function parseTimestampMs(value: string | null): number | null {
  return parseDateStringTimestampMs(value) ?? null;
}

function renderTimestamp(timestampMs: number, nowMs = Date.now()) {
  const relative = formatTimeAgo(Math.max(0, nowMs - timestampMs));
  return renderSettingsValue(
    html`<time datetime=${new Date(timestampMs).toISOString()} title=${relative}
      >${formatDateTimeMs(timestampMs, { dateStyle: "medium", timeStyle: "short" })}
      <span class="muted">· ${relative}</span></time
    >`,
  );
}

function renderBuildFacts(props: UpdatesViewProps) {
  const installKind = props.schedule?.install?.kind;
  const git = props.schedule?.install?.git;
  const builtAtMs = parseTimestampMs(props.controlUiBuiltAt);
  const commitAtMs = git?.commitAtMs ?? parseTimestampMs(props.controlUiCommitAt);
  return renderSettingsSection({ title: t("updates.page.buildTitle") }, [
    renderSettingsRow({
      title: t("updates.page.gatewayVersion"),
      control: renderSettingsValue(
        props.gatewayVersion
          ? html`<code dir="ltr" title=${props.gatewayVersion}>${props.gatewayVersion}</code>`
          : t("common.na"),
        { mono: true },
      ),
    }),
    renderSettingsRow({
      title: t("updates.page.controlUiCommit"),
      control: renderSettingsValue(
        props.controlUiCommit
          ? html`<code dir="ltr" title=${props.controlUiCommit}
              >${props.controlUiCommit.slice(0, 12)}</code
            >`
          : t("common.na"),
        { mono: true },
      ),
    }),
    builtAtMs === null
      ? nothing
      : renderSettingsRow({
          title: t("updates.page.builtAt"),
          control: renderTimestamp(builtAtMs, props.nowMs),
        }),
    installKind === "git"
      ? renderSettingsRow({
          title: t("updates.page.installedAt"),
          control:
            git?.installedAtMs === undefined
              ? renderSettingsValue(t("updates.page.installedAtUnknown"))
              : renderTimestamp(git.installedAtMs, props.nowMs),
        })
      : nothing,
    commitAtMs === null
      ? nothing
      : renderSettingsRow({
          title: t("updates.page.lastCommitAt"),
          control: renderTimestamp(commitAtMs, props.nowMs),
        }),
    installKind
      ? renderSettingsRow({
          title: t("updates.page.installKind"),
          control: renderSettingsValue(t(`updates.installKind.${installKind}`)),
        })
      : nothing,
  ]);
}

function renderScheduleStatus(props: UpdatesViewProps): TemplateResult {
  const campaign = props.schedule?.campaign;
  const campaignLabel = formatUpdateCampaignLabel(props.schedule, props.nowMs);
  const target = formatUpdateTargetLabel(props.schedule, props.updateAvailable);
  let kind: Parameters<typeof renderSettingsStatus>[0]["kind"] = "muted";
  let label: string;
  if (campaignLabel) {
    kind = campaign?.state === "waiting-for-idle" ? "warn" : "accent";
    label = campaignLabel;
  } else if (props.statusBanner) {
    kind =
      props.statusBanner.tone === "danger"
        ? "danger"
        : props.statusBanner.tone === "warn"
          ? "warn"
          : "accent";
    label = props.statusBanner.text;
  } else if (props.schedule?.install?.kind === "git") {
    const git = props.schedule.install.git;
    if (!git) {
      label = t("updates.page.statusUnavailable");
    } else if (git.status === "current") {
      kind = "ok";
      label = t("updates.page.upToDate");
    } else if (git.status === "behind") {
      kind = "accent";
      const lag = t(
        git.commitsBehind === 1 ? "updates.target.commitBehind" : "updates.target.commitsBehind",
        { count: String(git.commitsBehind) },
      );
      label = t("updates.page.available", { target: lag });
    } else if (git.status === "ahead") {
      label = t(
        git.commitsAhead === 1 ? "updates.page.gitCommitAhead" : "updates.page.gitCommitsAhead",
        { count: String(git.commitsAhead) },
      );
    } else if (git.status === "diverged") {
      kind = "warn";
      label = t("updates.page.gitDiverged", {
        ahead: String(git.commitsAhead),
        behind: String(git.commitsBehind),
      });
    } else {
      kind = "warn";
      label =
        git.reason === "fetch-failed"
          ? t("updates.page.gitFetchFailed")
          : git.reason === "no-upstream"
            ? t("updates.page.gitNoUpstream")
            : t("updates.page.gitComparisonFailed");
    }
  } else if (target) {
    kind = "accent";
    label = t("updates.page.available", { target });
  } else if (props.schedule?.install?.kind === "package") {
    kind = "ok";
    label = t("updates.page.upToDate");
  } else {
    label = t("updates.page.statusUnavailable");
  }
  const countdown = campaign?.state === "waiting-for-idle" || campaign?.state === "countdown";
  return html`<span role=${countdown ? "timer" : nothing} aria-live=${countdown ? "off" : nothing}
    >${renderSettingsStatus({ kind, label, dot: false })}</span
  >`;
}

function readGitCommits(props: UpdatesViewProps) {
  const update = props.updateAvailable;
  const gitUpdate = props.schedule?.target?.kind === "git" || Boolean(update?.currentSha);
  const comparedBehind = props.schedule?.install?.git;
  if (
    comparedBehind &&
    comparedBehind.status !== "behind" &&
    comparedBehind.status !== "diverged"
  ) {
    return [];
  }
  const comparedBehindCount =
    comparedBehind?.status === "behind" || comparedBehind?.status === "diverged"
      ? comparedBehind.commitsBehind
      : undefined;
  const commitsMatch =
    comparedBehindCount === undefined || comparedBehindCount === update?.commitsBehind;
  return gitUpdate && commitsMatch ? (update?.commits ?? []) : [];
}

function renderCommitList(props: UpdatesViewProps) {
  const commits = readGitCommits(props);
  if (commits.length === 0) {
    return nothing;
  }
  return renderSettingsRow({
    title: t("updates.page.commits"),
    stacked: true,
    control: html`
      <div class="updates-commit-list" role="list" aria-label=${t("updates.page.commits")}>
        ${commits.map(
          (commit) => html`
            <div class="updates-commit-list__row" role="listitem">
              <code title=${commit.sha}>${commit.sha}</code>
              <span>${commit.subject}</span>
            </div>
          `,
        )}
      </div>
    `,
  });
}

export function renderUpdates(props: UpdatesViewProps): TemplateResult {
  const settings = readUpdatesSettings(props.configObject, props.schedule);
  const channelOptions: Array<{ value: UpdatesChannel; label: string }> = [
    { value: "stable", label: t("updates.channel.stable") },
    { value: "beta", label: t("updates.channel.beta") },
    { value: "dev", label: t("updates.channel.dev") },
  ];
  if (settings.extendedStableAuthored) {
    channelOptions.push({
      value: "extended-stable",
      label: t("updates.channel.extendedStable"),
    });
  }
  const automaticUpdatesSupported = settings.channel !== "extended-stable";
  const checksDisabled = asConfigRecord(props.configObject.update)?.checkOnStart === false;
  const devPackageInstall =
    settings.channel === "dev" && props.schedule?.install?.kind === "package";
  const campaign = props.schedule?.campaign;
  const holdActive =
    campaign?.holdUntilMs !== undefined && campaign.holdUntilMs > (props.nowMs ?? Date.now());
  const showHold = Boolean(
    campaign &&
    campaign.state !== "applying" &&
    props.canUpdate &&
    props.canHoldUpdate &&
    !holdActive &&
    props.heldUpdateCampaignId !== campaign.id,
  );
  const policyRows = [
    renderSettingsRow({
      title: t("updates.page.channel"),
      description: t("updates.page.channelDescription"),
      stacked: true,
      control: renderSettingsSegmented({
        value: settings.channel,
        options: channelOptions,
        ariaLabel: t("updates.page.channel"),
        disabled: props.configBusy,
        onChange: props.onChannelChange,
      }),
    }),
    renderSettingsToggleRow({
      title: t("updates.page.checkForUpdates"),
      description: t("updates.page.checkForUpdatesDescription"),
      checked: !checksDisabled,
      disabled: props.configBusy,
      onChange: props.onUpdateChecksChange,
    }),
    renderSettingsToggleRow({
      title: t("updates.page.automaticUpdates"),
      description: !automaticUpdatesSupported
        ? t("updates.page.extendedStableAutomaticHint")
        : devPackageInstall
          ? t("updates.page.devPackageAutomaticHint")
          : checksDisabled
            ? t("updates.page.checksDisabledAutomaticHint")
            : t("updates.page.automaticUpdatesDescription"),
      checked: automaticUpdatesSupported && settings.autoEnabled,
      disabled:
        props.configBusy || checksDisabled || !automaticUpdatesSupported || devPackageInstall,
      onChange: props.onAutomaticUpdatesChange,
    }),
  ];
  const updateButtonTitle = !props.canAdmin ? t("updates.adminRequired") : "";
  return html`
    <div id="config-section-update">
      ${renderSettingsPage([
        !props.canAdmin
          ? html`<div class="callout warning" role="note">${t("updates.adminRequired")}</div>`
          : nothing,
        renderBuildFacts(props),
        renderRecordedAttempt(props),
        renderSettingsSection({ title: t("updates.page.policyTitle") }, policyRows),
        renderSettingsSection({ title: t("updates.page.statusTitle") }, [
          renderSettingsRow({
            title: t("updates.page.scheduleStatus"),
            control: html`
              <div class="updates-status-control">
                ${renderScheduleStatus(props)}
                ${showHold
                  ? html`
                      <button
                        type="button"
                        class="btn btn--sm"
                        ?disabled=${props.updateBusy}
                        @click=${() => void props.onHoldUpdate()}
                      >
                        ${t("updates.holdOneHour")}
                      </button>
                    `
                  : nothing}
              </div>
            `,
          }),
          renderCommitList(props),
          renderSettingsRow({
            title: t("updates.page.updateNow"),
            description: t("updates.page.updateNowDescription"),
            control: html`
              <button
                type="button"
                class="btn primary"
                title=${updateButtonTitle}
                ?disabled=${props.updateBusy || !props.canUpdate}
                @click=${props.onUpdateNow}
              >
                ${icons.download}
                ${props.updateBusy ? t("chat.updating") : t("updates.page.updateNow")}
              </button>
            `,
          }),
        ]),
        html`<p class="settings-page__hint">
          <a href="https://docs.openclaw.ai/install/update-troubleshooting" target="_blank"
            >${t("updates.page.troubleshoot")}</a
          >
        </p>`,
      ])}
    </div>
  `;
}
