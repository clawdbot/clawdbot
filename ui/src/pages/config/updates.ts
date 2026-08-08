// Curated Updates settings presentation. The existing update config remains
// the source of authored policy; the Gateway schedule DTO owns runtime status.
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import type { UpdateAvailable, UpdateScheduleState } from "../../api/types.ts";
import type { ApplicationStatusBanner } from "../../app/update-overlay-helpers.ts";
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

type UpdatesChannel = "stable" | "beta" | "dev" | "extended-stable";

type UpdatesViewProps = {
  configObject: Record<string, unknown>;
  gatewayVersion: string | null;
  controlUiCommit: string | null;
  schedule: UpdateScheduleState | null;
  heldUpdateCampaignId: string | null;
  updateAvailable: UpdateAvailable | null;
  statusBanner: ApplicationStatusBanner | null;
  configBusy: boolean;
  canAdmin: boolean;
  canUpdate: boolean;
  canHoldUpdate: boolean;
  updateBusy: boolean;
  nowMs?: number;
  onChannelChange: (channel: UpdatesChannel) => void;
  onAutomaticUpdatesChange: (enabled: boolean) => void;
  onUpdateNow: () => void;
  onHoldUpdate: () => Promise<boolean>;
};

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

function renderBuildFacts(props: UpdatesViewProps) {
  const installKind = props.schedule?.install?.kind;
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
  } else if (target) {
    kind = "accent";
    label = t("updates.page.available", { target });
  } else if (props.schedule) {
    kind = "ok";
    label = t("updates.page.upToDate");
  } else {
    label = t("updates.page.statusUnavailable");
  }
  const countdown = campaign?.state === "waiting-for-idle" || campaign?.state === "countdown";
  return html`<span role=${countdown ? "timer" : nothing} aria-live=${countdown ? "off" : nothing}
    >${renderSettingsStatus({ kind, label })}</span
  >`;
}

function readGitCommits(props: UpdatesViewProps) {
  const update = props.updateAvailable;
  const gitUpdate = props.schedule?.target?.kind === "git" || Boolean(update?.currentSha);
  return gitUpdate ? (update?.commits ?? []) : [];
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
      title: t("updates.page.automaticUpdates"),
      description: !automaticUpdatesSupported
        ? t("updates.page.extendedStableAutomaticHint")
        : devPackageInstall
          ? t("updates.page.devPackageAutomaticHint")
          : t("updates.page.automaticUpdatesDescription"),
      checked: automaticUpdatesSupported && settings.autoEnabled,
      disabled: props.configBusy || !automaticUpdatesSupported || devPackageInstall,
      onChange: props.onAutomaticUpdatesChange,
    }),
  ];
  const updateButtonTitle = !props.canAdmin ? t("updates.adminRequired") : "";
  return html`
    <div id="config-section-update">
      ${renderSettingsPage(
        [
          !props.canAdmin
            ? html`<div class="callout warning" role="note">${t("updates.adminRequired")}</div>`
            : nothing,
          renderBuildFacts(props),
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
        ],
        { intro: t("updates.page.intro") },
      )}
    </div>
  `;
}
