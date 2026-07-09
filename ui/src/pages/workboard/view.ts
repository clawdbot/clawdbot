// Control UI view renders workboard screen content.

import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, GatewaySessionRow } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { formatDateMs, formatDateTimeMs } from "../../lib/format.ts";
import {
  addWorkboardCardComment,
  archiveWorkboardCard,
  configureWorkboardPolling,
  deleteWorkboardCard,
  dispatchWorkboard,
  filterWorkboardCardsForPreset,
  findWorkboardSession,
  getWorkboardDependencyState,
  getWorkboardLifecycle,
  getWorkboardState,
  moveWorkboardCard,
  refreshWorkboard,
  saveWorkboardCardDraft,
  startWorkboardCard,
  stopWorkboardCard,
  summarizeWorkboardHealth,
  workboardCardMatchesHealthKey,
  workboardHasActiveWrites,
  workboardMutationsReady,
  WORKBOARD_PRIORITIES,
  type WorkboardAutoRefreshIntervalMs,
  type WorkboardDependencyState,
  type WorkboardExecutionEngine,
  type WorkboardExecutionMode,
  type WorkboardCard,
  type WorkboardEvent,
  type WorkboardHealthKey,
  type WorkboardHealthSummary,
  type WorkboardLifecycle,
  type WorkboardPriority,
  type WorkboardStatus,
  type WorkboardTaskSummary,
  type WorkboardTemplateId,
  type WorkboardUiState,
} from "../../lib/workboard/index.ts";

type WorkboardAgentRow = AgentsListResult["agents"][number];
type WorkboardConfiguredAgentOption = {
  id: string;
  label: string;
  isDefault: boolean;
};
type WorkboardAgentFilterOption = {
  id: WorkboardUiState["agentFilter"];
  label: string;
  description?: string;
};
type WorkboardSelectOption<Value extends string = string> = {
  value: Value;
  label: string;
  description?: string;
  disabled?: boolean;
};

type WorkboardProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  canWrite?: boolean;
  canModelOverride?: boolean;
  pluginEnabled: boolean | null;
  pluginEnablementError?: string | null;
  agentsList: AgentsListResult | null;
  sessions: GatewaySessionRow[];
  onOpenSession: (sessionKey: string) => void;
  onReloadConfig?: () => void;
  onRequestUpdate?: () => void;
};

const workboardCardModalTitleId = "workboard-card-modal-title";
const workboardCardModalDescriptionId = "workboard-card-modal-description";
const workboardCardModalId = "workboard-card-modal";
const workboardCardDetailDrawerId = "workboard-card-detail-drawer";
const workboardCardDetailTitleId = "workboard-card-detail-title";
const workboardCardDetailDescriptionId = "workboard-card-detail-description";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let activeWorkboardDialog: HTMLElement | null = null;
let workboardReturnFocusTarget: Element | null = null;

const WORKBOARD_TEMPLATES: Array<{
  id: WorkboardTemplateId;
  title: string;
  notes: string;
  labels: string;
  priority: WorkboardPriority;
}> = [
  {
    id: "bugfix",
    title: "Fix: ",
    notes: "Symptom:\nCause:\nAcceptance:\nProof:",
    labels: "fix, test",
    priority: "high",
  },
  {
    id: "docs",
    title: "Docs: ",
    notes: "Page:\nChange:\nSource proof:",
    labels: "docs",
    priority: "normal",
  },
  {
    id: "release",
    title: "Release: ",
    notes: "Scope:\nVerification:\nCloseout:",
    labels: "release",
    priority: "urgent",
  },
  {
    id: "pr_review",
    title: "Review PR ",
    notes: "Surface:\nRisks:\nProof:",
    labels: "review",
    priority: "normal",
  },
  {
    id: "plugin",
    title: "Plugin: ",
    notes: "Boundary:\nConfig/docs:\nTests:",
    labels: "plugin",
    priority: "normal",
  },
];

function formatStatusLabel(status: WorkboardStatus): string {
  return t(`workboard.status.${status}`);
}

function formatPriorityLabel(priority: WorkboardPriority): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

function formatTime(value: number | undefined): string {
  if (!value) {
    return "";
  }
  return formatDateMs(
    value,
    {
      month: "short",
      day: "numeric",
    },
    "",
  );
}

function formatRefreshTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatUpdatedTime(value: number | undefined): string {
  if (!value) {
    return "";
  }
  return formatDateTimeMs(
    value,
    {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    },
    "",
  );
}

function formatAge(value: number | undefined): string {
  if (!value) {
    return "";
  }
  const elapsedMs = Math.max(0, Date.now() - value);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) {
    return t("activity.duration.seconds", { count: String(Math.floor(elapsedMs / 1000)) });
  }
  if (minutes < 60) {
    return t("activity.duration.minutes", {
      minutes: String(minutes),
      seconds: "0",
    });
  }
  return t("workboard.ageHours", { count: String(Math.floor(minutes / 60)) });
}

function truncateBadgeText(value: string, maxLength = 64): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${truncateUtf16Safe(trimmed, Math.max(0, maxLength - 1))}…`;
}

function canMutate(props: WorkboardProps): boolean {
  return props.canWrite !== false && workboardMutationsReady(getWorkboardState(props.host));
}

function canWrite(props: WorkboardProps): boolean {
  return props.canWrite !== false;
}

function rememberWorkboardReturnFocus(target: EventTarget | Element | null | undefined) {
  if (target instanceof Element) {
    workboardReturnFocusTarget = target;
    return;
  }
  if (!workboardReturnFocusTarget) {
    workboardReturnFocusTarget = document.activeElement;
  }
}

function restoreWorkboardFocus() {
  const target = workboardReturnFocusTarget;
  workboardReturnFocusTarget = null;
  activeWorkboardDialog = null;
  if (!(target instanceof HTMLElement) || !target.isConnected) {
    return;
  }
  requestAnimationFrame(() => {
    if (target.isConnected) {
      target.focus();
    }
  });
}

function focusElement(element: HTMLElement) {
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function isFocusableWorkboardElement(element: HTMLElement): boolean {
  if (!element.isConnected || element.tabIndex < 0) {
    return false;
  }
  return !element.closest("[hidden], [inert]");
}

function getFocusableWorkboardElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    isFocusableWorkboardElement,
  );
}

function focusWorkboardDialog(root: HTMLElement, initialFocusSelector?: string) {
  requestAnimationFrame(() => {
    if (!root.isConnected || activeWorkboardDialog !== root) {
      return;
    }
    const active = document.activeElement;
    if (active instanceof Element && root.contains(active)) {
      return;
    }
    const preferred = initialFocusSelector
      ? root.querySelector<HTMLElement>(initialFocusSelector)
      : null;
    const target =
      preferred && isFocusableWorkboardElement(preferred)
        ? preferred
        : initialFocusSelector
          ? getFocusableWorkboardElements(root)[0]
          : root;
    focusElement(target);
  });
}

function syncWorkboardDialog(element: Element | undefined, initialFocusSelector?: string) {
  if (!(element instanceof HTMLElement)) {
    const previousDialog = activeWorkboardDialog;
    if (!previousDialog) {
      return;
    }
    if (!previousDialog.isConnected) {
      restoreWorkboardFocus();
      return;
    }
    queueMicrotask(() => {
      if (activeWorkboardDialog === previousDialog && !previousDialog.isConnected) {
        restoreWorkboardFocus();
      }
    });
    return;
  }
  if (activeWorkboardDialog !== element) {
    rememberWorkboardReturnFocus(null);
    activeWorkboardDialog = element;
  }
  focusWorkboardDialog(element, initialFocusSelector);
}

function trapWorkboardDialogFocus(event: KeyboardEvent, root: HTMLElement) {
  const focusable = getFocusableWorkboardElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    focusElement(root);
    return;
  }

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const focusInside = active ? root.contains(active) : false;

  if (event.shiftKey && (!focusInside || active === first || active === root)) {
    event.preventDefault();
    focusElement(last);
    return;
  }
  if (!event.shiftKey && (!focusInside || active === last || active === root)) {
    event.preventDefault();
    focusElement(first);
  }
}

function handleWorkboardDialogKeydown(
  event: KeyboardEvent,
  props: WorkboardProps,
  close: () => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    props.onRequestUpdate?.();
    return;
  }
  if (event.key === "Tab") {
    trapWorkboardDialogFocus(event, event.currentTarget as HTMLElement);
  }
}

function formatEventLabel(event: WorkboardEvent): string {
  switch (event.kind) {
    case "created":
      return t("workboard.eventCreated");
    case "edited":
      return t("workboard.eventEdited");
    case "moved":
      return event.toStatus
        ? t("workboard.eventMovedTo", { status: formatStatusLabel(event.toStatus) })
        : t("workboard.eventMoved");
    case "linked":
      return t("workboard.eventLinked");
    case "specified":
      return t("workboard.eventSpecified");
    case "decomposed":
      return t("workboard.eventDecomposed");
    case "claimed":
      return t("workboard.eventClaimed");
    case "heartbeat":
      return t("workboard.eventHeartbeat");
    case "execution_updated":
      return t("workboard.eventExecutionUpdated");
    case "attempt_started":
      return t("workboard.eventAttemptStarted");
    case "attempt_updated":
      return t("workboard.eventAttemptUpdated");
    case "comment_added":
      return t("workboard.eventCommentAdded");
    case "link_added":
      return t("workboard.eventLinkAdded");
    case "proof_added":
      return t("workboard.eventProofAdded");
    case "artifact_added":
      return t("workboard.eventArtifactAdded");
    case "attachment_added":
      return t("workboard.eventAttachmentAdded");
    case "diagnostic":
      return t("workboard.eventDiagnostic");
    case "notification":
      return t("workboard.eventNotification");
    case "dispatch":
      return t("workboard.eventDispatch");
    case "orchestration":
      return t("workboard.eventOrchestration");
    case "protocol_violation":
      return t("workboard.eventProtocolViolation");
    case "archived":
      return t("workboard.eventArchived");
    case "unarchived":
      return t("workboard.eventUnarchived");
    case "stale":
      return t("workboard.eventStale");
  }
  return "";
}

function renderEvents(card: WorkboardCard) {
  const events = (card.events ?? []).toReversed().slice(0, 4);
  if (events.length === 0) {
    return nothing;
  }
  return html`
    <ol class="workboard-events" aria-label=${t("workboard.eventsLabel")}>
      ${events.map(
        (event) => html`
          <li>
            <span>${formatEventLabel(event)}</span>
            <time>${formatTime(event.at)}</time>
          </li>
        `,
      )}
    </ol>
  `;
}

function renderCompactBadges(card: WorkboardCard, task?: WorkboardTaskSummary) {
  const metadata = card.metadata;
  const badges: TemplateResult[] = [];
  const latestDiagnostic = metadata?.diagnostics?.toSorted(
    (left, right) => right.lastSeenAt - left.lastSeenAt,
  )[0];
  const blockedReason =
    card.status === "blocked"
      ? (metadata?.notifications?.at(-1)?.message ??
        metadata?.workerProtocol?.detail ??
        latestDiagnostic?.detail)
      : undefined;
  if (metadata?.templateId) {
    badges.push(html`<span>${t(`workboard.template.${metadata.templateId}`)}</span>`);
  }
  if (task ?? card.taskId) {
    badges.push(html`<span>${t("workboard.badgeTaskLinked")}</span>`);
  }
  if (metadata?.attempts?.length) {
    badges.push(
      html`<span
        >${t("workboard.badgeAttempts", { count: String(metadata.attempts.length) })}</span
      >`,
    );
  }
  if (metadata?.failureCount) {
    badges.push(html`
      <span class="workboard-card__badge--warning">
        ${icons.alertTriangle}${t("workboard.badgeFailures", {
          count: String(metadata.failureCount),
        })}
      </span>
    `);
  }
  if (metadata?.comments?.length) {
    badges.push(
      html`<span
        >${t("workboard.badgeComments", { count: String(metadata.comments.length) })}</span
      >`,
    );
  }
  if (metadata?.proof?.length) {
    badges.push(
      html`<span>${t("workboard.badgeProof", { count: String(metadata.proof.length) })}</span>`,
    );
  }
  if (metadata?.claim) {
    badges.push(
      html`<span>${t("workboard.badgeClaimed", { owner: metadata.claim.ownerId })}</span>`,
    );
    const heartbeatAge = formatAge(metadata.claim.lastHeartbeatAt);
    if (heartbeatAge) {
      badges.push(html`<span>${t("workboard.badgeHeartbeat", { age: heartbeatAge })}</span>`);
    }
  }
  if (latestDiagnostic) {
    badges.push(
      html`<span class="workboard-card__badge--warning" title=${latestDiagnostic.detail}>
        ${icons.alertTriangle}${truncateBadgeText(latestDiagnostic.title)}
      </span>`,
    );
  }
  if (blockedReason) {
    badges.push(
      html`<span class="workboard-card__badge--warning" title=${blockedReason}>
        ${icons.alertTriangle}${truncateBadgeText(blockedReason)}
      </span>`,
    );
  }
  if (metadata?.stale) {
    badges.push(
      html`<span class="workboard-card__badge--warning"
        >${icons.alertTriangle}${t("workboard.badgeStale")}</span
      >`,
    );
  }
  if (badges.length === 0) {
    return nothing;
  }
  return html` <div class="workboard-card__badges">${badges}</div> `;
}

function matchesFilter(
  card: WorkboardCard,
  options: { query: string; priority: "all" | WorkboardPriority },
): boolean {
  if (options.priority !== "all" && card.priority !== options.priority) {
    return false;
  }
  const query = options.query.trim().toLowerCase();
  if (!query) {
    return true;
  }
  return [
    card.title,
    card.notes,
    card.agentId,
    card.sessionKey,
    card.execution?.engine,
    card.execution?.mode,
    card.execution?.model,
    card.execution?.sessionKey,
    card.metadata?.templateId,
    card.metadata?.automation?.tenant,
    card.metadata?.automation?.idempotencyKey,
    card.metadata?.automation?.workspace?.kind,
    card.metadata?.automation?.workspace?.path,
    card.metadata?.automation?.workspace?.branch,
    ...(card.metadata?.automation?.skills ?? []),
    ...(card.metadata?.automation?.createdCardIds ?? []),
    ...(card.metadata?.comments ?? []).map((comment) => comment.body),
    ...(card.metadata?.links ?? []).flatMap((link) => [link.title, link.url, link.targetCardId]),
    ...(card.metadata?.proof ?? []).flatMap((proof) => [
      proof.label,
      proof.command,
      proof.url,
      proof.note,
    ]),
    ...(card.metadata?.artifacts ?? []).flatMap((artifact) => [
      artifact.label,
      artifact.url,
      artifact.path,
      artifact.mimeType,
    ]),
    ...(card.metadata?.attachments ?? []).flatMap((attachment) => [
      attachment.fileName,
      attachment.mimeType,
      attachment.note,
    ]),
    ...(card.metadata?.workerLogs ?? []).map((log) => log.message),
    card.metadata?.workerProtocol?.state,
    card.metadata?.workerProtocol?.detail,
    card.metadata?.claim?.ownerId,
    ...(card.metadata?.diagnostics ?? []).flatMap((diagnostic) => [
      diagnostic.kind,
      diagnostic.severity,
      diagnostic.title,
      diagnostic.detail,
    ]),
    ...(card.metadata?.notifications ?? []).map((notification) => notification.message),
    ...card.labels,
  ]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(query));
}

function nextPosition(cards: readonly WorkboardCard[], status: WorkboardStatus): number {
  const positions = cards.filter((card) => card.status === status).map((card) => card.position);
  return (positions.length ? Math.max(...positions) : 0) + 1000;
}

function isWorkboardSessionChoice(session: GatewaySessionRow): boolean {
  if (session.archived || session.kind === "global") {
    return false;
  }
  const raw = [session.key, session.label, session.displayName]
    .filter((value): value is string => typeof value === "string")
    .join(":")
    .toLowerCase();
  return !/(^|:)heartbeat(:|$)/.test(raw);
}

function isCardActionTarget(event: Event): boolean {
  return event.target instanceof Element
    ? Boolean(event.target.closest("button, a, input, select, textarea"))
    : false;
}

function agentDisplayName(agent: WorkboardAgentRow | undefined, fallback: string): string {
  return agent?.name ?? agent?.identity?.name ?? agent?.id ?? fallback;
}

function cardAgentId(card: WorkboardCard, agentsList: AgentsListResult | null): string {
  return card.agentId?.trim() || agentsList?.defaultId || "";
}

function findCardAgent(
  card: WorkboardCard,
  agentsList: AgentsListResult | null,
): WorkboardAgentRow | undefined {
  const id = cardAgentId(card, agentsList);
  return id ? agentsList?.agents.find((agent) => agent.id === id) : undefined;
}

function cardAgentLabel(card: WorkboardCard, agentsList: AgentsListResult | null): string {
  const fallback = card.agentId?.trim() || t("workboard.defaultAgent");
  return agentDisplayName(findCardAgent(card, agentsList), fallback);
}

function matchesAgentFilter(
  card: WorkboardCard,
  agentsList: AgentsListResult | null,
  filter: WorkboardUiState["agentFilter"],
): boolean {
  if (filter === "all") {
    return true;
  }
  const explicitAgentId = card.agentId?.trim();
  if (filter === "default") {
    return !explicitAgentId;
  }
  void agentsList;
  return explicitAgentId === filter;
}

function buildConfiguredAgentOptions(
  agentsList: AgentsListResult | null,
): WorkboardConfiguredAgentOption[] {
  const seen = new Set<string>();
  const defaultAgentId = normalizeAgentOptionId(agentsList?.defaultId);
  const options: WorkboardConfiguredAgentOption[] = [];
  for (const agent of agentsList?.agents ?? []) {
    const id = normalizeAgentOptionId(agent.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    options.push({
      id,
      label: agentDisplayName(agent, id),
      isDefault: Boolean(defaultAgentId && id === defaultAgentId),
    });
  }
  return options;
}

function normalizeAgentOptionId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function defaultAgentFilterLabel(configuredAgents: readonly WorkboardConfiguredAgentOption[]) {
  return configuredAgents.find((agent) => agent.isDefault)?.label ?? t("workboard.defaultAgent");
}

function buildAgentFilterOptions(
  agentsList: AgentsListResult | null,
  cards: readonly WorkboardCard[],
) {
  const configuredAgents = buildConfiguredAgentOptions(agentsList);
  const configuredIds = new Set(configuredAgents.map((agent) => agent.id));
  const cardAgentIds = [
    ...new Set(
      cards
        .map((card) => normalizeAgentOptionId(card.agentId))
        .filter((id) => id && !configuredIds.has(id)),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  const options: WorkboardAgentFilterOption[] = [
    { id: "all", label: t("workboard.allAgents") },
    {
      id: "default",
      label: t("workboard.agentFilterUnassigned", {
        agent: defaultAgentFilterLabel(configuredAgents),
      }),
      description: t("workboard.agentFilterUnassignedHelp"),
    },
  ];
  for (const agent of configuredAgents) {
    options.push({
      id: agent.id,
      label: agent.isDefault
        ? t("workboard.agentFilterConfiguredDefault", { agent: agent.label })
        : agent.label,
      ...(agent.isDefault ? { description: t("workboard.agentFilterConfiguredDefaultHelp") } : {}),
    });
  }
  for (const id of cardAgentIds) {
    options.push({
      id,
      label: t("workboard.agentCurrentUnconfigured", { agent: id }),
    });
  }
  return options;
}

function buildAssignableAgentOptions(agentsList: AgentsListResult | null, currentAgentId: string) {
  const configuredAgents = buildConfiguredAgentOptions(agentsList);
  const currentId = normalizeAgentOptionId(currentAgentId);
  const hasCurrent = currentId ? configuredAgents.some((agent) => agent.id === currentId) : true;
  return [
    {
      id: "",
      label: t("workboard.agentFilterUnassigned", {
        agent: defaultAgentFilterLabel(configuredAgents),
      }),
    },
    ...configuredAgents.map((agent) => ({
      id: agent.id,
      label: agent.isDefault
        ? t("workboard.agentFilterConfiguredDefault", { agent: agent.label })
        : agent.label,
    })),
    ...(hasCurrent
      ? []
      : [
          {
            id: currentId,
            label: t("workboard.agentCurrentUnconfigured", { agent: currentId }),
          },
        ]),
  ];
}

function normalizeActiveAgentFilter(
  options: readonly WorkboardAgentFilterOption[],
  filter: WorkboardUiState["agentFilter"],
): WorkboardUiState["agentFilter"] {
  return options.some((option) => option.id === filter) ? filter : "all";
}

let workboardSelectDocumentCloserInstalled = false;
const workboardSelectTypeahead = new WeakMap<
  HTMLDetailsElement,
  { query: string; resetTimer: number }
>();

function hasOpenWorkboardSelectMenus(root: ParentNode = document): boolean {
  return Boolean(root.querySelector(".workboard-select[open]"));
}

function handleWorkboardSelectDocumentPointer(event: PointerEvent) {
  const target = event.target;
  if (target instanceof Element && target.closest(".workboard-select")) {
    return;
  }
  closeWorkboardSelectMenus(document);
}

// Fixed menus must close when their anchor can move; menu scrolling itself
// remains available for long option lists.
function handleWorkboardSelectViewportChange(event: Event) {
  const target = event.target;
  if (target instanceof Element && target.closest(".workboard-select__menu")) {
    return;
  }
  closeWorkboardSelectMenus(document);
}

function syncWorkboardSelectDocumentCloser() {
  if (typeof document === "undefined") {
    return;
  }
  const shouldInstall = hasOpenWorkboardSelectMenus(document);
  if (shouldInstall && !workboardSelectDocumentCloserInstalled) {
    document.addEventListener("pointerdown", handleWorkboardSelectDocumentPointer, true);
    window.addEventListener("scroll", handleWorkboardSelectViewportChange, true);
    window.addEventListener("resize", handleWorkboardSelectViewportChange);
    workboardSelectDocumentCloserInstalled = true;
    return;
  }
  if (!shouldInstall && workboardSelectDocumentCloserInstalled) {
    document.removeEventListener("pointerdown", handleWorkboardSelectDocumentPointer, true);
    window.removeEventListener("scroll", handleWorkboardSelectViewportChange, true);
    window.removeEventListener("resize", handleWorkboardSelectViewportChange);
    workboardSelectDocumentCloserInstalled = false;
  }
}

function closeOtherWorkboardSelectMenus(details: HTMLDetailsElement) {
  if (!details.open) {
    return;
  }
  const root = details.closest(".workboard") ?? (details.getRootNode() as ParentNode);
  closeWorkboardSelectMenus(root, details);
}

function closeWorkboardSelectMenu(details: HTMLDetailsElement, restoreFocus = false) {
  const typeahead = workboardSelectTypeahead.get(details);
  if (typeahead) {
    window.clearTimeout(typeahead.resetTimer);
    workboardSelectTypeahead.delete(details);
  }
  details.open = false;
  if (restoreFocus) {
    const trigger = details.querySelector<HTMLElement>(".workboard-select__trigger");
    if (trigger) {
      focusElement(trigger);
    }
  }
}

function closeWorkboardSelectMenus(root: ParentNode, except?: HTMLDetailsElement) {
  for (const select of root.querySelectorAll<HTMLDetailsElement>(".workboard-select[open]")) {
    if (select === except) {
      continue;
    }
    closeWorkboardSelectMenu(select, select.contains(document.activeElement));
  }
  syncWorkboardSelectDocumentCloser();
}

function closeWorkboardSelectMenusOnOutsidePointer(event: Event) {
  const target = event.target;
  if (target instanceof Element && target.closest(".workboard-select")) {
    return;
  }
  closeWorkboardSelectMenus(event.currentTarget as ParentNode);
}

function positionWorkboardSelectMenu(details: HTMLDetailsElement) {
  const trigger = details.querySelector<HTMLElement>(".workboard-select__trigger");
  const menu = details.querySelector<HTMLElement>(".workboard-select__menu");
  if (!trigger || !menu) {
    return;
  }
  if (!details.open) {
    menu.style.removeProperty("--workboard-select-menu-left");
    menu.style.removeProperty("--workboard-select-menu-top");
    menu.style.removeProperty("--workboard-select-menu-width");
    menu.style.removeProperty("--workboard-select-menu-max-height");
    menu.style.visibility = "hidden";
    return;
  }
  const rect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const gutter = 12;
  const gap = 6;
  const width = Math.max(180, Math.min(rect.width, viewportWidth - gutter * 2));
  const left = Math.min(Math.max(gutter, rect.left), viewportWidth - width - gutter);
  const availableBelow = viewportHeight - rect.bottom - gutter - gap;
  const availableAbove = rect.top - gutter - gap;
  const openAbove = availableBelow < 220 && availableAbove > availableBelow;
  const maxHeight = Math.max(140, Math.min(320, openAbove ? availableAbove : availableBelow));
  menu.style.setProperty("--workboard-select-menu-left", `${left}px`);
  menu.style.setProperty("--workboard-select-menu-width", `${width}px`);
  menu.style.setProperty("--workboard-select-menu-max-height", `${maxHeight}px`);
  const renderedHeight = Math.min(
    maxHeight,
    menu.getBoundingClientRect().height || menu.scrollHeight || maxHeight,
  );
  const top = openAbove
    ? Math.max(gutter, rect.top - gap - renderedHeight)
    : Math.min(rect.bottom + gap, viewportHeight - gutter - maxHeight);

  menu.style.setProperty("--workboard-select-menu-top", `${top}px`);
  menu.style.visibility = "visible";
}

function getEnabledWorkboardSelectOptions(details: HTMLDetailsElement): HTMLButtonElement[] {
  return [
    ...details.querySelectorAll<HTMLButtonElement>(".workboard-select__option:not(:disabled)"),
  ];
}

function focusWorkboardSelectOption(details: HTMLDetailsElement, option: HTMLButtonElement) {
  if (!details.open) {
    details.open = true;
    closeOtherWorkboardSelectMenus(details);
    positionWorkboardSelectMenu(details);
    syncWorkboardSelectDocumentCloser();
  }
  focusElement(option);
  option.scrollIntoView?.({ block: "nearest" });
}

function focusRelativeWorkboardSelectOption(
  details: HTMLDetailsElement,
  direction: "first" | "last" | "next" | "previous",
) {
  const options = getEnabledWorkboardSelectOptions(details);
  if (options.length === 0) {
    return;
  }
  const activeIndex = options.indexOf(document.activeElement as HTMLButtonElement);
  const selectedIndex = options.findIndex(
    (option) => option.getAttribute("aria-selected") === "true",
  );
  let nextIndex = Math.max(selectedIndex, 0);
  if (direction === "first") {
    nextIndex = 0;
  } else if (direction === "last") {
    nextIndex = options.length - 1;
  } else if (activeIndex >= 0) {
    nextIndex =
      direction === "next"
        ? (activeIndex + 1) % options.length
        : (activeIndex - 1 + options.length) % options.length;
  }
  focusWorkboardSelectOption(details, options[nextIndex] ?? options[0]);
}

function focusWorkboardSelectTypeaheadOption(details: HTMLDetailsElement, key: string) {
  const previous = workboardSelectTypeahead.get(details);
  if (previous) {
    window.clearTimeout(previous.resetTimer);
  }
  const normalizedKey = key.toLocaleLowerCase();
  const accumulatedQuery = `${previous?.query ?? ""}${normalizedKey}`;
  const query =
    accumulatedQuery === normalizedKey.repeat(accumulatedQuery.length)
      ? normalizedKey
      : accumulatedQuery;
  const resetTimer = window.setTimeout(() => workboardSelectTypeahead.delete(details), 500);
  workboardSelectTypeahead.set(details, { query, resetTimer });

  const options = getEnabledWorkboardSelectOptions(details);
  const activeIndex = options.indexOf(document.activeElement as HTMLButtonElement);
  const ordered = [...options.slice(activeIndex + 1), ...options.slice(0, activeIndex + 1)];
  const match = ordered.find((option) =>
    option
      .querySelector(".workboard-select__label")
      ?.textContent?.trim()
      .toLocaleLowerCase()
      .startsWith(query),
  );
  if (match) {
    focusWorkboardSelectOption(details, match);
  }
}

function handleWorkboardSelectKeydown(event: KeyboardEvent) {
  const details = event.currentTarget as HTMLDetailsElement;
  const target = event.target;
  const trigger = details.querySelector<HTMLElement>(".workboard-select__trigger");
  if (event.key === "Escape" && details.open) {
    closeWorkboardSelectMenu(details, true);
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (target === trigger && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    if (details.open) {
      closeWorkboardSelectMenu(details, true);
    } else {
      focusRelativeWorkboardSelectOption(details, "next");
    }
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    focusRelativeWorkboardSelectOption(details, event.key === "ArrowDown" ? "next" : "previous");
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    focusRelativeWorkboardSelectOption(details, event.key === "Home" ? "first" : "last");
    return;
  }
  if (target instanceof HTMLButtonElement && event.key === " ") {
    return;
  }
  if (
    event.key.length === 1 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    focusWorkboardSelectTypeaheadOption(details, event.key);
  }
}

function renderWorkboardSelect<Value extends string>(params: {
  value: Value;
  options: readonly WorkboardSelectOption<Value>[];
  label: string;
  onChange: (value: Value) => void;
  requestUpdate?: () => void;
  className?: string;
  showLabel?: boolean;
}) {
  const selected = params.options.find((option) => option.value === params.value);
  const selectedLabel = selected?.label ?? params.value;
  const select = html`
    <details
      class="workboard-select ${params.className ?? ""}"
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
        closeOtherWorkboardSelectMenus(details);
        positionWorkboardSelectMenu(details);
        syncWorkboardSelectDocumentCloser();
      }}
      @keydown=${handleWorkboardSelectKeydown}
      @focusout=${(event: FocusEvent) => {
        const details = event.currentTarget as HTMLDetailsElement;
        if (!(event.relatedTarget instanceof Node) || !details.contains(event.relatedTarget)) {
          closeWorkboardSelectMenu(details);
        }
      }}
    >
      <summary
        class="input workboard-select__trigger"
        aria-label=${`${params.label}: ${selectedLabel}`}
        aria-haspopup="listbox"
      >
        <span class="workboard-select__value">${selectedLabel}</span>
        <span class="workboard-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
      </summary>
      <div class="workboard-select__menu" role="listbox" aria-label=${params.label}>
        ${params.options.map((option) => {
          const optionSelected = option.value === params.value;
          return html`
            <button
              class="workboard-select__option ${optionSelected ? "is-selected" : ""}"
              type="button"
              role="option"
              tabindex="-1"
              aria-selected=${optionSelected}
              aria-disabled=${option.disabled === true}
              ?disabled=${option.disabled}
              @click=${(event: Event) => {
                if (option.disabled) {
                  return;
                }
                params.onChange(option.value);
                const details = (event.currentTarget as HTMLElement).closest("details");
                if (details) {
                  closeWorkboardSelectMenu(details, true);
                }
                params.requestUpdate?.();
              }}
            >
              <span class="workboard-select__check" aria-hidden="true">
                ${optionSelected ? icons.check : nothing}
              </span>
              <span class="workboard-select__copy">
                <span class="workboard-select__label">${option.label}</span>
                ${option.description
                  ? html`<span class="workboard-select__description">${option.description}</span>`
                  : nothing}
              </span>
            </button>
          `;
        })}
      </div>
    </details>
  `;
  if (params.showLabel === false) {
    return select;
  }
  return html`
    <div class="workboard-field">
      <span>${params.label}</span>
      ${select}
    </div>
  `;
}

function engineDisplayName(engine: WorkboardExecutionEngine): string {
  return engine === "codex" ? t("workboard.engineOpenAI") : t("workboard.engineClaude");
}

function engineBlockedByRuntime(
  props: WorkboardProps,
  card: WorkboardCard,
  engine: WorkboardExecutionEngine | null,
): string | null {
  if (!engine) {
    return null;
  }
  const agent = findCardAgent(card, props.agentsList);
  const runtime = agent?.agentRuntime?.id?.trim();
  if (!runtime) {
    return null;
  }
  const normalized = runtime.toLowerCase();
  if (normalized === "openclaw" || normalized === "pi") {
    return null;
  }
  return t("workboard.engineDisabledRuntime", {
    agent: agentDisplayName(agent, card.agentId ?? t("workboard.defaultAgent")),
    runtime,
  });
}

function renderAgentChip(props: WorkboardProps, card: WorkboardCard) {
  const label = cardAgentLabel(card, props.agentsList);
  const title = card.agentId
    ? t("workboard.agentLinked", { agent: label })
    : t("workboard.agentDefaultLinked", { agent: label });
  return html`<span class="workboard-agent-chip" title=${title}>${label}</span>`;
}

function renderEngineMark(engine: WorkboardExecutionEngine) {
  return html`
    <span class="workboard-engine-mark workboard-engine-mark--${engine}" aria-hidden="true">
      ${engine === "codex" ? "OpenAI" : "Claude"}
    </span>
  `;
}

function moveCardToStatus(
  props: WorkboardProps,
  card: WorkboardCard,
  status: WorkboardStatus,
  state: WorkboardUiState,
) {
  if (
    status === card.status ||
    state.busyCardIds.has(card.id) ||
    state.dispatching ||
    !props.connected ||
    !props.client
  ) {
    return;
  }
  void moveWorkboardCard({
    host: props.host,
    client: props.client,
    cardId: card.id,
    status,
    position: nextPosition(state.cards, status),
    requestUpdate: props.onRequestUpdate,
  });
}

function renderCardMoveControl(
  props: WorkboardProps,
  card: WorkboardCard,
  busy: boolean,
  options: { wide?: boolean } = {},
) {
  const state = getWorkboardState(props.host);
  const statuses = state.statuses.includes(card.status)
    ? state.statuses
    : [card.status, ...state.statuses];
  if (statuses.length < 2) {
    return nothing;
  }
  return html`
    <label
      class="workboard-card__move ${options.wide ? "workboard-card__move--wide" : ""}"
      title=${t("workboard.fieldStatus")}
    >
      <span class="workboard-card__move-icon" aria-hidden="true">${icons.cornerDownRight}</span>
      <select
        class="workboard-card__move-select"
        aria-keyshortcuts="ArrowLeft ArrowRight"
        aria-label=${`${t("workboard.fieldStatus")}: ${card.title}`}
        .value=${card.status}
        ?disabled=${busy || !props.connected || !props.client}
        @change=${(event: Event) => {
          const target = event.currentTarget as HTMLSelectElement;
          moveCardToStatus(props, card, target.value as WorkboardStatus, state);
        }}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
            return;
          }
          if (
            state.busyCardIds.has(card.id) ||
            state.dispatching ||
            !props.connected ||
            !props.client
          ) {
            event.preventDefault();
            return;
          }
          const currentIndex = statuses.indexOf(card.status);
          const offset = event.key === "ArrowRight" ? 1 : -1;
          const status = statuses[currentIndex + offset];
          if (!status) {
            return;
          }
          event.preventDefault();
          moveCardToStatus(props, card, status, state);
        }}
      >
        ${statuses.map(
          (status) =>
            html`<option value=${status} ?selected=${status === card.status}>
              ${formatStatusLabel(status)}
            </option>`,
        )}
      </select>
    </label>
  `;
}

function renderCardActionSlot(content: TemplateResult | typeof nothing) {
  return html`
    <span class="workboard-card__action-slot">
      ${content === nothing
        ? html`<span class="workboard-card__action-placeholder" aria-hidden="true"></span>`
        : content}
    </span>
  `;
}

function getCardActionState(props: WorkboardProps, card: WorkboardCard) {
  const state = getWorkboardState(props.host);
  const task = state.tasksByCardId.get(card.id);
  const session = findWorkboardSession(card, props.sessions);
  const busy = state.busyCardIds.has(card.id) || state.dispatching;
  const activeTask = cardHasActiveOrRunningUnresolvedTask(card, task, state.missingTaskIds);
  const writable = canMutate(props);
  const live =
    activeTask ||
    cardHasUnresolvedStartedRun(card) ||
    session?.hasActiveRun === true ||
    (session?.hasActiveRun !== false && session?.status === "running");
  return {
    state,
    task,
    session,
    busy,
    activeTask,
    live,
    linkedSessionKey: card.sessionKey ?? card.execution?.sessionKey,
    writable,
    showStartControls: writable && cardCanStart(state, props.sessions, card),
    archived: Boolean(card.metadata?.archivedAt),
  };
}

function renderCardActionButton(params: {
  label: string;
  icon: TemplateResult;
  iconOnly?: boolean;
  className?: string;
  disabled?: boolean;
  ariaHaspopup?: "dialog";
  onClick: (event: MouseEvent) => void;
}) {
  const button = html`
    <button
      class=${params.iconOnly
        ? `btn btn--icon workboard-card__icon ${params.className ?? ""}`
        : `btn ${params.className ?? ""}`}
      type="button"
      aria-label=${params.label}
      aria-haspopup=${params.ariaHaspopup ?? nothing}
      ?disabled=${params.disabled}
      @click=${params.onClick}
    >
      ${params.icon}${params.iconOnly ? nothing : html`<span>${params.label}</span>`}
    </button>
  `;
  return params.iconOnly
    ? html`<openclaw-tooltip .content=${params.label}>${button}</openclaw-tooltip>`
    : button;
}

function renderEditCardAction(
  props: WorkboardProps,
  card: WorkboardCard,
  options: { iconOnly?: boolean } = {},
) {
  const state = getWorkboardState(props.host);
  return renderCardActionButton({
    label: t("workboard.editCard"),
    icon: icons.edit,
    iconOnly: options.iconOnly,
    ariaHaspopup: "dialog",
    disabled: state.dispatching,
    onClick: (event) => {
      rememberWorkboardReturnFocus(event.currentTarget);
      openEditModal(state, card);
      props.onRequestUpdate?.();
    },
  });
}

function renderArchiveCardAction(
  props: WorkboardProps,
  card: WorkboardCard,
  busy: boolean,
  archived: boolean,
  options: { iconOnly?: boolean } = {},
) {
  const label = archived ? t("workboard.unarchiveCard") : t("workboard.archiveCard");
  return renderCardActionButton({
    label,
    icon: archived ? icons.archiveRestore : icons.archive,
    iconOnly: options.iconOnly,
    disabled: busy,
    onClick: () => {
      void archiveWorkboardCard({
        host: props.host,
        client: props.client,
        cardId: card.id,
        archived: !archived,
        requestUpdate: props.onRequestUpdate,
      });
    },
  });
}

function renderOpenSessionCardAction(
  props: WorkboardProps,
  linkedSessionKey: string | undefined,
  options: { iconOnly?: boolean } = {},
) {
  if (!linkedSessionKey) {
    return nothing;
  }
  return renderCardActionButton({
    label: t("workboard.openSession"),
    icon: icons.messageSquare,
    iconOnly: options.iconOnly,
    onClick: () => props.onOpenSession(linkedSessionKey),
  });
}

function renderStopCardAction(
  props: WorkboardProps,
  card: WorkboardCard,
  busy: boolean,
  options: { iconOnly?: boolean } = {},
) {
  return renderCardActionButton({
    label: t("workboard.stopSession"),
    icon: icons.stop,
    iconOnly: options.iconOnly,
    disabled: busy || !props.connected,
    onClick: () => {
      void stopWorkboardCard({
        host: props.host,
        client: props.client,
        card,
        requestUpdate: props.onRequestUpdate,
      });
    },
  });
}

function renderDeleteCardAction(
  props: WorkboardProps,
  card: WorkboardCard,
  busy: boolean,
  options: { iconOnly?: boolean } = {},
) {
  return renderCardActionButton({
    label: t("workboard.deleteCard"),
    icon: icons.trash,
    iconOnly: options.iconOnly,
    className: "workboard-card__delete",
    disabled: busy,
    onClick: () => {
      void deleteWorkboardCard({
        host: props.host,
        client: props.client,
        cardId: card.id,
        requestUpdate: props.onRequestUpdate,
      });
    },
  });
}

function openCardDetails(state: WorkboardUiState, card: WorkboardCard) {
  state.detailCardId = card.id;
  state.detailCommentBody = "";
}

function closeCardDetails(state: WorkboardUiState) {
  state.detailCardId = null;
  state.detailCommentBody = "";
}

function getVisibleDetailCard(state: WorkboardUiState): WorkboardCard | null {
  if (!state.detailCardId || state.draftOpen) {
    return null;
  }
  const card = state.cards.find((entry) => entry.id === state.detailCardId) ?? null;
  if (!card || (card.metadata?.archivedAt && !state.showArchived)) {
    return null;
  }
  return card;
}

function resetDraft(state: WorkboardUiState) {
  const resolveStaleEdit = state.loaded && state.mutationReadiness === "stale_edit_draft";
  state.draftOpen = false;
  state.editingCardId = null;
  state.draftTitle = "";
  state.draftNotes = "";
  state.draftStatus = "todo";
  state.draftPriority = "normal";
  state.draftLabels = "";
  state.draftAgentId = "";
  state.draftSessionKey = "";
  state.draftTemplateId = "";
  state.draftCommentBody = "";
  if (resolveStaleEdit) {
    state.mutationReadiness = "ready";
  }
}

function openCreateModal(state: WorkboardUiState) {
  resetDraft(state);
  state.draftOpen = true;
}

function openEditModal(state: WorkboardUiState, card: WorkboardCard) {
  state.draftOpen = true;
  state.editingCardId = card.id;
  state.draftTitle = card.title;
  state.draftNotes = card.notes ?? "";
  state.draftStatus = card.status;
  state.draftPriority = card.priority;
  state.draftLabels = card.labels.join(", ");
  state.draftAgentId = card.agentId ?? "";
  state.draftSessionKey = card.sessionKey ?? "";
  state.draftTemplateId = card.metadata?.templateId ?? "";
  state.draftCommentBody = "";
}

function applyTemplate(state: WorkboardUiState, templateId: WorkboardTemplateId) {
  const template = WORKBOARD_TEMPLATES.find((entry) => entry.id === templateId);
  if (!template) {
    return;
  }
  state.draftTemplateId = template.id;
  state.draftTitle = template.title;
  state.draftNotes = template.notes;
  state.draftLabels = template.labels;
  state.draftPriority = template.priority;
}

function renderCardModal(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const agentOptions = buildAssignableAgentOptions(props.agentsList, state.draftAgentId);
  const sessions = props.sessions.filter(isWorkboardSessionChoice);
  const statusOptions: WorkboardSelectOption<WorkboardStatus>[] = state.statuses.map((status) => ({
    value: status,
    label: formatStatusLabel(status),
  }));
  const priorityOptions: WorkboardSelectOption<WorkboardPriority>[] = WORKBOARD_PRIORITIES.map(
    (priority) => ({ value: priority, label: formatPriorityLabel(priority) }),
  );
  const assignableAgentOptions: WorkboardSelectOption[] = agentOptions.map((agent) => ({
    value: agent.id,
    label: agent.label,
  }));
  const sessionOptions: WorkboardSelectOption[] = [
    { value: "", label: t("workboard.noLinkedSession") },
    ...sessions.map((session) => ({
      value: session.key,
      label: session.displayName ?? session.label ?? session.key,
    })),
  ];
  if (!state.draftOpen) {
    return nothing;
  }
  const editing = Boolean(state.editingCardId);
  const editingCard = state.editingCardId
    ? (state.cards.find((card) => card.id === state.editingCardId) ?? null)
    : null;
  const comments = editingCard?.metadata?.comments ?? [];
  const draftCommentBusy = editing && state.busyCardIds.has(state.editingCardId ?? "");
  const draftActionsBusy =
    !canMutate(props) || state.loading || state.dispatching || draftCommentBusy;
  return html`
    <div
      class="workboard-modal"
      role="presentation"
      @click=${(event: MouseEvent) => {
        if (event.target === event.currentTarget) {
          resetDraft(state);
          props.onRequestUpdate?.();
        }
      }}
    >
      <form
        id=${workboardCardModalId}
        class="workboard-draft"
        role="dialog"
        aria-modal="true"
        aria-labelledby=${workboardCardModalTitleId}
        aria-describedby=${workboardCardModalDescriptionId}
        tabindex="-1"
        ${ref((element) => syncWorkboardDialog(element, "[data-workboard-autofocus='true']"))}
        @keydown=${(event: KeyboardEvent) =>
          handleWorkboardDialogKeydown(event, props, () => resetDraft(state))}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          if (draftActionsBusy) {
            return;
          }
          void saveWorkboardCardDraft({
            host: props.host,
            client: props.client,
            requestUpdate: props.onRequestUpdate,
          });
        }}
      >
        <div class="workboard-modal__header">
          <div>
            <h2 id=${workboardCardModalTitleId}>
              ${editing ? t("workboard.editCard") : t("workboard.newCard")}
            </h2>
            <p id=${workboardCardModalDescriptionId}>
              ${editing ? t("workboard.editCardHelp") : t("workboard.newCardHelp")}
            </p>
          </div>
          <openclaw-tooltip .content=${t("common.cancel")}>
            <button
              class="btn btn--icon workboard-card__icon"
              type="button"
              aria-label=${t("common.cancel")}
              @click=${() => {
                resetDraft(state);
                props.onRequestUpdate?.();
              }}
            >
              ${icons.x}
            </button>
          </openclaw-tooltip>
        </div>
        <div class="workboard-draft__body">
          ${!editing
            ? html`
                <div class="workboard-template-strip" aria-label=${t("workboard.templatesLabel")}>
                  ${WORKBOARD_TEMPLATES.map(
                    (template) => html`
                      <button
                        class="btn btn--xs ${state.draftTemplateId === template.id
                          ? "workboard-template-strip__button--active"
                          : ""}"
                        type="button"
                        @click=${() => {
                          applyTemplate(state, template.id);
                          props.onRequestUpdate?.();
                        }}
                      >
                        ${t(`workboard.template.${template.id}`)}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing}
          <div class="workboard-draft__main">
            <label class="workboard-field">
              <span>${t("workboard.fieldTitle")}</span>
              <input
                class="input workboard-draft__title"
                data-workboard-autofocus="true"
                placeholder=${t("workboard.titlePlaceholder")}
                .value=${state.draftTitle}
                @input=${(event: InputEvent) => {
                  state.draftTitle = (event.currentTarget as HTMLInputElement).value;
                  props.onRequestUpdate?.();
                }}
              />
            </label>
            <label class="workboard-field">
              <span>${t("workboard.fieldNotes")}</span>
              <textarea
                class="input workboard-draft__notes"
                placeholder=${t("workboard.notesPlaceholder")}
                .value=${state.draftNotes}
                @input=${(event: InputEvent) => {
                  state.draftNotes = (event.currentTarget as HTMLTextAreaElement).value;
                  props.onRequestUpdate?.();
                }}
              ></textarea>
            </label>
          </div>
          <div class="workboard-draft__meta">
            ${renderWorkboardSelect({
              value: state.draftStatus,
              options: statusOptions,
              label: t("workboard.fieldStatus"),
              onChange: (value) => {
                state.draftStatus = value;
              },
              requestUpdate: props.onRequestUpdate,
            })}
            ${renderWorkboardSelect({
              value: state.draftPriority,
              options: priorityOptions,
              label: t("workboard.fieldPriority"),
              onChange: (value) => {
                state.draftPriority = value;
              },
              requestUpdate: props.onRequestUpdate,
            })}
            ${renderWorkboardSelect({
              value: state.draftAgentId,
              options: assignableAgentOptions,
              label: t("workboard.fieldAgent"),
              onChange: (value) => {
                state.draftAgentId = value;
              },
              requestUpdate: props.onRequestUpdate,
            })}
            ${renderWorkboardSelect({
              value: state.draftSessionKey,
              options: sessionOptions,
              label: t("workboard.fieldSession"),
              onChange: (value) => {
                state.draftSessionKey = value;
              },
              requestUpdate: props.onRequestUpdate,
            })}
            <label class="workboard-field workboard-field--wide">
              <span>${t("workboard.fieldLabels")}</span>
              <input
                class="input"
                placeholder=${t("workboard.labelsPlaceholder")}
                .value=${state.draftLabels}
                @input=${(event: InputEvent) => {
                  state.draftLabels = (event.currentTarget as HTMLInputElement).value;
                  props.onRequestUpdate?.();
                }}
              />
            </label>
          </div>
          ${editing
            ? html`
                <section
                  class="workboard-field workboard-field--wide"
                  aria-labelledby="workboard-card-comments-title"
                >
                  <span id="workboard-card-comments-title">
                    ${t("workboard.badgeComments", { count: String(comments.length) })}
                  </span>
                  ${comments.length
                    ? html`
                        <ol>
                          ${comments.map((comment) => html`<li>${comment.body}</li>`)}
                        </ol>
                      `
                    : nothing}
                  <textarea
                    class="input workboard-comments__input"
                    aria-labelledby="workboard-card-comments-title"
                    maxlength="2000"
                    .value=${state.draftCommentBody}
                    @input=${(event: InputEvent) => {
                      state.draftCommentBody = (event.currentTarget as HTMLTextAreaElement).value;
                      props.onRequestUpdate?.();
                    }}
                  ></textarea>
                  <div class="workboard-modal__actions">
                    <button
                      class="btn"
                      type="button"
                      ?disabled=${draftActionsBusy || !state.draftCommentBody.trim()}
                      @click=${() => {
                        void addWorkboardCardComment({
                          host: props.host,
                          client: props.client,
                          requestUpdate: props.onRequestUpdate,
                        });
                      }}
                    >
                      ${icons.plus} ${t("common.create")}
                    </button>
                  </div>
                </section>
              `
            : nothing}
        </div>
        <div class="workboard-modal__actions">
          <button class="btn primary" ?disabled=${draftActionsBusy || !state.draftTitle.trim()}>
            ${editing ? t("common.save") : t("common.create")}
          </button>
          <button
            class="btn"
            type="button"
            @click=${() => {
              resetDraft(state);
              props.onRequestUpdate?.();
            }}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </form>
    </div>
  `;
}

function formatLifecycle(lifecycle: WorkboardLifecycle): {
  label: string;
  detail: string;
  tone: "blocked" | "done" | "idle" | "live";
} {
  switch (lifecycle.state) {
    case "running":
      return {
        label: t("workboard.lifecycleRunning"),
        detail: t("workboard.lifecycleRunningDetail"),
        tone: "live",
      };
    case "succeeded":
      return {
        label: t("workboard.lifecycleDone"),
        detail: t("workboard.lifecycleDoneDetail"),
        tone: "done",
      };
    case "failed":
      return {
        label: t("workboard.lifecycleNeedsReview"),
        detail: t("workboard.lifecycleNeedsReviewDetail"),
        tone: "blocked",
      };
    case "stale":
      return {
        label: t("workboard.lifecycleStale"),
        detail: t("workboard.lifecycleStaleDetail"),
        tone: "blocked",
      };
    case "idle":
      return {
        label: t("workboard.lifecycleLinked"),
        detail: t("workboard.lifecycleIdleDetail"),
        tone: "idle",
      };
    case "missing":
      return {
        label: t("workboard.lifecycleMissing"),
        detail: t("workboard.lifecycleMissingDetail"),
        tone: "blocked",
      };
    case "unlinked":
      return {
        label: t("workboard.lifecycleUnlinked"),
        detail: t("workboard.lifecycleUnlinkedDetail"),
        tone: "idle",
      };
  }
  throw new Error("Unknown workboard lifecycle state.");
}

function taskDetail(task: WorkboardTaskSummary): string {
  if (task.status === "queued" || task.status === "running") {
    return task.progressSummary ?? task.title ?? task.taskId;
  }
  return task.terminalSummary ?? task.error ?? task.progressSummary ?? task.title ?? task.taskId;
}

function taskMatchesLifecycle(task: WorkboardTaskSummary, lifecycle: WorkboardLifecycle): boolean {
  switch (task.status) {
    case "queued":
    case "running":
      return lifecycle.state === "running";
    case "completed":
      return lifecycle.state === "succeeded";
    case "failed":
    case "cancelled":
    case "timed_out":
      return lifecycle.state === "failed";
  }
  return false;
}

function taskIsActive(task: WorkboardTaskSummary | undefined): boolean {
  return task?.status === "queued" || task?.status === "running";
}

function cardHasUnresolvedTaskLink(
  card: WorkboardCard,
  task: WorkboardTaskSummary | undefined,
  missingTaskIds: ReadonlySet<string>,
): boolean {
  return Boolean(card.taskId && !task && !missingTaskIds.has(card.taskId));
}

function cardHasActiveOrRunningUnresolvedTask(
  card: WorkboardCard,
  task: WorkboardTaskSummary | undefined,
  missingTaskIds: ReadonlySet<string>,
): boolean {
  return (
    taskIsActive(task) ||
    (card.status === "running" && cardHasUnresolvedTaskLink(card, task, missingTaskIds))
  );
}

function cardHasUnresolvedStartedRun(card: WorkboardCard): boolean {
  const sessionKey = card.sessionKey ?? card.execution?.sessionKey;
  const runId = card.runId ?? card.execution?.runId;
  return card.status === "running" && Boolean(sessionKey && runId);
}

function cardCanStart(
  state: WorkboardUiState,
  sessions: readonly GatewaySessionRow[],
  card: WorkboardCard,
): boolean {
  const task = state.tasksByCardId.get(card.id);
  const session = findWorkboardSession(card, sessions);
  const taskBlocksStart =
    taskIsActive(task) || cardHasUnresolvedTaskLink(card, task, state.missingTaskIds);
  const linkedSessionKey = card.sessionKey ?? card.execution?.sessionKey;
  return !taskBlocksStart && !cardHasUnresolvedStartedRun(card) && (!linkedSessionKey || !session);
}

function formatDependencyParent(parent: WorkboardDependencyState["parents"][number]): string {
  if (parent.missing) {
    return t("workboard.dependencyMissing", { parent: parent.title });
  }
  const status = parent.status ? formatStatusLabel(parent.status) : t("workboard.unknownStatus");
  return `${parent.title} (${status})`;
}

function formatDependencyBlockerTitle(dependencies: WorkboardDependencyState): string | null {
  if (dependencies.blockedParents.length === 0) {
    return null;
  }
  return t("workboard.dependenciesBlockedTitle", {
    parents: dependencies.blockedParents.map(formatDependencyParent).join(", "),
  });
}

function renderDependencyBadges(dependencies: WorkboardDependencyState) {
  if (dependencies.parents.length === 0) {
    return nothing;
  }
  const blocked = dependencies.blockedParents.length;
  const title =
    formatDependencyBlockerTitle(dependencies) ??
    t("workboard.dependenciesReadyTitle", {
      count: String(dependencies.parents.length),
    });
  return html`
    <div class="workboard-dependencies" title=${title}>
      ${blocked > 0
        ? html`
            <span class="workboard-dependency workboard-dependency--blocked">
              ${icons.alertTriangle}${t("workboard.dependenciesBlocked", {
                count: String(blocked),
              })}
            </span>
          `
        : html`
            <span class="workboard-dependency workboard-dependency--ready">
              ${t("workboard.dependenciesReady", { count: String(dependencies.parents.length) })}
            </span>
          `}
    </div>
  `;
}

function renderDependencyDetailList(dependencies: WorkboardDependencyState) {
  if (dependencies.parents.length === 0) {
    return nothing;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${t("workboard.dependencies")}</h3>
      <ul class="workboard-detail__list workboard-detail__dependencies">
        ${dependencies.parents.map(
          (parent) => html`
            <li class=${parent.done ? "is-done" : "is-blocked"}>
              ${parent.done
                ? html`<span class="workboard-detail__dependency-spacer"></span>`
                : icons.alertTriangle}
              <span>${parent.title}</span>
              <span>
                ${parent.missing
                  ? t("workboard.dependencyStatusMissing")
                  : parent.status
                    ? formatStatusLabel(parent.status)
                    : t("workboard.unknownStatus")}
              </span>
            </li>
          `,
        )}
      </ul>
    </section>
  `;
}

function renderLifecycle(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
  task?: WorkboardTaskSummary,
) {
  const lifecycle = getWorkboardLifecycle(card, sessions, task);
  const formatted = formatLifecycle(lifecycle);
  const session = lifecycle.session;
  const execution = card.execution;
  const stale = lifecycle.state === "stale";
  const taskIsAuthoritative = task ? taskMatchesLifecycle(task, lifecycle) : false;
  const taskStatus = task && taskIsAuthoritative ? t(`workboard.taskStatus.${task.status}`) : null;
  return html`
    <div class="workboard-card__lifecycle">
      <span class="workboard-lifecycle workboard-lifecycle--${formatted.tone}">
        ${taskStatus ??
        (stale || !execution ? formatted.label : `${execution.engine} ${execution.mode}`)}
      </span>
      <span class="workboard-card__lifecycle-detail">
        ${task && taskIsAuthoritative
          ? taskDetail(task)
          : stale
            ? formatted.detail
            : (session?.displayName ?? session?.label ?? formatted.detail)}
      </span>
    </div>
  `;
}

function renderStartExecutionButton(
  props: WorkboardProps,
  card: WorkboardCard,
  engine: WorkboardExecutionEngine | null,
  mode: WorkboardExecutionMode,
  options: { iconOnly?: boolean } = {},
) {
  const state = getWorkboardState(props.host);
  const busy = state.busyCardIds.has(card.id) || state.dispatching;
  const runtimeBlock = engineBlockedByRuntime(props, card, engine);
  const disabled =
    busy || !props.connected || Boolean(runtimeBlock) || Boolean(card.metadata?.archivedAt);
  const title = runtimeBlock
    ? runtimeBlock
    : engine
      ? mode === "autonomous"
        ? t("workboard.runEngine", { engine: engineDisplayName(engine) })
        : t("workboard.openEngine", { engine: engineDisplayName(engine) })
      : t("workboard.runDefaultAgent");
  const button = html`
    <button
      class="btn btn--xs workboard-card__start workboard-card__start--${mode} ${options.iconOnly
        ? "workboard-card__start--icon"
        : ""} ${engine ? "" : "workboard-card__start--default"}"
      type="button"
      aria-label=${title}
      ?disabled=${disabled}
      @click=${async () => {
        const key = await startWorkboardCard({
          host: props.host,
          client: props.client,
          card,
          ...(engine ? { engine } : {}),
          mode,
          requestUpdate: props.onRequestUpdate,
        });
        if (key) {
          props.onOpenSession(key);
        }
      }}
    >
      ${engine
        ? html`${renderEngineMark(engine)}${options.iconOnly
            ? nothing
            : html`<span
                >${mode === "autonomous" ? t("workboard.run") : t("workboard.open")}</span
              >`}`
        : html`${mode === "autonomous" ? icons.play : icons.penLine}${options.iconOnly
            ? nothing
            : html`<span>${t("workboard.start")}</span>`}`}
    </button>
  `;
  return options.iconOnly
    ? html`<openclaw-tooltip .content=${title}>${button}</openclaw-tooltip>`
    : button;
}

function renderStartExecutionControls(props: WorkboardProps, card: WorkboardCard) {
  const canModelOverride = props.canModelOverride !== false;
  return html`
    <div class="workboard-card__execution-controls">
      ${renderStartExecutionButton(props, card, null, "autonomous")}
      ${canModelOverride
        ? html`${renderStartExecutionButton(props, card, "codex", "autonomous")}
          ${renderStartExecutionButton(props, card, "claude", "autonomous")}`
        : nothing}
      ${renderStartExecutionButton(props, card, "codex", "manual")}
      ${renderStartExecutionButton(props, card, "claude", "manual")}
    </div>
  `;
}

function renderDetailRow(label: string, value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return nothing;
  }
  const text = String(value).trim();
  if (!text) {
    return nothing;
  }
  return html`
    <div class="workboard-detail__row">
      <span>${label}</span>
      <strong>${text}</strong>
    </div>
  `;
}

function renderDetailList(
  title: string,
  values: readonly string[],
  empty: string | typeof nothing = nothing,
) {
  const entries = values
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(-6);
  if (entries.length === 0) {
    return empty;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${title}</h3>
      <ol class="workboard-detail__list">
        ${entries.map((entry) => html`<li>${entry}</li>`)}
      </ol>
    </section>
  `;
}

function renderCardDetailsPanel(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const card = getVisibleDetailCard(state);
  if (!card) {
    return nothing;
  }
  const cardActions = getCardActionState(props, card);
  const { task, busy, activeTask, live, linkedSessionKey, writable, showStartControls, archived } =
    cardActions;
  const lifecycle = getWorkboardLifecycle(card, props.sessions, task);
  const formatted = formatLifecycle(lifecycle);
  const taskIsAuthoritative = task ? taskMatchesLifecycle(task, lifecycle) : false;
  const comments = card.metadata?.comments ?? [];
  const attempts = card.metadata?.attempts ?? [];
  const links = card.metadata?.links ?? [];
  const proof = card.metadata?.proof ?? [];
  const artifacts = card.metadata?.artifacts ?? [];
  const attachments = card.metadata?.attachments ?? [];
  const diagnostics = card.metadata?.diagnostics ?? [];
  const workerLogs = card.metadata?.workerLogs ?? [];
  const workerProtocol = card.metadata?.workerProtocol;
  const automation = card.metadata?.automation;
  const events = (card.events ?? []).slice(-6).toReversed();
  const dependencies = getWorkboardDependencyState(card, state.cards);
  return html`
    <aside
      id=${workboardCardDetailDrawerId}
      class="workboard-detail-drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby=${workboardCardDetailTitleId}
      aria-describedby=${workboardCardDetailDescriptionId}
      tabindex="-1"
      ${ref((element) => syncWorkboardDialog(element))}
      @keydown=${(event: KeyboardEvent) =>
        handleWorkboardDialogKeydown(event, props, () => closeCardDetails(state))}
    >
      <div class="workboard-detail">
        <header class="workboard-detail__header">
          <div>
            <span class="workboard-card__priority">${formatPriorityLabel(card.priority)}</span>
            <h2 id=${workboardCardDetailTitleId}>
              <span class="workboard-sr-only">${t("workboard.detailTitle")}: </span>${card.title}
            </h2>
          </div>
          <openclaw-tooltip .content=${t("common.cancel")}>
            <button
              class="btn btn--icon workboard-card__icon"
              type="button"
              aria-label=${t("common.cancel")}
              @click=${() => {
                closeCardDetails(state);
                props.onRequestUpdate?.();
              }}
            >
              ${icons.x}
            </button>
          </openclaw-tooltip>
        </header>

        <section class="workboard-detail__section">
          <div class="workboard-card__lifecycle">
            <span class="workboard-lifecycle workboard-lifecycle--${formatted.tone}">
              ${formatted.label}
            </span>
            <span id=${workboardCardDetailDescriptionId} class="workboard-card__lifecycle-detail">
              ${task && taskIsAuthoritative
                ? taskDetail(task)
                : (lifecycle.session?.displayName ?? formatted.detail)}
            </span>
          </div>
          <div class="workboard-detail__grid">
            ${renderDetailRow(t("workboard.fieldStatus"), formatStatusLabel(card.status))}
            ${renderDetailRow(
              t("workboard.fieldAgent"),
              card.agentId ?? t("workboard.defaultAgent"),
            )}
            ${renderDetailRow(t("workboard.detailTask"), task?.taskId ?? card.taskId)}
            ${renderDetailRow(t("workboard.fieldSession"), linkedSessionKey)}
            ${renderDetailRow(t("workboard.detailRun"), card.runId ?? card.execution?.runId)}
            ${renderDetailRow(t("workboard.detailUpdated"), formatUpdatedTime(card.updatedAt))}
          </div>
        </section>

        ${card.notes
          ? html`
              <section class="workboard-detail__section">
                <h3>${t("workboard.fieldNotes")}</h3>
                <p>${card.notes}</p>
              </section>
            `
          : nothing}
        ${renderDependencyDetailList(dependencies)}
        ${renderDetailList(t("workboard.fieldLabels"), card.labels)}
        ${renderDetailList(
          t("workboard.badgeAttempts", { count: String(attempts.length) }),
          attempts.map((entry) =>
            [entry.status, entry.model, entry.sessionKey, entry.error].filter(Boolean).join(" - "),
          ),
        )}
        ${renderDetailList(
          t("workboard.badgeLinks", { count: String(links.length) }),
          links.map((entry) =>
            [entry.type, entry.title, entry.targetCardId, entry.url].filter(Boolean).join(" - "),
          ),
        )}
        ${renderDetailList(
          t("workboard.detailProof"),
          proof.map((entry) =>
            [entry.status, entry.label, entry.command, entry.url, entry.note]
              .filter(Boolean)
              .join(" - "),
          ),
        )}
        ${renderDetailList(
          t("workboard.badgeArtifacts", { count: String(artifacts.length) }),
          artifacts.map((entry) =>
            [entry.label, entry.url, entry.path, entry.mimeType].filter(Boolean).join(" - "),
          ),
        )}
        ${renderDetailList(
          t("workboard.badgeAttachments", { count: String(attachments.length) }),
          attachments.map((entry) =>
            [entry.fileName, entry.mimeType, entry.note].filter(Boolean).join(" - "),
          ),
        )}
        ${renderDetailList(
          t("workboard.detailDiagnostics"),
          diagnostics.map((entry) => `${entry.severity}: ${entry.title}`),
        )}
        ${renderDetailList(
          t("workboard.detailWorkerLogs"),
          workerLogs.map((entry) => `${entry.level}: ${entry.message}`),
        )}
        ${workerProtocol
          ? renderDetailList(t("workboard.detailWorkerProtocol"), [
              workerProtocol.state,
              workerProtocol.detail ?? "",
              workerProtocol.updatedAt
                ? t("workboard.detailUpdatedValue", {
                    time: formatUpdatedTime(workerProtocol.updatedAt),
                  })
                : "",
            ])
          : nothing}
        ${automation
          ? renderDetailList(t("workboard.detailAutomation"), [
              automation.tenant
                ? t("workboard.detailAutomationTenant", { tenant: automation.tenant })
                : "",
              automation.boardId
                ? t("workboard.detailAutomationBoard", { board: automation.boardId })
                : "",
              automation.skills?.length
                ? t("workboard.detailAutomationSkills", { skills: automation.skills.join(", ") })
                : "",
              automation.workspace
                ? t("workboard.detailAutomationWorkspace", {
                    workspace: [
                      automation.workspace.kind,
                      automation.workspace.path,
                      automation.workspace.branch,
                    ]
                      .filter(Boolean)
                      .join(" "),
                  })
                : "",
              automation.dispatchCount
                ? t("workboard.badgeDispatches", { count: String(automation.dispatchCount) })
                : "",
              automation.lastDispatchAt
                ? t("workboard.detailUpdatedValue", {
                    time: formatUpdatedTime(automation.lastDispatchAt),
                  })
                : "",
              automation.summary
                ? t("workboard.detailAutomationSummary", { summary: automation.summary })
                : "",
            ])
          : nothing}
        ${renderDetailList(
          t("workboard.eventsLabel"),
          events.map((event) => `${formatEventLabel(event)} ${formatUpdatedTime(event.at)}`),
        )}

        <section class="workboard-detail__section">
          <h3>${t("workboard.detailOperatorNotes")}</h3>
          ${comments.length
            ? html`
                <ol class="workboard-detail__list">
                  ${comments.slice(-6).map((comment) => html`<li>${comment.body}</li>`)}
                </ol>
              `
            : html`<p>${t("workboard.detailNoNotes")}</p>`}
          ${writable
            ? html`
                <textarea
                  class="input workboard-detail__note"
                  maxlength="2000"
                  placeholder=${t("workboard.detailNotePlaceholder")}
                  .value=${state.detailCommentBody}
                  @input=${(event: InputEvent) => {
                    state.detailCommentBody = (event.currentTarget as HTMLTextAreaElement).value;
                    props.onRequestUpdate?.();
                  }}
                ></textarea>
                <button
                  class="btn"
                  type="button"
                  ?disabled=${busy || !state.detailCommentBody.trim()}
                  @click=${() =>
                    addWorkboardCardComment({
                      host: props.host,
                      client: props.client,
                      cardId: card.id,
                      body: state.detailCommentBody,
                      requestUpdate: props.onRequestUpdate,
                    })}
                >
                  ${icons.plus} ${t("workboard.detailAddNote")}
                </button>
              `
            : nothing}
        </section>

        <div class="workboard-detail__actions">
          ${writable && !archived ? renderEditCardAction(props, card) : nothing}
          ${writable ? renderArchiveCardAction(props, card, busy, archived) : nothing}
          ${writable ? renderCardMoveControl(props, card, busy, { wide: true }) : nothing}
          ${writable && (linkedSessionKey ? live : activeTask)
            ? renderStopCardAction(props, card, busy)
            : nothing}
          ${renderOpenSessionCardAction(props, linkedSessionKey)}
          ${writable ? renderDeleteCardAction(props, card, busy) : nothing}
          ${showStartControls ? renderStartExecutionControls(props, card) : nothing}
        </div>
      </div>
    </aside>
  `;
}

function renderDispatchSummary(state: WorkboardUiState) {
  const summary = state.lastDispatchSummary;
  if (!summary) {
    return nothing;
  }
  const total =
    summary.started +
    summary.failures +
    summary.promoted +
    summary.blocked +
    summary.reclaimed +
    summary.orchestrated;
  const key = total === 0 ? "workboard.dispatchSummaryEmpty" : "workboard.dispatchSummary";
  return html`
    <div class="callout">
      ${t(key, {
        started: String(summary.started),
        failures: String(summary.failures),
        promoted: String(summary.promoted),
        blocked: String(summary.blocked),
        reclaimed: String(summary.reclaimed),
        orchestrated: String(summary.orchestrated),
      })}
    </div>
  `;
}

function renderHealthStrip(
  state: WorkboardUiState,
  summary: WorkboardHealthSummary,
  requestUpdate?: () => void,
) {
  const items: Array<[WorkboardHealthKey, string, number]> = [
    ["running", t("workboard.healthRunning"), summary.running],
    ["blocked", t("workboard.healthBlocked"), summary.blocked],
    ["stale", t("workboard.healthStale"), summary.stale],
    ["readyUnassigned", t("workboard.healthReadyUnassigned"), summary.readyUnassigned],
    ["missingProof", t("workboard.healthMissingProof"), summary.missingProof],
    ["failedAttempts", t("workboard.healthFailedAttempts"), summary.failedAttempts],
  ];
  return html`
    <div class="workboard-health" aria-label=${t("workboard.healthLabel")}>
      ${items.map(
        ([key, label, count]) => html`
          <button
            class="workboard-health__item workboard-health__item--${key} ${state.activeHealthHighlight ===
            key
              ? "workboard-health__item--active"
              : ""} ${count === 0 ? "workboard-health__item--empty" : ""}"
            type="button"
            aria-pressed=${state.activeHealthHighlight === key}
            aria-label=${`${count} ${label}`}
            @click=${() => {
              state.activeHealthHighlight = state.activeHealthHighlight === key ? null : key;
              requestUpdate?.();
            }}
          >
            <strong>${count}</strong>${label}
          </button>
        `,
      )}
    </div>
  `;
}

function renderRefreshStatus(state: WorkboardUiState) {
  if (state.lastRefreshAt) {
    return html`<span
      class="workboard-refresh-status ${state.lastRefreshError
        ? "workboard-refresh-status--error"
        : ""}"
      title=${state.lastRefreshError ? t("workboard.refreshError") : ""}
    >
      ${t("workboard.lastRefreshed", { time: formatRefreshTime(state.lastRefreshAt) })}
    </span>`;
  }
  if (state.lastRefreshError) {
    return html`<span class="workboard-refresh-status workboard-refresh-status--error">
      ${t("workboard.refreshError")}
    </span>`;
  }
  return nothing;
}

function renderWorkboardEmptyState() {
  return html`
    <div class="workboard-empty-state" role="status">
      <strong>${t("workboard.emptyFilteredTitle")}</strong>
      <span>${t("workboard.emptyFilteredHint")}</span>
    </div>
  `;
}

const autoRefreshOptions: Array<{ value: WorkboardAutoRefreshIntervalMs; labelKey: string }> = [
  { value: 0, labelKey: "workboard.autoRefreshOff" },
  { value: 5000, labelKey: "workboard.autoRefresh5s" },
  { value: 15000, labelKey: "workboard.autoRefresh15s" },
  { value: 30000, labelKey: "workboard.autoRefresh30s" },
  { value: 60000, labelKey: "workboard.autoRefresh60s" },
];

const viewPresetOptions: Array<{ value: WorkboardUiState["viewPreset"]; labelKey: string }> = [
  { value: "all", labelKey: "workboard.viewAll" },
  { value: "default_agent", labelKey: "workboard.viewDefaultAgent" },
  { value: "ready", labelKey: "workboard.viewReady" },
  { value: "running", labelKey: "workboard.viewRunning" },
  { value: "blocked", labelKey: "workboard.viewBlocked" },
  { value: "review", labelKey: "workboard.viewReview" },
  { value: "stale", labelKey: "workboard.viewStale" },
  { value: "missing_proof", labelKey: "workboard.viewMissingProof" },
  { value: "recently_done", labelKey: "workboard.viewRecentlyDone" },
];

function renderCard(props: WorkboardProps, card: WorkboardCard) {
  const cardActions = getCardActionState(props, card);
  const {
    state,
    task,
    busy,
    activeTask,
    live,
    linkedSessionKey,
    writable,
    showStartControls,
    archived,
  } = cardActions;
  const syncing = state.syncingCardIds.has(card.id);
  const healthHighlighted = state.activeHealthHighlight
    ? workboardCardMatchesHealthKey(card, state.activeHealthHighlight, props.sessions, task)
    : false;
  const dependencies = getWorkboardDependencyState(card, state.cards);
  const topStartAction = showStartControls
    ? renderStartExecutionButton(props, card, null, "autonomous", { iconOnly: true })
    : nothing;
  const topEditAction =
    writable && !archived ? renderEditCardAction(props, card, { iconOnly: true }) : nothing;
  const topArchiveAction = writable
    ? renderArchiveCardAction(props, card, busy, archived, { iconOnly: true })
    : nothing;
  const detailAction = html`
    <openclaw-tooltip .content=${t("workboard.viewDetails")}>
      <button
        class="btn btn--icon workboard-card__icon"
        aria-label=${t("workboard.viewDetails")}
        aria-haspopup="dialog"
        aria-expanded=${state.detailCardId === card.id ? "true" : "false"}
        aria-controls=${workboardCardDetailDrawerId}
        @click=${(event: MouseEvent) => {
          rememberWorkboardReturnFocus(event.currentTarget);
          openCardDetails(state, card);
          props.onRequestUpdate?.();
        }}
      >
        ${icons.panelRightOpen}
      </button>
    </openclaw-tooltip>
  `;
  const sessionAction = renderOpenSessionCardAction(props, linkedSessionKey, { iconOnly: true });
  const stopAction =
    writable && (linkedSessionKey ? live : activeTask)
      ? renderStopCardAction(props, card, busy, { iconOnly: true })
      : nothing;
  const moveAction = writable ? renderCardMoveControl(props, card, busy) : nothing;
  const deleteAction = writable
    ? renderDeleteCardAction(props, card, busy, { iconOnly: true })
    : nothing;
  return html`
    <article
      class="workboard-card priority-${card.priority} ${busy
        ? "workboard-card--busy"
        : ""} ${archived ? "workboard-card--archived" : ""} ${healthHighlighted
        ? `workboard-card--health-highlight workboard-card--health-highlight-${state.activeHealthHighlight}`
        : ""} workboard-card--openable"
      role="button"
      tabindex="0"
      title=${t("workboard.viewDetails")}
      aria-haspopup="dialog"
      aria-expanded=${state.detailCardId === card.id ? "true" : "false"}
      aria-controls=${workboardCardDetailDrawerId}
      draggable=${writable && !state.dispatching ? "true" : "false"}
      @click=${(event: MouseEvent) => {
        if (!isCardActionTarget(event)) {
          rememberWorkboardReturnFocus(event.currentTarget);
          openCardDetails(state, card);
          props.onRequestUpdate?.();
        }
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (isCardActionTarget(event) || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        rememberWorkboardReturnFocus(event.currentTarget);
        openCardDetails(state, card);
        props.onRequestUpdate?.();
        event.preventDefault();
      }}
      @dragstart=${(event: DragEvent) => {
        if (!writable || state.dispatching) {
          event.preventDefault();
          return;
        }
        state.draggedCardId = card.id;
        event.dataTransfer?.setData("text/plain", card.id);
        event.dataTransfer?.setDragImage(event.currentTarget as Element, 16, 16);
        props.onRequestUpdate?.();
      }}
      @dragend=${() => {
        state.draggedCardId = null;
        props.onRequestUpdate?.();
      }}
    >
      <div class="workboard-card__top">
        <div
          class="workboard-card__updated"
          title=${t("workboard.detailUpdatedValue", { time: formatUpdatedTime(card.updatedAt) })}
          aria-label=${t("workboard.detailUpdatedValue", {
            time: formatUpdatedTime(card.updatedAt),
          })}
        >
          <span class="workboard-card__updated-icon" aria-hidden="true">${icons.clock}</span>
          <span>${formatUpdatedTime(card.updatedAt)}</span>
        </div>
        <div class="workboard-card__quick-actions">
          ${renderCardActionSlot(topStartAction)} ${renderCardActionSlot(topEditAction)}
          ${renderCardActionSlot(topArchiveAction)}
        </div>
      </div>
      <div class="workboard-card__chips">
        <span class="workboard-card__priority">${formatPriorityLabel(card.priority)}</span>
        ${renderAgentChip(props, card)}
        ${archived
          ? html`<span class="workboard-card__archived">${t("workboard.archived")}</span>`
          : nothing}
        ${live ? html`<span class="workboard-live">${t("workboard.live")}</span>` : nothing}
        ${syncing ? html`<span class="workboard-live">${t("common.saving")}</span>` : nothing}
      </div>
      <h3>${card.title}</h3>
      ${card.notes ? html`<p>${card.notes}</p>` : nothing}
      ${renderLifecycle(card, props.sessions, task)} ${renderDependencyBadges(dependencies)}
      ${card.labels.length
        ? html`<div class="workboard-labels">
            ${card.labels.map((label) => html`<span>${label}</span>`)}
          </div>`
        : nothing}
      ${renderCompactBadges(card, task)}
      <div class="workboard-card__meta">
        <span>${linkedSessionKey ?? t("workboard.noLinkedSession")}</span>
      </div>
      ${renderEvents(card)}
      <div class="workboard-card__actions">
        ${renderCardActionSlot(detailAction)}
        <div class="workboard-card__actions-primary">
          ${renderCardActionSlot(sessionAction)} ${renderCardActionSlot(stopAction)}
          ${renderCardActionSlot(moveAction)}
        </div>
        ${renderCardActionSlot(deleteAction)}
      </div>
    </article>
  `;
}

function renderColumn(props: WorkboardProps, status: WorkboardStatus, cards: WorkboardCard[]) {
  const state = getWorkboardState(props.host);
  const writable = canMutate(props);
  return html`
    <section
      class="workboard-column workboard-column--${status} ${state.draggedCardId
        ? "workboard-column--drop"
        : ""}"
      @dragover=${(event: DragEvent) => {
        if (writable && state.draggedCardId) {
          event.preventDefault();
        }
      }}
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        if (!writable) {
          return;
        }
        const cardId = event.dataTransfer?.getData("text/plain") || state.draggedCardId;
        if (!cardId) {
          return;
        }
        void moveWorkboardCard({
          host: props.host,
          client: props.client,
          cardId,
          status,
          position: nextPosition(state.cards, status),
          requestUpdate: props.onRequestUpdate,
        });
      }}
    >
      <div class="workboard-column__header">
        <h2>${formatStatusLabel(status)}</h2>
        <span>${cards.length}</span>
      </div>
      <div class="workboard-column__cards">
        ${cards.length
          ? cards.map((card) => renderCard(props, card))
          : html`<div class="workboard-empty">${t("workboard.emptyColumn")}</div>`}
      </div>
    </section>
  `;
}

export function renderWorkboard(props: WorkboardProps) {
  const state = getWorkboardState(props.host);

  if (props.pluginEnabled === null) {
    if (props.pluginEnablementError) {
      return html`
        <section class="workboard">
          <div class="callout danger" role="alert">${props.pluginEnablementError}</div>
          ${props.onReloadConfig
            ? html`<button class="btn" type="button" @click=${props.onReloadConfig}>
                ${t("lazyView.retry")}
              </button>`
            : nothing}
        </section>
      `;
    }
    return html`
      <section class="card lazy-view-state lazy-view-state--loading">
        <div class="card-title">${t("lazyView.loadingTitle")}</div>
        <div class="card-sub">${t("common.loading")}</div>
      </section>
    `;
  }

  if (!props.pluginEnabled) {
    return html`
      <section class="workboard">
        <div class="callout">
          ${t("workboard.disabledHelpStart")}
          <code>${t("workboard.enableConfigKey")}</code>${t("workboard.disabledHelpEnd")}
        </div>
      </section>
    `;
  }

  const agentOptions = buildAgentFilterOptions(props.agentsList, state.cards);
  state.agentFilter = normalizeActiveAgentFilter(agentOptions, state.agentFilter);
  const applyNonViewFilters = (cards: readonly WorkboardCard[]) =>
    cards
      .filter((card) => state.showArchived || !card.metadata?.archivedAt)
      .filter((card) => matchesAgentFilter(card, props.agentsList, state.agentFilter))
      .filter((card) =>
        matchesFilter(card, { query: state.query, priority: state.priorityFilter }),
      );
  const cardsForPreset = (preset: WorkboardUiState["viewPreset"]) =>
    applyNonViewFilters(
      filterWorkboardCardsForPreset({
        cards: state.cards,
        preset,
        tasksByCardId: state.tasksByCardId,
        sessions: props.sessions,
        defaultAgentId: props.agentsList?.defaultId,
      }),
    );
  const filtered = cardsForPreset(state.viewPreset);
  const health = summarizeWorkboardHealth({
    cards: filtered,
    tasksByCardId: state.tasksByCardId,
    sessions: props.sessions,
  });
  const visibleError = state.error ?? state.lifecycleTaskRefreshError;
  const writable = canMutate(props);
  const byStatus = new Map<WorkboardStatus, WorkboardCard[]>();
  for (const status of state.statuses) {
    byStatus.set(status, []);
  }
  for (const card of filtered) {
    byStatus.get(card.status)?.push(card);
  }
  const visibleStatuses =
    state.hideEmptyColumns || state.viewPreset !== "all"
      ? state.statuses.filter((status) => (byStatus.get(status)?.length ?? 0) > 0)
      : state.statuses;
  const archivedCardsHidden =
    !state.showArchived && state.cards.some((card) => card.metadata?.archivedAt);
  const activeFiltering =
    state.viewPreset !== "all" ||
    state.query.trim() !== "" ||
    state.priorityFilter !== "all" ||
    state.agentFilter !== "all" ||
    archivedCardsHidden;
  const showEmptyState = filtered.length === 0 && activeFiltering;
  const autoRefreshEnabled = state.autoRefreshIntervalMs > 0;
  const viewOptions: Array<WorkboardSelectOption<WorkboardUiState["viewPreset"]>> =
    viewPresetOptions.map((option) => {
      const count = cardsForPreset(option.value).length;
      return {
        value: option.value,
        label: t(option.labelKey),
        description:
          option.value === "all"
            ? undefined
            : t("workboard.viewPresetCount", { count: String(count) }),
        disabled: option.value !== "all" && count === 0,
      };
    });
  const priorityOptions: Array<WorkboardSelectOption<WorkboardUiState["priorityFilter"]>> = [
    { value: "all", label: t("workboard.allPriorities") },
    ...WORKBOARD_PRIORITIES.map((priority) => ({
      value: priority,
      label: formatPriorityLabel(priority),
    })),
  ];
  const agentSelectOptions: WorkboardSelectOption[] = agentOptions.map((agent) => {
    const option: WorkboardSelectOption = {
      value: agent.id,
      label: agent.label,
    };
    if (agent.description) {
      option.description = agent.description;
    }
    return option;
  });
  const dialogOpen = state.draftOpen || Boolean(getVisibleDetailCard(state));

  return html`
    <section class="workboard" @pointerdown=${closeWorkboardSelectMenusOnOutsidePointer}>
      <div class="workboard-main" ?inert=${dialogOpen} aria-hidden=${dialogOpen ? "true" : nothing}>
        <div class="workboard-toolbar">
          <div class="workboard-toolbar__filters">
            <input
              class="input"
              type="search"
              title=${t("workboard.searchPlaceholder")}
              placeholder=${t("workboard.searchPlaceholder")}
              .value=${state.query}
              @input=${(event: InputEvent) => {
                state.query = (event.currentTarget as HTMLInputElement).value;
                props.onRequestUpdate?.();
              }}
            />
            ${renderWorkboardSelect({
              value: state.viewPreset,
              options: viewOptions,
              label: t("workboard.viewPreset"),
              onChange: (value) => {
                state.viewPreset = value;
              },
              requestUpdate: props.onRequestUpdate,
              className: "workboard-select--toolbar",
              showLabel: false,
            })}
            ${renderWorkboardSelect({
              value: state.priorityFilter,
              options: priorityOptions,
              label: t("workboard.allPriorities"),
              onChange: (value) => {
                state.priorityFilter = value;
              },
              requestUpdate: props.onRequestUpdate,
              className: "workboard-select--toolbar",
              showLabel: false,
            })}
            ${renderWorkboardSelect({
              value: state.agentFilter,
              options: agentSelectOptions,
              label: t("workboard.agentFilter"),
              onChange: (value) => {
                state.agentFilter = value;
              },
              requestUpdate: props.onRequestUpdate,
              className: "workboard-select--toolbar workboard-select--toolbar-agent",
              showLabel: false,
            })}
            <button
              class="btn workboard-archive-toggle ${state.showArchived ? "active" : ""}"
              type="button"
              aria-pressed=${state.showArchived}
              @click=${() => {
                state.showArchived = !state.showArchived;
                props.onRequestUpdate?.();
              }}
            >
              ${state.showArchived ? icons.eye : icons.eyeOff}
              ${state.showArchived
                ? t("workboard.hideArchivedShort")
                : t("workboard.showArchivedShort")}
            </button>
            <div class="workboard-layout-controls">
              <div class="workboard-layout-toggle" role="group" aria-label=${t("workboard.layout")}>
                <openclaw-tooltip .content=${t("workboard.layoutCompact")}>
                  <button
                    class="btn btn--icon ${state.layout === "compact" ? "active" : ""}"
                    type="button"
                    aria-label=${t("workboard.layoutCompact")}
                    aria-pressed=${state.layout === "compact"}
                    @click=${() => {
                      state.layout = "compact";
                      props.onRequestUpdate?.();
                    }}
                  >
                    ${icons.layoutCompact}
                  </button>
                </openclaw-tooltip>
                <openclaw-tooltip .content=${t("workboard.layoutComfortable")}>
                  <button
                    class="btn btn--icon ${state.layout === "comfortable" ? "active" : ""}"
                    type="button"
                    aria-label=${t("workboard.layoutComfortable")}
                    aria-pressed=${state.layout === "comfortable"}
                    @click=${() => {
                      state.layout = "comfortable";
                      props.onRequestUpdate?.();
                    }}
                  >
                    ${icons.layoutComfortable}
                  </button>
                </openclaw-tooltip>
              </div>
              ${renderRefreshStatus(state)}
            </div>
            <label class="workboard-toggle">
              <input
                type="checkbox"
                name="workboard-hide-empty-columns"
                .checked=${state.hideEmptyColumns}
                @change=${(event: Event) => {
                  state.hideEmptyColumns = (event.currentTarget as HTMLInputElement).checked;
                  props.onRequestUpdate?.();
                }}
              />
              <span>${t("workboard.hideEmptyColumns")}</span>
            </label>
          </div>
          <div class="workboard-toolbar__actions">
            ${autoRefreshEnabled
              ? nothing
              : html`
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${state.loading ||
                    state.dispatching ||
                    workboardHasActiveWrites(state)}
                    @click=${() =>
                      refreshWorkboard({
                        host: props.host,
                        client: props.client,
                        requestUpdate: props.onRequestUpdate,
                        source: "manual",
                        refreshDiagnostics: canWrite(props),
                      })}
                  >
                    ${state.loading ? t("common.refreshing") : t("common.refresh")}
                  </button>
                `}
            <label class="workboard-auto-refresh">
              <span>${t("workboard.autoRefresh")}</span>
              <select
                class="input"
                title=${t("workboard.autoRefresh")}
                .value=${String(state.autoRefreshIntervalMs)}
                @change=${(event: Event) => {
                  state.autoRefreshIntervalMs = Number(
                    (event.currentTarget as HTMLSelectElement).value,
                  ) as WorkboardAutoRefreshIntervalMs;
                  configureWorkboardPolling({
                    host: props.host,
                    client: props.client,
                    enabled:
                      props.connected &&
                      props.pluginEnabled === true &&
                      state.autoRefreshIntervalMs > 0,
                    requestUpdate: props.onRequestUpdate,
                  });
                  props.onRequestUpdate?.();
                }}
              >
                ${autoRefreshOptions.map(
                  (option) =>
                    html`<option value=${String(option.value)}>${t(option.labelKey)}</option>`,
                )}
              </select>
            </label>
            ${writable
              ? html`
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${state.dispatching || workboardHasActiveWrites(state)}
                    @click=${() =>
                      dispatchWorkboard({
                        host: props.host,
                        client: props.client,
                        requestUpdate: props.onRequestUpdate,
                      })}
                  >
                    ${icons.zap} ${t("workboard.dispatch")}
                  </button>
                `
              : nothing}
            ${writable
              ? html`
                  <button
                    class="btn primary"
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded=${state.draftOpen ? "true" : "false"}
                    aria-controls=${workboardCardModalId}
                    ?disabled=${state.dispatching}
                    @click=${(event: MouseEvent) => {
                      rememberWorkboardReturnFocus(event.currentTarget);
                      openCreateModal(state);
                      props.onRequestUpdate?.();
                    }}
                  >
                    ${icons.plus} ${t("workboard.newCard")}
                  </button>
                `
              : nothing}
          </div>
        </div>
        ${renderHealthStrip(state, health, props.onRequestUpdate)}
        ${visibleError ? html`<div class="callout danger">${visibleError}</div>` : nothing}
        ${renderDispatchSummary(state)}
        ${showEmptyState || visibleStatuses.length === 0
          ? renderWorkboardEmptyState()
          : html`
              <div
                class="workboard-board workboard-board--${state.layout} ${visibleStatuses.length ===
                1
                  ? "workboard-board--single-column"
                  : ""}"
              >
                ${visibleStatuses.map((status) =>
                  renderColumn(props, status, byStatus.get(status) ?? []),
                )}
              </div>
            `}
      </div>
      ${renderCardModal(props)} ${renderCardDetailsPanel(props)}
    </section>
  `;
}
