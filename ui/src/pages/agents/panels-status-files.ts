// Control UI view renders agents panels status files screen content.
import { applyPreviewTheme } from "@create-markdown/preview";
import DOMPurify from "dompurify";
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import type {
  AgentsFilesListResult,
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
} from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatBytes, type AgentContext } from "../../lib/agents/display.ts";
import type { AgentsPanel } from "../../lib/agents/index.ts";
import { resolveChannelExtras as resolveChannelExtrasFromConfig } from "../../lib/channels/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import {
  formatCronPayload,
  formatCronSchedule,
  formatCronState,
  formatNextRun,
} from "../../lib/presenter.ts";

function countWords(text: string) {
  const normalized = text.trim();
  return normalized ? normalized.split(/\s+/).length : 0;
}

function countLines(text: string) {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function estimateReadingTimeLabel(wordCount: number) {
  if (wordCount <= 0) {
    return t("agents.files.emptyDraft");
  }
  return t("agents.files.minRead", { count: String(Math.max(1, Math.round(wordCount / 220))) });
}

function getExtensionLabel(fileName: string) {
  const ext = fileName.split(".").pop()?.trim().toLowerCase();
  if (ext === "md" || ext === "markdown") {
    return t("agents.files.markdownPreview");
  }
  return ext
    ? t("agents.files.extensionPreview", { ext: ext.toUpperCase() })
    : t("agents.files.preview");
}

function formatWorkspaceRelativePath(filePath: string, workspace: string | null | undefined) {
  const normalizedPath = filePath.trim();
  const normalizedWorkspace = workspace?.trim();
  if (!normalizedPath) {
    return "";
  }
  if (normalizedWorkspace && normalizedPath === normalizedWorkspace) {
    return ".";
  }
  if (normalizedWorkspace && normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    return normalizedPath.slice(normalizedWorkspace.length + 1) || ".";
  }
  const pathParts = normalizedPath.split(/[\\/]+/);
  for (let index = pathParts.length - 1; index >= 0; index -= 1) {
    const pathPart = pathParts[index];
    if (pathPart) {
      return pathPart;
    }
  }
  return normalizedPath;
}

function toDomId(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "") || "preview";
}

function setPreviewExpandButtonState(button: Element | null | undefined, isFullscreen: boolean) {
  if (!(button instanceof HTMLElement)) {
    return;
  }
  const label = isFullscreen ? t("agents.files.collapsePreview") : t("agents.files.expandPreview");
  button.classList.toggle("is-fullscreen", isFullscreen);
  button.setAttribute("aria-pressed", String(isFullscreen));
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

function renderAgentContextSection(
  context: AgentContext,
  subtitle: string,
  onSelectPanel: (panel: AgentsPanel) => void,
) {
  return renderSettingsSection(
    { title: t("agents.context.title"), description: subtitle },
    html`
      <dl class="settings-kv">
        <dt>${t("agents.context.workspace")}</dt>
        <dd>
          <button type="button" class="workspace-link mono" @click=${() => onSelectPanel("files")}>
            ${context.workspace}
          </button>
        </dd>
        <dt>${t("agents.context.primaryModel")}</dt>
        <dd><code>${context.model}</code></dd>
        <dt>${t("agents.context.runtime")}</dt>
        <dd><code>${context.runtime}</code></dd>
        <dt>${t("agents.context.identityName")}</dt>
        <dd>${context.identityName}</dd>
        <dt>${t("agents.context.identityAvatar")}</dt>
        <dd>${context.identityAvatar}</dd>
        <dt>${t("agents.context.skillsFilter")}</dt>
        <dd>${context.skillsLabel}</dd>
        <dt>${t("agents.context.default")}</dt>
        <dd>${context.isDefault ? t("common.yes") : t("common.no")}</dd>
      </dl>
    `,
  );
}

type ChannelSummaryEntry = {
  id: string;
  label: string;
  accounts: ChannelAccountSnapshot[];
};

function resolveChannelLabel(snapshot: ChannelsStatusSnapshot, id: string) {
  const meta = snapshot.channelMeta?.find((entry) => entry.id === id);
  if (meta?.label) {
    return meta.label;
  }
  return snapshot.channelLabels?.[id] ?? id;
}

function resolveChannelEntries(snapshot: ChannelsStatusSnapshot | null): ChannelSummaryEntry[] {
  if (!snapshot) {
    return [];
  }
  const ids = new Set<string>();
  for (const id of snapshot.channelOrder ?? []) {
    ids.add(id);
  }
  for (const entry of snapshot.channelMeta ?? []) {
    ids.add(entry.id);
  }
  for (const id of Object.keys(snapshot.channelAccounts ?? {})) {
    ids.add(id);
  }
  const ordered: string[] = [];
  const seed = snapshot.channelOrder?.length ? snapshot.channelOrder : Array.from(ids);
  for (const id of seed) {
    if (!ids.has(id)) {
      continue;
    }
    ordered.push(id);
    ids.delete(id);
  }
  for (const id of ids) {
    ordered.push(id);
  }
  return ordered.map((id) => ({
    id,
    label: resolveChannelLabel(snapshot, id),
    accounts: snapshot.channelAccounts?.[id] ?? [],
  }));
}

const CHANNEL_EXTRA_FIELDS = ["groupPolicy", "streamMode", "dmPolicy"] as const;

function summarizeChannelAccounts(accounts: ChannelAccountSnapshot[]) {
  let connected = 0;
  let configured = 0;
  let enabled = 0;
  for (const account of accounts) {
    const probeOk =
      account.probe && typeof account.probe === "object" && "ok" in account.probe
        ? Boolean((account.probe as { ok?: unknown }).ok)
        : false;
    const isConnected = account.connected === true || account.running === true || probeOk;
    if (isConnected) {
      connected += 1;
    }
    if (account.configured) {
      configured += 1;
    }
    if (account.enabled) {
      enabled += 1;
    }
  }
  return {
    total: accounts.length,
    connected,
    configured,
    enabled,
  };
}

export function renderAgentChannels(params: {
  context: AgentContext;
  configForm: Record<string, unknown> | null;
  snapshot: ChannelsStatusSnapshot | null;
  loading: boolean;
  error: string | null;
  lastSuccess: number | null;
  onRefresh: () => void;
  onSelectPanel: (panel: AgentsPanel) => void;
}) {
  const entries = resolveChannelEntries(params.snapshot);
  const lastSuccessLabel = params.lastSuccess
    ? formatRelativeTimestamp(params.lastSuccess)
    : t("common.never");
  return html`
    ${renderAgentContextSection(
      params.context,
      t("agents.context.configurationSubtitle"),
      params.onSelectPanel,
    )}
    ${params.error ? html`<div class="callout danger">${params.error}</div>` : nothing}
    ${!params.snapshot
      ? html`<div class="callout info">${t("agents.channels.loadHint")}</div>`
      : nothing}
    ${renderSettingsSection(
      {
        title: t("agents.channels.title"),
        description: html`${t("agents.channels.subtitle")}
        ${t("agents.channels.lastRefresh", { time: lastSuccessLabel })}`,
        actions: html`
          <button class="btn btn--sm" ?disabled=${params.loading} @click=${params.onRefresh}>
            ${params.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        `,
      },
      entries.length === 0
        ? renderSettingsEmpty(t("agents.channels.empty"))
        : entries.map((entry) => {
            const summary = summarizeChannelAccounts(entry.accounts);
            const status = summary.total
              ? t("agents.channels.connectedCount", {
                  connected: String(summary.connected),
                  total: String(summary.total),
                })
              : t("agents.channels.noAccounts");
            const configLabel = summary.configured
              ? t("agents.channels.configuredCount", { count: String(summary.configured) })
              : t("agents.channels.notConfigured");
            const enabled = summary.total
              ? t("agents.channels.enabledCount", { count: String(summary.enabled) })
              : t("common.disabled");
            const extras = resolveChannelExtrasFromConfig({
              configForm: params.configForm,
              channelId: entry.id,
              fields: CHANNEL_EXTRA_FIELDS,
            });
            const metaParts = [
              entry.id,
              configLabel,
              enabled,
              ...extras.map((extra) => `${extra.label}: ${extra.value}`),
            ];
            return renderSettingsRow({
              title: entry.label,
              description: metaParts.join(" · "),
              control: html`
                ${summary.configured === 0
                  ? html`
                      <a
                        class="settings-row__value"
                        href="https://docs.openclaw.ai/channels"
                        target="_blank"
                        rel="noopener"
                        >${t("agents.channels.setupGuide")}</a
                      >
                    `
                  : nothing}
                ${renderSettingsStatus({
                  kind: summary.connected > 0 ? "ok" : summary.total ? "warn" : "muted",
                  label: status,
                })}
              `,
            });
          }),
    )}
  `;
}

export function renderAgentCron(params: {
  context: AgentContext;
  agentId: string;
  jobs: CronJob[];
  status: CronStatus | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onRunNow: (jobId: string) => void;
  onSelectPanel: (panel: AgentsPanel) => void;
}) {
  const jobs = params.jobs.filter((job) => job.agentId === params.agentId);
  return html`
    ${renderAgentContextSection(
      params.context,
      t("agents.context.schedulingSubtitle"),
      params.onSelectPanel,
    )}
    ${params.error ? html`<div class="callout danger">${params.error}</div>` : nothing}
    ${renderSettingsSection(
      {
        title: t("agents.cronPanel.schedulerTitle"),
        description: t("agents.cronPanel.schedulerSubtitle"),
        actions: html`
          <button class="btn btn--sm" ?disabled=${params.loading} @click=${params.onRefresh}>
            ${params.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        `,
      },
      html`
        ${renderSettingsRow({
          title: t("common.enabled"),
          control: renderSettingsValue(
            params.status
              ? params.status.enabled
                ? t("common.yes")
                : t("common.no")
              : t("common.na"),
          ),
        })}
        ${renderSettingsRow({
          title: t("agents.cronPanel.jobs"),
          control: renderSettingsValue(params.status?.jobs ?? t("common.na")),
        })}
        ${renderSettingsRow({
          title: t("agents.cronPanel.nextWake"),
          control: renderSettingsValue(formatNextRun(params.status?.nextWakeAtMs ?? null)),
        })}
      `,
    )}
    ${renderSettingsSection(
      {
        title: t("agents.cronPanel.agentJobsTitle"),
        description: t("agents.cronPanel.agentJobsSubtitle"),
      },
      jobs.length === 0
        ? renderSettingsEmpty(t("agents.cronPanel.noJobs"))
        : jobs.map((job) => {
            const metaParts = [
              job.description,
              formatCronSchedule(job),
              job.sessionTarget,
              formatCronState(job),
              formatCronPayload(job),
            ].filter(Boolean);
            return renderSettingsRow({
              title: job.name,
              description: metaParts.join(" · "),
              control: html`
                ${renderSettingsStatus({
                  kind: job.enabled ? "ok" : "warn",
                  label: job.enabled ? t("common.enabled") : t("common.disabled"),
                })}
                <button
                  class="btn btn--sm"
                  ?disabled=${!job.enabled}
                  @click=${() => params.onRunNow(job.id)}
                >
                  ${t("agents.cronPanel.runNow")}
                </button>
              `,
            });
          }),
    )}
  `;
}

export function renderAgentFiles(params: {
  agentId: string;
  agentFilesList: AgentsFilesListResult | null;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileSaving: boolean;
  onLoadFiles: (agentId: string) => void;
  onSelectFile: (name: string) => void;
  onFileDraftChange: (name: string, content: string) => void;
  onFileReset: (name: string) => void;
  onFileSave: (name: string) => void;
}) {
  const list = params.agentFilesList?.agentId === params.agentId ? params.agentFilesList : null;
  const files = list?.files ?? [];
  const active = params.agentFileActive ?? null;
  const activeEntry = active ? (files.find((file) => file.name === active) ?? null) : null;
  const baseContent = active ? (params.agentFileContents[active] ?? "") : "";
  const draft = active ? (params.agentFileDrafts[active] ?? baseContent) : "";
  const isDirty = active ? draft !== baseContent : false;
  const previewHtml = activeEntry
    ? applyPreviewTheme(marked.parse(draft, { gfm: true, breaks: true }) as string, {
        sanitize: (h: string) => DOMPurify.sanitize(h),
      })
    : "";
  const draftByteSize = formatBytes(new TextEncoder().encode(draft).length);
  const draftWordCount = countWords(draft);
  const draftLineCount = countLines(draft);
  const activePathLabel = activeEntry
    ? formatWorkspaceRelativePath(activeEntry.path, list?.workspace)
    : "";
  const previewTitleId = activeEntry ? `agent-file-preview-title-${toDomId(activeEntry.name)}` : "";
  const previewStatusLabel = activeEntry?.missing
    ? t("agents.files.willCreateOnSave")
    : isDirty
      ? t("agents.files.liveDraftPreview")
      : t("agents.files.savedPreview");
  const previewStatusClass = activeEntry?.missing
    ? "is-missing"
    : isDirty
      ? "is-dirty"
      : "is-synced";
  const previewUpdatedLabel = activeEntry?.updatedAtMs
    ? t("agents.files.updated", { time: formatRelativeTimestamp(activeEntry.updatedAtMs) })
    : activeEntry?.missing
      ? t("agents.files.notCreatedYet")
      : t("agents.files.updatedUnknown");

  return html`
    ${params.agentFilesError
      ? html`<div class="callout danger">${params.agentFilesError}</div>`
      : nothing}
    ${renderSettingsSection(
      {
        title: t("agents.files.coreFilesTitle"),
        description: list
          ? html`${t("agents.files.coreFilesSubtitle")} ${t("agents.files.workspace")}:
              <code>${list.workspace}</code>`
          : t("agents.files.coreFilesSubtitle"),
        actions: html`
          <button
            class="btn btn--sm"
            ?disabled=${params.agentFilesLoading}
            @click=${() => params.onLoadFiles(params.agentId)}
          >
            ${params.agentFilesLoading ? t("common.loading") : t("common.refresh")}
          </button>
        `,
      },
      !list
        ? renderSettingsEmpty(t("agents.files.loadHint"))
        : files.length === 0
          ? renderSettingsEmpty(t("agents.files.empty"))
          : html`
              <div class="agents-panel-body">
                <div class="agent-tabs">
                  ${files.map((file) => {
                    const isActive = active === file.name;
                    const label = file.name.replace(/\.md$/i, "");
                    // File reads are serialized; changing the active tab mid-read would
                    // expose an editor whose content request was never accepted.
                    return html`
                      <button
                        class="agent-tab ${isActive ? "active" : ""} ${file.missing
                          ? "agent-tab--missing"
                          : ""}"
                        ?disabled=${params.agentFilesLoading}
                        @click=${() => params.onSelectFile(file.name)}
                      >
                        ${label}${file.missing
                          ? html`
                              <span class="agent-tab-badge">${t("agents.files.missing")}</span>
                            `
                          : nothing}
                      </button>
                    `;
                  })}
                </div>
                ${!activeEntry
                  ? html`<div class="muted">${t("agents.files.selectFile")}</div>`
                  : html`
                      <div class="agent-file-header">
                        <div>
                          <div class="agent-file-sub mono">${activeEntry.path}</div>
                        </div>
                        <div class="agent-file-actions">
                          <button
                            class="btn btn--sm"
                            @click=${(e: Event) => {
                              const btn = e.currentTarget as HTMLElement;
                              const dialog = btn
                                .closest(".settings-group")
                                ?.querySelector("dialog");
                              if (dialog) {
                                dialog.showModal();
                              }
                            }}
                          >
                            ${icons.eye} ${t("agents.files.preview")}
                          </button>
                          <button
                            class="btn btn--sm"
                            ?disabled=${!isDirty}
                            @click=${() => params.onFileReset(activeEntry.name)}
                          >
                            ${t("common.reset")}
                          </button>
                          <button
                            class="btn btn--sm primary"
                            ?disabled=${params.agentFileSaving || !isDirty}
                            @click=${() => params.onFileSave(activeEntry.name)}
                          >
                            ${params.agentFileSaving ? t("common.saving") : t("common.save")}
                          </button>
                        </div>
                      </div>
                      ${activeEntry.missing
                        ? html`<div class="callout info">${t("agents.files.missingHint")}</div>`
                        : nothing}
                      <label class="field agent-file-field">
                        <span>${t("agents.files.content")}</span>
                        <textarea
                          class="agent-file-textarea"
                          .value=${draft}
                          @input=${(e: Event) =>
                            params.onFileDraftChange(
                              activeEntry.name,
                              (e.target as HTMLTextAreaElement).value,
                            )}
                        ></textarea>
                      </label>
                      <dialog
                        class="md-preview-dialog"
                        aria-labelledby=${previewTitleId}
                        @click=${(e: Event) => {
                          const dialog = e.currentTarget as HTMLDialogElement;
                          if (e.target === dialog) {
                            dialog.close();
                          }
                        }}
                        @close=${(e: Event) => {
                          const dialog = e.currentTarget as HTMLElement;
                          dialog
                            .querySelector(".md-preview-dialog__panel")
                            ?.classList.remove("fullscreen");
                          setPreviewExpandButtonState(
                            dialog.querySelector(".md-preview-expand-btn"),
                            false,
                          );
                        }}
                      >
                        <div class="md-preview-dialog__panel">
                          <div class="md-preview-dialog__header">
                            <div class="md-preview-dialog__header-main">
                              <div class="md-preview-dialog__eyebrow">
                                ${icons.scrollText}
                                <span>${getExtensionLabel(activeEntry.name)}</span>
                              </div>
                              <div class="md-preview-dialog__title-wrap">
                                <div
                                  id=${previewTitleId}
                                  class="md-preview-dialog__title"
                                  translate="no"
                                >
                                  ${activeEntry.name}
                                </div>
                                <div class="md-preview-dialog__path mono" translate="no">
                                  ${activePathLabel}
                                </div>
                              </div>
                            </div>
                            <div class="md-preview-dialog__actions">
                              <openclaw-tooltip .content=${t("agents.files.expandPreview")}>
                                <button
                                  type="button"
                                  class="btn btn--sm md-preview-icon-btn md-preview-expand-btn"
                                  aria-label=${t("agents.files.expandPreview")}
                                  aria-pressed="false"
                                  @click=${(e: Event) => {
                                    const btn = e.currentTarget as HTMLElement;
                                    const panel = btn.closest(".md-preview-dialog__panel");
                                    if (!panel) {
                                      return;
                                    }
                                    const isFullscreen = panel.classList.toggle("fullscreen");
                                    setPreviewExpandButtonState(btn, isFullscreen);
                                  }}
                                >
                                  <span class="when-normal" aria-hidden="true"
                                    >${icons.maximize}</span
                                  ><span class="when-fullscreen" aria-hidden="true"
                                    >${icons.minimize}</span
                                  >
                                </button>
                              </openclaw-tooltip>
                              <openclaw-tooltip .content=${t("agents.files.editFile")}>
                                <button
                                  type="button"
                                  class="btn btn--sm md-preview-icon-btn"
                                  aria-label=${t("agents.files.editFile")}
                                  @click=${(e: Event) => {
                                    (e.currentTarget as HTMLElement).closest("dialog")?.close();
                                    const textarea =
                                      document.querySelector<HTMLElement>(".agent-file-textarea");
                                    textarea?.focus();
                                  }}
                                >
                                  <span aria-hidden="true">${icons.edit}</span>
                                </button>
                              </openclaw-tooltip>
                              <openclaw-tooltip .content=${t("agents.files.closePreview")}>
                                <button
                                  type="button"
                                  class="btn btn--sm md-preview-icon-btn"
                                  aria-label=${t("agents.files.closePreview")}
                                  @click=${(e: Event) => {
                                    (e.currentTarget as HTMLElement).closest("dialog")?.close();
                                  }}
                                >
                                  <span aria-hidden="true">${icons.x}</span>
                                </button>
                              </openclaw-tooltip>
                            </div>
                          </div>
                          <div class="md-preview-dialog__meta">
                            <div class="md-preview-dialog__chip ${previewStatusClass}">
                              <strong>${previewStatusLabel}</strong>
                            </div>
                            <div class="md-preview-dialog__chip">
                              <strong>${estimateReadingTimeLabel(draftWordCount)}</strong>
                              <span
                                >${t("agents.files.words", { count: String(draftWordCount) })}</span
                              >
                            </div>
                            <div class="md-preview-dialog__chip">
                              <strong>${draftLineCount}</strong>
                              <span>${t("agents.files.lines")}</span>
                            </div>
                            <div class="md-preview-dialog__chip">
                              <strong>${draftByteSize}</strong>
                              <span>${previewUpdatedLabel}</span>
                            </div>
                          </div>
                          <div class="md-preview-dialog__body">
                            <article class="md-preview-dialog__reader sidebar-markdown">
                              ${unsafeHTML(previewHtml)}
                            </article>
                          </div>
                        </div>
                      </dialog>
                    `}
              </div>
            `,
    )}
  `;
}
