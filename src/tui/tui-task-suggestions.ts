// Presents model-proposed follow-up tasks that belong to the active TUI session.
import {
  SelectList,
  Text,
  type Component,
  type OverlayHandle,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { TaskSuggestion } from "../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { selectListTheme, theme } from "./theme/theme.js";
import type { TuiBackend } from "./tui-backend.js";
import { sanitizeRenderableText } from "./tui-formatters.js";

type TaskSelector = Component & {
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  setSelectedIndex?: (index: number) => void;
};

type TaskSuggestionControllerDeps = {
  client: Pick<
    TuiBackend,
    | "getTaskSuggestionActionCapabilities"
    | "listTaskSuggestions"
    | "acceptTaskSuggestion"
    | "dismissTaskSuggestion"
  >;
  chatLog: { addSystem: (line: string) => void };
  getAgentId: () => string;
  getSessionKey: () => string;
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle?: OverlayHandle) => void;
  requestRender: () => void;
  onAccepted: (sessionKey: string) => Promise<void> | void;
  createSelector?: (items: SelectItem[]) => TaskSelector;
};

const TASK_BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const TASK_DETAIL_VIEWPORT_LINES = 12;
const TASK_DETAIL_PAGE_LINES = TASK_DETAIL_VIEWPORT_LINES - 1;
const PAGE_UP_INPUT = "\u001b[5~";
const PAGE_DOWN_INPUT = "\u001b[6~";

const TASK_ACTIONS = [
  {
    value: "accept",
    label: "Start in worktree",
    description: "Create an isolated session and begin this task",
  },
  {
    value: "dismiss",
    label: "Dismiss",
    description: "Leave the repository untouched",
  },
] satisfies SelectItem[];

function clean(text: string): string {
  return sanitizeTaskText(text.replace(/\s+/g, " ").trim());
}

function sanitizeTaskText(text: string): string {
  return sanitizeRenderableText(text.replace(TASK_BIDI_CONTROL_RE, ""));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parses the task suggestion shape carried by Gateway list and event payloads. */
export function parseTuiTaskSuggestion(value: unknown): TaskSuggestion | null {
  if (!isRecord(value)) {
    return null;
  }
  const required = ["id", "title", "prompt", "tldr", "cwd", "sessionKey"] as const;
  if (required.some((field) => typeof value[field] !== "string" || !value[field].trim())) {
    return null;
  }
  if (typeof value.createdAt !== "number" || value.createdAt < 0) {
    return null;
  }
  return {
    id: (value.id as string).trim(),
    title: (value.title as string).trim(),
    prompt: (value.prompt as string).trim(),
    tldr: (value.tldr as string).trim(),
    cwd: (value.cwd as string).trim(),
    sessionKey: (value.sessionKey as string).trim(),
    ...(typeof value.agentId === "string" && value.agentId.trim()
      ? { agentId: value.agentId.trim() }
      : {}),
    createdAt: value.createdAt,
  };
}

class TaskPrompt implements Component {
  private readonly title: Text;
  private readonly metadata: Text;
  private readonly summary: Text;
  private readonly instructionLabel = new Text(theme.system("Instructions:"));
  private readonly instructions: Text;
  private readonly detailPosition = new Text();
  private readonly confirmation = new Text();
  private detailOffset = 0;
  private detailLineCount = 0;

  constructor(
    suggestion: TaskSuggestion,
    private readonly selector: TaskSelector,
    private readonly requestRender: () => void,
  ) {
    this.title = new Text(theme.header(`Suggested follow-up: ${clean(suggestion.title)}`));
    this.metadata = new Text(theme.dim(`Project: ${clean(suggestion.cwd)}`));
    this.summary = new Text(theme.system(`Why: ${clean(suggestion.tldr)}`));
    this.instructions = new Text(theme.system(sanitizeTaskText(suggestion.prompt.trim())));
  }

  setConfirmation(text: string): void {
    this.confirmation.setText(theme.accent(text));
  }

  invalidate(): void {
    for (const component of [
      this.title,
      this.metadata,
      this.summary,
      this.instructionLabel,
      this.instructions,
      this.detailPosition,
      this.confirmation,
      this.selector,
    ]) {
      component.invalidate();
    }
  }

  render(width: number): string[] {
    // Page the complete confirmation details as one unit. This keeps actions
    // visible without hiding a long project-path suffix from the operator.
    const detailLines = [
      ...this.metadata.render(width),
      ...this.summary.render(width),
      ...this.instructionLabel.render(width),
      ...this.instructions.render(width),
    ];
    this.detailLineCount = detailLines.length;
    const maxDetailOffset = Math.max(0, detailLines.length - TASK_DETAIL_VIEWPORT_LINES);
    this.detailOffset = Math.min(this.detailOffset, maxDetailOffset);
    const visibleDetails = detailLines.slice(
      this.detailOffset,
      this.detailOffset + TASK_DETAIL_VIEWPORT_LINES,
    );
    if (detailLines.length > TASK_DETAIL_VIEWPORT_LINES) {
      const visibleEnd = this.detailOffset + visibleDetails.length;
      this.detailPosition.setText(
        theme.dim(
          `Details ${this.detailOffset + 1}-${visibleEnd} of ${detailLines.length} · PgUp/PgDn to inspect`,
        ),
      );
    } else {
      this.detailPosition.setText("");
    }
    const detailPosition = this.detailPosition.render(width);
    const confirmation = this.confirmation.render(width);
    return [
      ...this.title.render(width).slice(0, 2),
      ...visibleDetails,
      ...(detailPosition.some((line) => line.trim()) ? detailPosition : []),
      ...(confirmation.some((line) => line.trim()) ? ["", ...confirmation] : []),
      "",
      ...this.selector.render(width),
    ];
  }

  handleInput(data: string): void {
    if (data === PAGE_UP_INPUT || data === PAGE_DOWN_INPUT) {
      const maxOffset = Math.max(0, this.detailLineCount - TASK_DETAIL_VIEWPORT_LINES);
      const delta = data === PAGE_UP_INPUT ? -TASK_DETAIL_PAGE_LINES : TASK_DETAIL_PAGE_LINES;
      const nextOffset = Math.min(maxOffset, Math.max(0, this.detailOffset + delta));
      if (nextOffset !== this.detailOffset) {
        this.detailOffset = nextOffset;
        this.metadata.invalidate();
        this.summary.invalidate();
        this.instructionLabel.invalidate();
        this.instructions.invalidate();
        this.requestRender();
      }
      return;
    }
    this.selector.handleInput?.(data);
  }
}

/** Coordinates Gateway task-suggestion events with the active TUI overlay. */
export function createTuiTaskSuggestionController(deps: TaskSuggestionControllerDeps) {
  const createSelector =
    deps.createSelector ??
    ((items: SelectItem[]) => new SelectList(items, items.length, selectListTheme));
  const suggestions = new Map<string, TaskSuggestion>();
  const hiddenIds = new Set<string>();
  let activeId: string | null = null;
  let activeOverlay: OverlayHandle | null = null;
  let activeSelector: TaskSelector | null = null;
  let activeActionKey: string | null = null;
  let revision = 0;
  let disposed = false;
  let refreshInFlight: Promise<void> | null = null;
  let refreshAgain = false;

  const closeActive = () => {
    if (activeOverlay) {
      deps.closeOverlay(activeOverlay);
      activeOverlay = null;
    }
    activeId = null;
    activeSelector = null;
    activeActionKey = null;
  };

  const remove = (id: string) => {
    revision += 1;
    suggestions.delete(id);
    hiddenIds.delete(id);
    if (activeId === id) {
      closeActive();
    }
  };

  const matchesSession = (suggestion: TaskSuggestion) =>
    suggestion.sessionKey === deps.getSessionKey() &&
    (suggestion.sessionKey !== "global" || suggestion.agentId === deps.getAgentId());

  const availableActions = () => {
    const capabilities = deps.client.getTaskSuggestionActionCapabilities?.() ?? {
      canAccept: Boolean(deps.client.acceptTaskSuggestion),
      canDismiss: Boolean(deps.client.dismissTaskSuggestion),
    };
    return TASK_ACTIONS.filter((action) =>
      action.value === "accept" ? capabilities.canAccept : capabilities.canDismiss,
    );
  };

  const presentNext = () => {
    if (disposed) {
      return;
    }
    const actions = availableActions();
    const actionKey = actions.map((action) => action.value).join(",");
    if (activeId) {
      if (activeActionKey === actionKey) {
        return;
      }
      closeActive();
    }
    const suggestion = [...suggestions.values()]
      .toSorted((left, right) => left.createdAt - right.createdAt)
      .find((entry) => !hiddenIds.has(entry.id) && matchesSession(entry));
    if (!suggestion) {
      return;
    }

    if (actions.length === 0) {
      return;
    }

    activeId = suggestion.id;
    const selector = createSelector(actions);
    activeSelector = selector;
    activeActionKey = actionKey;
    const dismissIndex = actions.findIndex((action) => action.value === "dismiss");
    selector.setSelectedIndex?.(Math.max(dismissIndex, 0));
    let acceptArmed = false;
    let prompt: TaskPrompt | null = null;

    const resolve = async (action: "accept" | "dismiss") => {
      if (activeId !== suggestion.id || activeSelector !== selector) {
        return;
      }
      closeActive();
      hiddenIds.add(suggestion.id);
      deps.requestRender();
      try {
        if (action === "accept") {
          if (!deps.client.acceptTaskSuggestion) {
            throw new Error("task suggestion acceptance is unavailable");
          }
          const result = await deps.client.acceptTaskSuggestion(suggestion.id);
          remove(suggestion.id);
          deps.chatLog.addSystem(`follow-up task started in ${result.key}`);
          if (matchesSession(suggestion)) {
            await deps.onAccepted(result.key);
          }
        } else {
          if (!deps.client.dismissTaskSuggestion) {
            throw new Error("task suggestion dismissal is unavailable");
          }
          const result = await deps.client.dismissTaskSuggestion(suggestion.id);
          if (!result.dismissed) {
            throw new Error("task suggestion is no longer pending");
          }
          remove(suggestion.id);
          deps.chatLog.addSystem("follow-up task dismissed");
        }
      } catch (error) {
        hiddenIds.delete(suggestion.id);
        deps.chatLog.addSystem(`follow-up task failed: ${formatErrorMessage(error)}`);
        void refresh().catch((refreshError: unknown) => {
          deps.chatLog.addSystem(
            `task suggestion refresh failed: ${formatErrorMessage(refreshError)}`,
          );
        });
      }
      presentNext();
      if (!disposed) {
        deps.requestRender();
      }
    };

    selector.onSelectionChange = () => {
      acceptArmed = false;
      prompt?.setConfirmation("");
    };
    selector.onSelect = (item) => {
      if (activeSelector !== selector) {
        return;
      }
      if (!availableActions().some((action) => action.value === item.value)) {
        closeActive();
        presentNext();
        deps.requestRender();
        return;
      }
      if (item.value === "dismiss") {
        void resolve("dismiss");
        return;
      }
      if (item.value !== "accept") {
        return;
      }
      if (acceptArmed) {
        void resolve("accept");
        return;
      }
      acceptArmed = true;
      prompt?.setConfirmation("Press Enter again to start this task in a worktree.");
      deps.requestRender();
    };
    selector.onCancel = () => {
      if (activeSelector !== selector) {
        return;
      }
      hiddenIds.add(suggestion.id);
      closeActive();
      deps.chatLog.addSystem("follow-up task hidden; suggestion remains pending");
      presentNext();
      deps.requestRender();
    };
    prompt = new TaskPrompt(suggestion, selector, deps.requestRender);
    activeOverlay = deps.openOverlay(prompt);
    deps.requestRender();
  };

  const refresh = async (): Promise<void> => {
    if (disposed || !deps.client.listTaskSuggestions) {
      return;
    }
    if (refreshInFlight) {
      refreshAgain = true;
      return await refreshInFlight;
    }
    refreshInFlight = (async () => {
      do {
        refreshAgain = false;
        const startRevision = revision;
        const listed = await deps.client.listTaskSuggestions?.();
        if (disposed || !listed) {
          return;
        }
        // An event raced this snapshot. Retry instead of resurrecting resolved work.
        if (revision !== startRevision) {
          refreshAgain = true;
          continue;
        }
        suggestions.clear();
        for (const value of listed) {
          const suggestion = parseTuiTaskSuggestion(value);
          if (suggestion) {
            suggestions.set(suggestion.id, suggestion);
          }
        }
        for (const id of hiddenIds) {
          if (!suggestions.has(id)) {
            hiddenIds.delete(id);
          }
        }
      } while (refreshAgain);
      if (activeId && !suggestions.has(activeId)) {
        closeActive();
      }
      presentNext();
      deps.requestRender();
    })();
    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  };

  return {
    handleEvent(event: string, payload: unknown) {
      if (disposed || event !== "task.suggestion" || !isRecord(payload)) {
        return;
      }
      if (payload.action === "created") {
        const suggestion = parseTuiTaskSuggestion(payload.suggestion);
        if (suggestion) {
          revision += 1;
          hiddenIds.delete(suggestion.id);
          suggestions.set(suggestion.id, suggestion);
          presentNext();
        }
        return;
      }
      if (payload.action === "resolved" && typeof payload.taskId === "string") {
        remove(payload.taskId);
        presentNext();
        deps.requestRender();
      }
    },
    refresh,
    sessionChanged() {
      if (disposed) {
        return;
      }
      hiddenIds.clear();
      const active = activeId ? suggestions.get(activeId) : undefined;
      if (active && !matchesSession(active)) {
        closeActive();
      }
      presentNext();
      deps.requestRender();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      suggestions.clear();
      hiddenIds.clear();
      closeActive();
      deps.requestRender();
    },
  };
}
