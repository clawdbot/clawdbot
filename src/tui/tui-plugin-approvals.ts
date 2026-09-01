// Presents plugin approvals that belong to the active TUI session.
import {
  SelectList,
  Text,
  type Component,
  type OverlayHandle,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { isApprovalStaleError } from "../infra/approval-errors.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createTuiRefreshCoalescer } from "./coalesced-refresh.js";
import { selectListTheme, tuiTheme as theme } from "./theme/theme.js";
import type {
  TuiApprovalDecision,
  TuiBackend,
  TuiExternalApprovalDecision,
  TuiPluginApproval,
} from "./tui-backend.js";
import { sanitizeRenderableText } from "./tui-formatters.js";
import { matchesOwnedTuiSession } from "./tui-session-events.js";

type ApprovalSelector = Component & {
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  setSelectedIndex?: (index: number) => void;
};

const APPROVAL_BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const FENCED_PRESENTATION_RE = /(?:^|\n)(```|~~~)[^\n]*\n([\s\S]*?)\n\1(?=\n|$)/g;
const MAX_COMPACT_PRESENTATION_CHARS = 480;
const MAX_APPROVAL_PROMPT_ROWS = 24;
const TERMINAL_BLACK_ON_WHITE = "\x1b[47m\x1b[30m";
const TERMINAL_RESET = "\x1b[0m";

function sanitizeApprovalText(text: string): string {
  const flattened = text.replace(APPROVAL_BIDI_CONTROL_RE, "").replace(/\s+/g, " ").trim();
  return sanitizeRenderableText(flattened);
}

type FencedPresentation = {
  content: string;
  fallback: string;
};

type CompactPresentation = {
  challenge: string;
  fallback: string;
};

function compactPresentationText(text: string): string {
  const compact = sanitizeApprovalText(text);
  const characters = Array.from(compact);
  return characters.length <= MAX_COMPACT_PRESENTATION_CHARS
    ? compact
    : `${characters.slice(0, MAX_COMPACT_PRESENTATION_CHARS - 1).join("")}…`;
}

function extractLatestFencedPresentation(
  presentations: readonly string[],
): FencedPresentation | null {
  let latest: FencedPresentation | null = null;
  for (const presentation of presentations) {
    const sanitized = sanitizeRenderableText(presentation).replace(APPROVAL_BIDI_CONTROL_RE, "");
    FENCED_PRESENTATION_RE.lastIndex = 0;
    for (
      let match = FENCED_PRESENTATION_RE.exec(sanitized);
      match;
      match = FENCED_PRESENTATION_RE.exec(sanitized)
    ) {
      const matchEnd = match.index + match[0].length;
      latest = {
        content: match[2] ?? "",
        fallback: compactPresentationText(sanitized.slice(matchEnd)),
      };
    }
  }
  return latest;
}

function formatCompactPresentation(presentations: readonly string[]): CompactPresentation {
  const fenced = extractLatestFencedPresentation(presentations);
  if (fenced !== null) {
    return {
      challenge: fenced.content
        .split("\n")
        .map((line) => `${TERMINAL_BLACK_ON_WHITE}${line}${TERMINAL_RESET}`)
        .join("\n"),
      fallback: fenced.fallback,
    };
  }
  const latest = presentations.at(-1);
  return {
    challenge: "",
    fallback: latest ? compactPresentationText(latest) : "",
  };
}

class PluginApprovalPrompt implements Component {
  private readonly title: Text;
  private readonly metadata: Text;
  private readonly description: Text;
  private readonly externalResolution: Text;
  private readonly challenge: Text;
  private readonly challengeFallback: Text;
  private readonly challengeOverflow = new Text(
    theme.system("Full challenge is in chat. Press Escape to scan it."),
  );
  private readonly confirmation = new Text();

  constructor(
    surfaceLabel: string,
    approval: TuiPluginApproval,
    private readonly selector: ApprovalSelector,
    presentations: readonly string[] = [],
    pendingSessionApprovals = 1,
  ) {
    const title = sanitizeApprovalText(approval.request.title);
    const description = sanitizeApprovalText(approval.request.description ?? "");
    const severity = approval.request.severity ?? "warning";
    const metadata = [
      `Severity: ${severity === "critical" ? "Critical" : severity === "info" ? "Info" : "Warning"}`,
      ...(approval.request.toolName
        ? [`Tool: ${sanitizeApprovalText(approval.request.toolName)}`]
        : []),
      ...(approval.request.pluginId
        ? [`Plugin: ${sanitizeApprovalText(approval.request.pluginId)}`]
        : []),
      // Back-to-back cards for a multi-call task look identical; the queue
      // position is what tells the reviewer these are distinct approvals.
      ...(pendingSessionApprovals > 1
        ? [`Pending approvals in this session: ${pendingSessionApprovals}`]
        : []),
    ];
    const externalResolution = approval.request.externalResolution;
    const externalLines = externalResolution
      ? [
          sanitizeApprovalText(externalResolution.label),
          "Press Escape to dismiss; the request remains pending.",
        ]
      : [];
    this.title = new Text(theme.header(`${surfaceLabel}: ${title}`));
    this.metadata = new Text(theme.dim(metadata.join("\n")));
    this.description = new Text(theme.system(description ? `Request: ${description}` : ""));
    this.externalResolution = new Text(theme.system(externalLines.join("\n")));
    const presentation = formatCompactPresentation(presentations);
    this.challenge = new Text(presentation.challenge);
    this.challengeFallback = new Text(presentation.fallback);
  }

  setConfirmation(text: string): void {
    this.confirmation.setText(theme.accent(text));
  }

  invalidate(): void {
    this.title.invalidate();
    this.metadata.invalidate();
    this.description.invalidate();
    this.externalResolution.invalidate();
    this.challenge.invalidate();
    this.challengeFallback.invalidate();
    this.challengeOverflow.invalidate();
    this.confirmation.invalidate();
    this.selector.invalidate();
  }

  render(width: number): string[] {
    const challenge = this.challenge.render(width);
    const challengeFallback = this.challengeFallback.render(width);
    const confirmation = this.confirmation.render(width);
    const selector = this.selector.render(width);
    const title = this.title.render(width);
    const metadata = this.metadata.render(width);
    const description = this.description.render(width);
    const externalResolution = this.externalResolution.render(width);
    const context = [
      ...title.slice(0, 2),
      ...metadata,
      ...(externalResolution.some((line) => line.trim()) ? externalResolution : []),
      ...(description.some((line) => line.trim()) ? description : []),
    ];
    if (challenge.some((line) => line.trim())) {
      const controls = [
        ...selector,
        ...(confirmation.some((line) => line.trim()) ? confirmation : []),
      ];
      const challengeBudget = MAX_APPROVAL_PROMPT_ROWS - controls.length - challengeFallback.length;
      if (challenge.length <= challengeBudget) {
        const contextBudget = Math.max(0, challengeBudget - challenge.length);
        return [
          ...context.slice(0, contextBudget),
          ...controls,
          ...challengeFallback,
          ...challenge,
        ];
      }
      const overflow = this.challengeOverflow.render(width);
      const fallback =
        challengeFallback.length + overflow.length <= MAX_APPROVAL_PROMPT_ROWS - controls.length
          ? challengeFallback
          : [];
      const contextBudget = Math.max(
        0,
        MAX_APPROVAL_PROMPT_ROWS - controls.length - fallback.length - overflow.length,
      );
      const visibleContext = context.slice(0, contextBudget);
      // A cropped QR is invalid. Keep a complete fallback when it fits and direct
      // users to the full pending presentation in chat for oversized challenges.
      return [...visibleContext, ...controls, ...fallback, ...overflow];
    }
    if (externalResolution.some((line) => line.trim())) {
      const controls = [
        ...(confirmation.some((line) => line.trim()) ? confirmation : []),
        ...selector,
      ];
      const fallbackBudget = Math.max(0, MAX_APPROVAL_PROMPT_ROWS - controls.length);
      const fallback = challengeFallback.slice(0, fallbackBudget);
      const contextBudget = Math.max(
        0,
        MAX_APPROVAL_PROMPT_ROWS - controls.length - fallback.length,
      );
      return [...context.slice(0, contextBudget), ...controls, ...fallback];
    }
    return [
      ...context,
      ...(confirmation.some((line) => line.trim()) ? ["", ...confirmation] : []),
      "",
      ...selector,
    ];
  }

  handleInput(data: string): void {
    this.selector.handleInput?.(data);
  }
}

type ApprovalTimer = number | NodeJS.Timeout;
type ApprovalMutation = {
  version: number;
  approval: TuiPluginApproval | null;
};

type TuiPluginApprovalControllerDeps = {
  client: Pick<
    TuiBackend,
    | "listPluginApprovals"
    | "prepareExternalPluginApproval"
    | "resolvePluginApproval"
    | "startExternalPluginApproval"
  >;
  chatLog: {
    addSystem: (line: string) => void;
    addPendingSystem: (id: string, line: string) => void;
    dismissPendingSystem: (id: string) => boolean;
  };
  getAgentId: () => string;
  getSessionKey: () => string;
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle?: OverlayHandle) => void;
  requestRender: () => void;
  createSelector?: (items: SelectItem[]) => ApprovalSelector;
  nowMs?: () => number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => ApprovalTimer;
  clearTimeoutFn?: (timer: ApprovalTimer) => void;
};

const DEFAULT_DECISIONS: readonly TuiApprovalDecision[] = ["allow-once", "allow-always", "deny"];
const EXTERNAL_SELECTION_PREFIX = "external:";

const DECISION_ITEMS: Record<TuiApprovalDecision, SelectItem> = {
  "allow-once": {
    value: "allow-once",
    label: "Allow once",
    description: "Approve this change",
  },
  "allow-always": {
    value: "allow-always",
    label: "Always allow",
    description: "Approve matching future changes",
  },
  deny: {
    value: "deny",
    label: "Deny",
    description: "Do not apply this change",
  },
};

const EXTERNAL_DECISION_ITEMS: Record<TuiExternalApprovalDecision, SelectItem> = {
  "allow-once": {
    value: `${EXTERNAL_SELECTION_PREFIX}allow-once`,
    label: "Verify once",
    description: "Verify this blocked action",
  },
  "allow-always": {
    value: `${EXTERNAL_SELECTION_PREFIX}allow-always`,
    label: "Verify and trust for session",
    description: "Verify and trust matching actions in this session",
  },
};

function parseDecision(value: unknown): TuiApprovalDecision | null {
  return value === "allow-once" || value === "allow-always" || value === "deny" ? value : null;
}

function parseExternalDecision(value: unknown): TuiExternalApprovalDecision | null {
  if (typeof value !== "string" || !value.startsWith(EXTERNAL_SELECTION_PREFIX)) {
    return null;
  }
  const decision = value.slice(EXTERNAL_SELECTION_PREFIX.length);
  return decision === "allow-once" || decision === "allow-always" ? decision : null;
}

function parseAllowedDecisions(value: unknown): TuiApprovalDecision[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const decisions: TuiApprovalDecision[] = [];
  for (const candidate of value) {
    const decision = parseDecision(candidate);
    if (decision && !decisions.includes(decision)) {
      decisions.push(decision);
    }
  }
  return decisions;
}

function parseExternalResolution(
  value: unknown,
): TuiPluginApproval["request"]["externalResolution"] {
  const record = asOptionalObjectRecord(value);
  if (!record) {
    return null;
  }
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label || !Array.isArray(record.decisions)) {
    return null;
  }
  const decisions: TuiExternalApprovalDecision[] = [];
  for (const candidate of record.decisions) {
    if (
      (candidate === "allow-once" || candidate === "allow-always") &&
      !decisions.includes(candidate)
    ) {
      decisions.push(candidate);
    }
  }
  return decisions.length > 0 ? { label, decisions } : null;
}

function parseSeverity(value: unknown): TuiPluginApproval["request"]["severity"] {
  return value === "info" || value === "warning" || value === "critical" ? value : null;
}

/** Parses the gateway event/list shape used for pending plugin approvals. */
function parseTuiPluginApproval(payload: unknown): TuiPluginApproval | null {
  const record = asOptionalObjectRecord(payload);
  const request = asOptionalObjectRecord(record?.request);
  if (!record || !request) {
    return null;
  }
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const title = typeof request.title === "string" ? request.title.trim() : "";
  const createdAtMs = typeof record.createdAtMs === "number" ? record.createdAtMs : 0;
  const expiresAtMs = typeof record.expiresAtMs === "number" ? record.expiresAtMs : 0;
  if (!id || !title || !createdAtMs || !expiresAtMs) {
    return null;
  }
  const rawExternalResolution = request.externalResolution;
  const externalResolution = parseExternalResolution(rawExternalResolution);
  if (rawExternalResolution != null && !externalResolution) {
    return null;
  }
  return {
    id,
    request: {
      title,
      description: typeof request.description === "string" ? request.description : null,
      pluginId: typeof request.pluginId === "string" ? request.pluginId : null,
      severity: parseSeverity(request.severity),
      toolName: typeof request.toolName === "string" ? request.toolName : null,
      allowedDecisions: parseAllowedDecisions(request.allowedDecisions),
      externalResolution,
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
    },
    createdAtMs,
    expiresAtMs,
  };
}

function parseResolvedApprovalId(payload: unknown): string | null {
  const id = asOptionalObjectRecord(payload)?.id;
  if (typeof id !== "string") {
    return null;
  }
  return id.trim() || null;
}

function decisionLabel(decision: TuiApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "always allowed";
  }
  return "denied";
}

function approvalSurfaceLabel(approval: TuiPluginApproval): string {
  return approval.request.toolName === "skill_workshop"
    ? "workspace skill approval"
    : "plugin approval";
}

/** Coordinates pending plugin approval events with the active TUI overlay. */
export function createTuiPluginApprovalController(deps: TuiPluginApprovalControllerDeps) {
  const createSelector =
    deps.createSelector ??
    ((items: SelectItem[]) => new SelectList(items, items.length, selectListTheme));
  const nowMs = deps.nowMs ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  let queue: TuiPluginApproval[] = [];
  let activeId: string | null = null;
  let activeOverlay: OverlayHandle | null = null;
  let expiryTimer: ApprovalTimer | null = null;
  let disposed = false;
  let mutationVersion = 0;
  const refreshRunner = createTuiRefreshCoalescer(async () => await refreshOnce());
  const mutations = new Map<string, ApprovalMutation>();
  const resolvingIds = new Set<string>();
  const dismissedIds = new Set<string>();
  const externalPresentations = new Map<string, string[]>();
  const externalPresentationId = (approvalId: string) =>
    `plugin-external-verification:${approvalId}`;

  const clearExpiryTimer = () => {
    if (expiryTimer !== null) {
      clearTimeoutFn(expiryTimer);
      expiryTimer = null;
    }
  };

  const closeActiveOverlay = () => {
    const handle = activeOverlay;
    activeOverlay = null;
    if (handle) {
      deps.closeOverlay(handle);
    }
  };

  const recordMutation = (id: string, approval: TuiPluginApproval | null) => {
    if (!refreshRunner.isRunning()) {
      return;
    }
    mutationVersion += 1;
    mutations.set(id, { version: mutationVersion, approval });
  };

  const clearExternalPresentation = (id: string) => {
    externalPresentations.delete(id);
    deps.chatLog.dismissPendingSystem(externalPresentationId(id));
  };

  const remove = (id: string, record = true) => {
    queue = queue.filter((approval) => approval.id !== id);
    dismissedIds.delete(id);
    clearExternalPresentation(id);
    if (record) {
      recordMutation(id, null);
    }
  };

  const add = (approval: TuiPluginApproval, record = true) => {
    queue = queue.filter((entry) => entry.id !== approval.id);
    queue.push(approval);
    queue.sort((left, right) => left.createdAtMs - right.createdAtMs);
    if (record) {
      recordMutation(approval.id, approval);
    }
  };

  const matchesActiveSession = (approval: TuiPluginApproval) =>
    matchesOwnedTuiSession(deps.getSessionKey(), deps.getAgentId(), approval.request);

  const prune = () => {
    const now = nowMs();
    for (const approval of queue.filter((entry) => entry.expiresAtMs <= now)) {
      remove(approval.id);
    }
  };

  const presentNext = () => {
    if (disposed || activeId) {
      return;
    }
    prune();
    // One ceremony at a time: while a dispatched challenge awaits its scan, no
    // other approval card competes with it. The held approvals stay pending and
    // fail closed; the chat /approve commands remain the escape hatch if the
    // ceremony is abandoned before the approval expires.
    if (queue.some((candidate) => externalPresentations.has(candidate.id))) {
      return;
    }
    const approval = queue.find(
      (candidate) =>
        !resolvingIds.has(candidate.id) &&
        !dismissedIds.has(candidate.id) &&
        matchesActiveSession(candidate),
    );
    if (!approval) {
      return;
    }
    activeId = approval.id;
    const surfaceLabel = approvalSurfaceLabel(approval);
    const pendingSessionApprovals = queue.filter((candidate) =>
      matchesActiveSession(candidate),
    ).length;

    const externalDecisions = approval.request.externalResolution?.decisions ?? [];
    const decisions = approval.request.externalResolution
      ? approval.request.allowedDecisions == null
        ? (["deny"] as const)
        : approval.request.allowedDecisions.filter((decision) => decision === "deny")
      : approval.request.allowedDecisions?.length
        ? approval.request.allowedDecisions
        : DEFAULT_DECISIONS;
    const canDispatchExternal = Boolean(
      deps.client.prepareExternalPluginApproval && deps.client.startExternalPluginApproval,
    );
    const items = [
      ...(canDispatchExternal
        ? externalDecisions.map((decision) => EXTERNAL_DECISION_ITEMS[decision])
        : []),
      ...decisions.map((decision) => DECISION_ITEMS[decision]),
    ];
    const selector = createSelector(items);
    let allowDecisionArmed = false;
    let prompt: PluginApprovalPrompt | null = null;
    const denyIndex = items.findIndex((item) => item.value === "deny");
    let selectedValue = items[denyIndex >= 0 ? denyIndex : 0]?.value;
    if (denyIndex >= 0) {
      selector.setSelectedIndex?.(denyIndex);
    }
    selector.onSelectionChange = (item) => {
      const decision = parseDecision(item.value) ?? parseExternalDecision(item.value);
      if (!decision || item.value === selectedValue) {
        return;
      }
      selectedValue = item.value;
      allowDecisionArmed = decision !== "deny";
      prompt?.setConfirmation("");
    };

    const resolve = async (decision: TuiApprovalDecision) => {
      if (activeId !== approval.id) {
        return;
      }
      clearExpiryTimer();
      activeId = null;
      resolvingIds.add(approval.id);
      closeActiveOverlay();
      deps.requestRender();
      let stale = false;
      try {
        if (!deps.client.resolvePluginApproval) {
          throw new Error("plugin approval resolution is unavailable");
        }
        const result = await deps.client.resolvePluginApproval(approval.id, decision);
        if (result?.ok === false) {
          stale = true;
        } else {
          remove(approval.id);
          deps.chatLog.addSystem(`${surfaceLabel}: ${decisionLabel(decision)}`);
        }
      } catch (error) {
        if (isApprovalStaleError(error)) {
          stale = true;
        } else {
          deps.chatLog.addSystem(`${surfaceLabel} failed: ${formatErrorMessage(error)}`);
        }
      }
      if (stale) {
        remove(approval.id);
        deps.chatLog.addSystem(`${surfaceLabel}: no longer pending`);
        try {
          await refreshApprovals();
        } catch (error) {
          deps.chatLog.addSystem(`${surfaceLabel} refresh failed: ${formatErrorMessage(error)}`);
        }
      }
      resolvingIds.delete(approval.id);
      presentNext();
      if (!disposed) {
        deps.requestRender();
      }
    };

    const dispatchExternal = async (decision: TuiExternalApprovalDecision) => {
      if (activeId !== approval.id) {
        return;
      }
      clearExpiryTimer();
      activeId = null;
      resolvingIds.add(approval.id);
      closeActiveOverlay();
      clearExternalPresentation(approval.id);
      deps.requestRender();
      try {
        if (!deps.client.prepareExternalPluginApproval) {
          throw new Error("external approval action preparation is unavailable");
        }
        const prepared = await deps.client.prepareExternalPluginApproval(approval.id, decision);
        if (disposed || !queue.some((candidate) => candidate.id === approval.id)) {
          resolvingIds.delete(approval.id);
          return;
        }
        if (!deps.client.startExternalPluginApproval) {
          throw new Error("external approval action dispatch is unavailable");
        }
        const result = await deps.client.startExternalPluginApproval(
          approval.id,
          decision,
          prepared.actionToken,
        );
        if (result.outcome === "stale-action") {
          throw new Error("external approval action is stale; retry from the current prompt");
        }
        if (
          result.presentations.length > 0 &&
          queue.some((candidate) => candidate.id === approval.id)
        ) {
          externalPresentations.set(approval.id, result.presentations);
          deps.chatLog.addPendingSystem(
            externalPresentationId(approval.id),
            result.presentations.join("\n\n"),
          );
        }
        // A successfully dispatched challenge closes the card so the QR stays
        // scannable and a stray Enter cannot mint a replacement that voids the
        // code mid-scan. The approval stays pending; refusal and retry stay
        // reachable through the /approve chat commands printed with the QR
        // (same recovery contract as an Escape dismissal). A failed dispatch
        // keeps the card so deny remains one keypress away.
        dismissedIds.add(approval.id);
        deps.chatLog.addSystem(
          `${surfaceLabel}: challenge sent — scan the QR above. Use /approve ${approval.id} deny to refuse.`,
        );
      } catch (error) {
        if (!disposed && queue.some((candidate) => candidate.id === approval.id)) {
          deps.chatLog.addSystem(`${surfaceLabel} failed: ${formatErrorMessage(error)}`);
        }
      }
      resolvingIds.delete(approval.id);
      presentNext();
      if (!disposed) {
        deps.requestRender();
      }
    };

    selector.onSelect = (item) => {
      const externalDecision = parseExternalDecision(item.value);
      const decision = parseDecision(item.value) ?? externalDecision;
      if (!decision) {
        return;
      }
      if (decision !== "deny" && !allowDecisionArmed) {
        allowDecisionArmed = true;
        prompt?.setConfirmation(`Press Enter again to confirm ${item.label}.`);
        deps.requestRender();
        return;
      }
      if (externalDecision) {
        void dispatchExternal(externalDecision);
        return;
      }
      void resolve(decision);
    };
    const dismiss = () => {
      clearExpiryTimer();
      dismissedIds.add(approval.id);
      activeId = null;
      closeActiveOverlay();
      deps.chatLog.addSystem(`${surfaceLabel}: dismissed; request remains pending`);
      presentNext();
      deps.requestRender();
    };
    selector.onCancel = () => {
      if (approval.request.externalResolution) {
        dismiss();
        return;
      }
      const deny = decisions.includes("deny") ? "deny" : null;
      if (deny) {
        void resolve(deny);
        return;
      }
      dismiss();
    };
    const timer = setTimeoutFn(
      () => {
        if (activeId !== approval.id) {
          return;
        }
        expiryTimer = null;
        activeId = null;
        remove(approval.id);
        closeActiveOverlay();
        deps.chatLog.addSystem(`${surfaceLabel}: expired`);
        presentNext();
        deps.requestRender();
      },
      Math.max(1, approval.expiresAtMs - nowMs()),
    );
    expiryTimer = timer;
    if (typeof timer !== "number") {
      timer.unref?.();
    }
    prompt = new PluginApprovalPrompt(
      surfaceLabel,
      approval,
      selector,
      externalPresentations.get(approval.id),
      pendingSessionApprovals,
    );
    activeOverlay = deps.openOverlay(prompt);
    deps.requestRender();
  };

  const applySnapshot = (approvals: TuiPluginApproval[], startedAtVersion: number) => {
    const next = new Map(approvals.map((approval) => [approval.id, approval]));
    for (const [id, mutation] of mutations) {
      if (mutation.version <= startedAtVersion) {
        mutations.delete(id);
        continue;
      }
      if (mutation.approval) {
        next.set(id, mutation.approval);
      } else {
        next.delete(id);
      }
    }
    for (const id of dismissedIds) {
      if (!next.has(id)) {
        dismissedIds.delete(id);
      }
    }
    queue = [...next.values()].toSorted((left, right) => left.createdAtMs - right.createdAtMs);
  };

  async function refreshOnce(): Promise<void> {
    if (disposed || !deps.client.listPluginApprovals) {
      return;
    }
    const startedAtVersion = mutationVersion;
    const payload = await deps.client.listPluginApprovals();
    if (disposed || !Array.isArray(payload)) {
      return;
    }
    const approvals: TuiPluginApproval[] = [];
    for (const entry of payload) {
      const approval = parseTuiPluginApproval(entry);
      if (approval) {
        approvals.push(approval);
      }
    }
    applySnapshot(approvals, startedAtVersion);
    if (activeId && !queue.some((approval) => approval.id === activeId)) {
      clearExpiryTimer();
      activeId = null;
      closeActiveOverlay();
    }
    presentNext();
    deps.requestRender();
  }

  const refreshApprovals = async (): Promise<void> => {
    if (disposed || !deps.client.listPluginApprovals) {
      return;
    }
    await refreshRunner.run();
  };

  return {
    handleEvent(event: string, payload: unknown) {
      if (disposed) {
        return;
      }
      if (event === "plugin.approval.requested") {
        const approval = parseTuiPluginApproval(payload);
        if (approval) {
          add(approval);
          presentNext();
        }
        return;
      }
      if (event !== "plugin.approval.resolved" && event !== "plugin.approval.removed") {
        return;
      }
      const id = parseResolvedApprovalId(payload);
      if (!id) {
        return;
      }
      remove(id);
      resolvingIds.delete(id);
      if (activeId === id) {
        clearExpiryTimer();
        activeId = null;
        closeActiveOverlay();
      }
      presentNext();
      deps.requestRender();
    },
    refresh: refreshApprovals,
    sessionChanged() {
      if (disposed) {
        return;
      }
      const activeApproval = activeId
        ? queue.find((approval) => approval.id === activeId)
        : undefined;
      if (activeApproval && !matchesActiveSession(activeApproval)) {
        clearExpiryTimer();
        activeId = null;
        closeActiveOverlay();
        deps.requestRender();
      }
      presentNext();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearExpiryTimer();
      queue = [];
      dismissedIds.clear();
      for (const id of externalPresentations.keys()) {
        deps.chatLog.dismissPendingSystem(externalPresentationId(id));
      }
      externalPresentations.clear();
      mutations.clear();
      resolvingIds.clear();
      if (activeId) {
        activeId = null;
        closeActiveOverlay();
        deps.requestRender();
      }
    },
  };
}
