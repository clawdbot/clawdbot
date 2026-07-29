import { html, nothing } from "lit";
import type { DoctorMemoryStatusPayload } from "../../../../src/gateway/server-methods/doctor.ts";
import type { AgentSelectOption } from "../../components/agent-select.ts";
import {
  createLobsterPetLook,
  lobsterLookStyle,
  lobsterPetSeed,
  renderLobsterSvg,
} from "../../components/lobster-pet.ts";
import {
  renderSettingsNavRow,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import "../../styles/memory-overview.css";
import type { MemoryEngineSelection } from "./memory-schema.ts";
import { selectedEngineId } from "./memory-schema.ts";
import { renderMemoryAgentScope } from "./memory.ts";

export type MemoryOverviewStatus =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; payload: DoctorMemoryStatusPayload }
  | { kind: "error"; message: string };

type MemoryOverviewProps = {
  agentId: string | null;
  agents: readonly AgentSelectOption[];
  engineSelection: MemoryEngineSelection;
  engineDisabled: boolean;
  status: MemoryOverviewStatus;
  probingEmbeddings: boolean;
  onAgentChange: (agentId: string | null) => void;
  onRefresh: () => void;
  onProbeEmbeddings: () => void;
  onNavigate: (tab: "memories" | "dreams" | "settings") => void;
};

type DreamingStatus = NonNullable<DoctorMemoryStatusPayload["dreaming"]>;
type DreamingPhase = {
  enabled: boolean;
  cron: string;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
  lastRunAtMs?: number;
};

function hasEmbeddingError(payload: DoctorMemoryStatusPayload): boolean {
  return !payload.embedding.ok && payload.embedding.checked !== false;
}

function searchMode(payload: DoctorMemoryStatusPayload): string {
  return payload.provider === "none"
    ? t("memoryPage.overview.hero.keywordSearch")
    : t("memoryPage.overview.hero.hybridSearch");
}

function renderHero(props: MemoryOverviewProps) {
  const engineId = selectedEngineId(props.engineSelection);
  const off = props.engineSelection.kind === "off" || props.engineDisabled;
  const readyPayload = props.status.kind === "ready" ? props.status.payload : null;
  const error =
    props.status.kind === "error" || (readyPayload !== null && hasEmbeddingError(readyPayload));
  const look = createLobsterPetLook(lobsterPetSeed(props.agentId ?? "memory"));
  const headline = off
    ? t("memoryPage.overview.hero.hibernating")
    : props.status.kind === "loading" || props.status.kind === "idle"
      ? t("memoryPage.overview.hero.waking")
      : error
        ? t("memoryPage.overview.hero.needsAttention")
        : t("memoryPage.overview.hero.awake");
  const description = off
    ? t(
        props.engineDisabled
          ? "memoryPage.overview.hero.disabledDescription"
          : "memoryPage.overview.hero.offDescription",
      )
    : props.status.kind === "error"
      ? props.status.message
      : readyPayload
        ? hasEmbeddingError(readyPayload)
          ? (readyPayload.embedding.error ?? t("memoryPage.overview.health.unavailable"))
          : t("memoryPage.overview.hero.activeDescription", {
              engine: engineId ?? t("common.unknown"),
              mode: searchMode(readyPayload),
            })
        : t("memoryPage.overview.hero.loadingDescription");
  const pose = off
    ? { sleeping: true }
    : error
      ? { grumpy: true, standalone: true }
      : readyPayload
        ? { reading: true, standalone: true }
        : { standalone: true };

  return html`
    <section class="memory-overview__hero ${off ? "memory-overview__hero--sleeping" : ""}">
      <div class="memory-overview__lobster" style=${lobsterLookStyle(look)}>
        ${renderLobsterSvg(look, pose)}
      </div>
      <div class="memory-overview__hero-copy">
        <h2>${headline}</h2>
        <p class=${error ? "memory-overview__hero-error" : ""}>${description}</p>
        <div class="memory-overview__hero-actions">
          ${off
            ? html`<button class="btn btn--sm" @click=${() => props.onNavigate("settings")}>
                ${t("memoryPage.overview.hero.openSettings")}
              </button>`
            : html`<button class="btn btn--sm" @click=${props.onRefresh}>
                ${props.status.kind === "error"
                  ? t("memoryPage.overview.hero.retry")
                  : t("memoryPage.overview.hero.refresh")}
              </button>`}
        </div>
      </div>
    </section>
  `;
}

function phaseScheduleDescription(
  phase: DreamingPhase,
  timezone: string | undefined,
  scheduled: boolean,
) {
  const details = [
    phase.cron || t("common.na"),
    timezone,
    scheduled && phase.nextRunAtMs
      ? t("memoryPage.overview.schedule.nextRun", {
          time: formatRelativeTimestamp(phase.nextRunAtMs),
        })
      : null,
    phase.lastRunAtMs
      ? t("memoryPage.overview.schedule.lastRun", {
          time: formatRelativeTimestamp(phase.lastRunAtMs),
        })
      : null,
  ].filter((entry): entry is string => Boolean(entry));
  return details.join(" · ");
}

function renderSchedule(dreaming: DreamingStatus) {
  const phases = [
    ["light", dreaming.phases.light],
    ["rem", dreaming.phases.rem],
    ["deep", dreaming.phases.deep],
  ] as const;
  return renderSettingsSection(
    { title: t("memoryPage.overview.schedule.title") },
    html`
      ${phases.map(([name, phase]) =>
        renderSettingsRow({
          title: t(`memoryPage.dreaming.phases.${name}.title`),
          description: html`
            ${t(`memoryPage.overview.schedule.${name}Description`)}<br />
            ${phaseScheduleDescription(
              phase,
              dreaming.timezone,
              dreaming.enabled && phase.enabled && phase.managedCronPresent,
            )}
          `,
          control: renderSettingsStatus({
            kind: dreaming.enabled && phase.enabled && phase.managedCronPresent ? "ok" : "muted",
            label:
              !dreaming.enabled || !phase.enabled
                ? t("common.disabled")
                : phase.managedCronPresent
                  ? t("common.enabled")
                  : t("memoryPage.overview.schedule.notScheduled"),
          }),
        }),
      )}
      ${renderSettingsRow({
        title: t("memoryPage.overview.schedule.learnMore"),
        control: html`<a
          class="memory-page__link"
          href="https://docs.openclaw.ai/concepts/dreaming"
          target="_blank"
          rel="noreferrer noopener"
          >${t("memoryPage.overview.schedule.openDocs")}</a
        >`,
      })}
    `,
  );
}

function renderActivity(dreaming: DreamingStatus) {
  const rows = [
    ["promotedToday", dreaming.promotedToday],
    ["promotedTotal", dreaming.promotedTotal],
    ["shortTermCount", dreaming.shortTermCount],
    ["phaseHitCount", dreaming.phaseSignalCount],
    ["lightPhaseHitCount", dreaming.lightPhaseHitCount],
    ["remPhaseHitCount", dreaming.remPhaseHitCount],
  ] as const;
  return renderSettingsSection(
    { title: t("memoryPage.overview.activity.title") },
    rows.map(([label, value]) =>
      renderSettingsRow({
        title: t(`memoryPage.overview.activity.${label}`),
        control: renderSettingsValue(value),
      }),
    ),
  );
}

function renderEngineHealth(payload: DoctorMemoryStatusPayload, props: MemoryOverviewProps) {
  const notChecked = payload.embedding.checked === false;
  const embeddingKind = payload.embedding.ok ? "ok" : notChecked ? "muted" : "danger";
  const embeddingLabel = props.probingEmbeddings
    ? t("memoryPage.overview.health.checking")
    : payload.embedding.ok
      ? t("memoryPage.overview.health.healthy")
      : notChecked
        ? t("memoryPage.overview.health.notChecked")
        : t("memoryPage.overview.health.unavailable");
  return renderSettingsSection(
    { title: t("memoryPage.overview.health.title") },
    html`
      ${renderSettingsRow({
        title: t("memoryPage.overview.health.provider"),
        control: renderSettingsValue(payload.provider ?? t("common.unknown"), { mono: true }),
      })}
      ${renderSettingsRow({
        title: t("memoryPage.overview.health.embeddings"),
        description: payload.embedding.ok
          ? nothing
          : notChecked
            ? t("memoryPage.overview.health.notCheckedDescription")
            : payload.embedding.error,
        control: html`
          ${renderSettingsStatus({ kind: embeddingKind, label: embeddingLabel })}
          ${notChecked
            ? html`<button
                type="button"
                class="btn btn--sm"
                ?disabled=${props.probingEmbeddings}
                @click=${props.onProbeEmbeddings}
              >
                ${props.probingEmbeddings
                  ? t("memoryPage.overview.health.testing")
                  : t("memoryPage.overview.health.test")}
              </button>`
            : nothing}
        `,
      })}
      ${payload.embeddingRuntime
        ? renderSettingsRow({
            title: t("memoryPage.overview.health.runtime"),
            description: payload.embeddingRuntime.loadError,
            control: renderSettingsValue(
              [
                payload.embeddingRuntime.engine,
                payload.embeddingRuntime.backend,
                payload.embeddingRuntime.deviceNames?.join(", "),
              ]
                .filter(Boolean)
                .join(" · "),
            ),
          })
        : nothing}
    `,
  );
}

function renderStatusCards(props: MemoryOverviewProps) {
  if (props.status.kind !== "ready") {
    return nothing;
  }
  return html`
    ${props.status.payload.dreaming ? renderSchedule(props.status.payload.dreaming) : nothing}
    ${props.status.payload.dreaming ? renderActivity(props.status.payload.dreaming) : nothing}
    ${renderEngineHealth(props.status.payload, props)}
  `;
}

function renderShortcuts(props: MemoryOverviewProps) {
  return renderSettingsSection(
    { title: t("memoryPage.overview.shortcuts.title") },
    html`
      ${renderSettingsNavRow({
        title: t("memoryPage.overview.shortcuts.memories"),
        onClick: () => props.onNavigate("memories"),
      })}
      ${renderSettingsNavRow({
        title: t("memoryPage.overview.shortcuts.diary"),
        onClick: () => props.onNavigate("dreams"),
      })}
      ${renderSettingsNavRow({
        title: t("memoryPage.overview.shortcuts.settings"),
        onClick: () => props.onNavigate("settings"),
      })}
    `,
  );
}

export function renderMemoryOverview(props: MemoryOverviewProps) {
  const active = props.engineSelection.kind !== "off" && !props.engineDisabled;
  return html`
    <div class="settings-page memory-overview">
      ${renderHero(props)}
      ${renderMemoryAgentScope({
        agentId: props.agentId,
        agents: props.agents,
        onAgentChange: props.onAgentChange,
      })}
      ${active ? renderStatusCards(props) : nothing} ${renderShortcuts(props)}
    </div>
  `;
}
