// Control UI chat module implements tool cards behavior.
import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { icons, type IconName } from "../../../components/icons.ts";
import { isMarkdownBlockArtText } from "../../../components/markdown-text.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { resolveToolCallView, type ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import {
  formatDistinctCollapsedToolSummaryText as distinctSummaryText,
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  isToolCardError,
  resolveCollapsedToolArgumentPreview as toolArgumentPreview,
  resolveToolCardOutcome,
  type ToolPreview,
} from "../../../lib/chat/tool-cards.ts";
import {
  formatToolDetail,
  resolveToolDisplay,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";
import { getToolCallTitle } from "../tool-titles.ts";
import { renderDiffBlock, renderDiffStatChips } from "./chat-diff-render.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import { renderToolPreview } from "./widget-card.ts";

export {
  renderToolPreview,
  WIDGET_PROMPT_EVENT,
  type WidgetPromptEventDetail,
} from "./widget-card.ts";

type FullMessageRequest = NonNullable<
  Extract<SidebarContent, { kind: "markdown" }>["fullMessageRequest"]
>;

export function shouldToggleSelectableDisclosure(event: MouseEvent): boolean {
  if (event.detail === 0) {
    return true;
  }
  const target = event.currentTarget;
  const selection = window.getSelection();
  if (!(target instanceof Node) || !selection || selection.isCollapsed) {
    return true;
  }
  return ![selection.anchorNode, selection.focusNode].some(
    (node) => node !== null && target.contains(node),
  );
}

function formatToolOutputForSidebar(text: string): string {
  if (isMarkdownBlockArtText(text)) {
    return "```\n" + text + "\n```";
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return "```json\n" + JSON.stringify(JSON.parse(trimmed), null, 2) + "\n```";
    } catch {
      return text;
    }
  }
  return text;
}

function renderToolIcon(name: string) {
  return icons[name as IconName] ?? icons.puzzle;
}

function formatPayloadForSidebar(
  text: string | undefined,
  language: "json" | "text" = "text",
): string {
  if (!text?.trim()) {
    return "";
  }
  if (language === "json") {
    return `\`\`\`json
${text}
\`\`\``;
  }
  const formatted = formatToolOutputForSidebar(text);
  if (formatted.includes("```")) {
    return formatted;
  }
  return `\`\`\`text
${text}
\`\`\``;
}

function buildToolCardSidebarContent(card: ToolCard): string {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const isError = isToolCardError(card);
  const outcome = resolveToolCardOutcome(card, false);
  const sections = [`## ${display.label}`, `**${t("chat.toolCards.tool")}:** \`${display.name}\``];

  if (detail) {
    sections.push(`**${t("chat.toolCards.summary")}:** ${detail}`);
  }

  if (card.inputText?.trim()) {
    const inputIsJson = typeof card.args === "object" && card.args !== null;
    sections.push(
      `### ${t("chat.toolCards.toolInput")}\n${formatPayloadForSidebar(card.inputText, inputIsJson ? "json" : "text")}`,
    );
  }

  if (card.outputText?.trim()) {
    sections.push(
      `### ${t(isError ? "chat.toolCards.toolError" : "chat.toolCards.toolOutput")}\n${formatToolOutputForSidebar(card.outputText)}`,
    );
  } else {
    sections.push(
      isError
        ? `### ${t("chat.toolCards.toolError")}\n*${t("chat.toolCards.noOutputFailed")}*`
        : outcome === "succeeded"
          ? `### ${t("chat.toolCards.toolOutput")}\n*${t("chat.toolCards.noOutputSucceeded")}*`
          : `### ${t("chat.toolCards.toolOutput")}\n*${t("chat.toolCards.noResult")}*`,
    );
  }

  return sections.join("\n\n");
}

function handleRawDetailsToggle(event: Event) {
  const button = event.currentTarget as HTMLButtonElement | null;
  const root = button?.closest(".chat-tool-card__raw");
  const body = root?.querySelector<HTMLElement>(".chat-tool-card__raw-body");
  if (!button || !body) {
    return;
  }
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  body.hidden = expanded;
}

function buildSidebarContent(
  value: string,
  options?: {
    rawText?: string | null;
    fullMessageRequest?: FullMessageRequest;
  },
): SidebarContent {
  return {
    kind: "markdown",
    content: value,
    ...(options?.rawText ? { rawText: options.rawText } : {}),
    ...(options?.fullMessageRequest ? { fullMessageRequest: options.fullMessageRequest } : {}),
  };
}

function buildPreviewSidebarContent(
  preview: ToolPreview,
  rawText?: string | null,
  options?: { fullMessageRequest?: FullMessageRequest },
): SidebarContent | null {
  if (preview.kind !== "canvas" || preview.render !== "url" || !preview.viewId || !preview.url) {
    return null;
  }
  return {
    kind: "canvas",
    docId: preview.viewId,
    entryUrl: preview.url,
    ...(preview.title ? { title: preview.title } : {}),
    ...(preview.preferredHeight ? { preferredHeight: preview.preferredHeight } : {}),
    // The per-preview sandbox ceiling must survive the sidebar conversion, or a
    // trusted global embed mode would re-grant same-origin to widget script.
    ...(preview.sandbox ? { sandbox: preview.sandbox } : {}),
    ...(rawText ? { rawText } : {}),
    ...(options?.fullMessageRequest ? { fullMessageRequest: options.fullMessageRequest } : {}),
  };
}

function buildToolSidebarFullMessageRequest(
  card: ToolCard,
  sessionKey: string | undefined,
): FullMessageRequest | undefined {
  if (!sessionKey || !card.messageId) {
    return undefined;
  }
  // A transcript entry can contain multiple tool blocks. Until the request can
  // identify a specific block, upgrading by message id can show the wrong tool.
  return undefined;
}

export function renderRawOutputToggle(text: string) {
  return html`
    <div class="chat-tool-card__raw">
      <button
        class="chat-inline-disclosure chat-tool-card__raw-toggle"
        type="button"
        aria-expanded="false"
        @click=${handleRawDetailsToggle}
      >
        <span>${t("chat.toolCards.rawDetails")}</span>
        <span class="chat-inline-disclosure__chevron" aria-hidden="true">${icons.chevronDown}</span>
      </button>
      <div class="chat-tool-card__raw-body" hidden>
        ${renderToolDataBlock({ label: t("chat.toolCards.toolOutput"), text })}
      </div>
    </div>
  `;
}

function renderToolDataBlock(params: { label: string; text: string }) {
  const { label, text } = params;
  const codeClass = isMarkdownBlockArtText(text) ? "markdown-block-art" : "";
  const showLabel = label !== t("chat.toolCards.toolOutput");
  return html`
    <div class="chat-tool-card__block">
      ${showLabel
        ? html`<div class="chat-tool-card__block-header">
            <span class="chat-tool-card__block-icon">${icons.zap}</span>
            <span class="chat-tool-card__block-label">${label}</span>
          </div>`
        : nothing}
      <pre class="chat-tool-card__block-content"><code class=${codeClass}>${text}</code></pre>
    </div>
  `;
}

// ── Kind-aware tool rows (command / read / edit / write / search / fetch) ──

const TOOL_ROW_VERB_KEYS: Partial<Record<ToolCallView["kind"], string>> = {
  read: "chat.toolCards.verbs.read",
  search: "chat.toolCards.verbs.searched",
  fetch: "chat.toolCards.verbs.fetched",
};

const MUTATION_VERB_KEYS = {
  update: {
    running: "chat.toolCards.verbs.editing",
    succeeded: "chat.toolCards.verbs.edited",
    fallback: "chat.toolCards.verbs.edit",
  },
  add: {
    running: "chat.toolCards.verbs.creating",
    succeeded: "chat.toolCards.verbs.created",
    fallback: "chat.toolCards.verbs.create",
  },
  delete: {
    running: "chat.toolCards.verbs.deleting",
    succeeded: "chat.toolCards.verbs.deleted",
    fallback: "chat.toolCards.verbs.delete",
  },
  mixed: {
    running: "chat.toolCards.verbs.changing",
    succeeded: "chat.toolCards.verbs.changed",
    fallback: "chat.toolCards.verbs.change",
  },
  write: {
    running: "chat.toolCards.verbs.writing",
    succeeded: "chat.toolCards.verbs.wrote",
    fallback: "chat.toolCards.verbs.write",
  },
} as const;

function resolveMutationVerbKind(view: ToolCallView): keyof typeof MUTATION_VERB_KEYS | undefined {
  if (view.kind === "write") {
    return "write";
  }
  if (view.kind !== "edit") {
    return undefined;
  }
  const operations = new Set(view.fileOperations?.map(({ operation }) => operation));
  return operations.size > 1 ? "mixed" : (operations.values().next().value ?? "update");
}

function resolveToolRowVerb(view: ToolCallView, outcome: ToolCardOutcome): string | undefined {
  const mutation = resolveMutationVerbKind(view);
  if (mutation) {
    const keys = MUTATION_VERB_KEYS[mutation];
    const key =
      outcome === "running"
        ? keys.running
        : outcome === "succeeded"
          ? keys.succeeded
          : keys.fallback;
    return t(key);
  }
  const key = TOOL_ROW_VERB_KEYS[view.kind];
  return key ? t(key) : undefined;
}

const TOOL_ROW_ICONS: Partial<Record<ToolCallView["kind"], string>> = {
  command: "terminal",
  read: "fileText",
  edit: "penLine",
  write: "fileCode",
  search: "search",
  fetch: "globe",
};

function firstCommandLine(command: string): string {
  return command.split("\n")[0]?.trim() ?? "";
}

function compactToolTarget(target: string, kind: ToolCallView["kind"]): string {
  if (kind !== "edit" && kind !== "write") {
    return target;
  }
  return target.split(/[\\/]/u).filter(Boolean).at(-1) ?? target;
}

export function syncToolDisclosureOverflow(event: Event): void {
  const disclosure = event.currentTarget;
  if (!(disclosure instanceof HTMLElement)) {
    return;
  }
  const content = disclosure.querySelector<HTMLElement>(".chat-tool-disclosure__content");
  disclosure.classList.toggle(
    "chat-tool-disclosure--overflowing",
    Boolean(content && content.scrollWidth > content.clientWidth),
  );
}

function renderToolRowContent(card: ToolCard, view: ToolCallView, outcome: ToolCardOutcome) {
  if (view.kind === "command" && view.command) {
    const commandPreview = firstCommandLine(view.command);
    return html`
      <span class="chat-tool-row__prompt" aria-hidden="true">$</span>
      <code class="chat-tool-row__cmd">${renderHighlightedCommand(commandPreview)}</code>
    `;
  }

  const verb = resolveToolRowVerb(view, outcome);
  if (verb && view.target) {
    const stat =
      outcome === "succeeded"
        ? view.stat
        : outcome === "running" && (view.kind === "edit" || view.kind === "write")
          ? card.liveDiffStat
          : undefined;
    return html`
      <span class="chat-tool-row__verb">${verb}</span>
      <span class="chat-tool-row__target">${compactToolTarget(view.target, view.kind)}</span>
      ${stat ? renderDiffStatChips(stat) : nothing}
      ${view.targetDetail && view.kind !== "edit" && view.kind !== "write"
        ? html`<span class="chat-tool-row__detail">${view.targetDetail}</span>`
        : nothing}
    `;
  }

  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  const summary = resolveCollapsedToolSummaryParts({
    card,
    displayLabel: display.label,
    displayDetail: display.detail,
  });
  const displayLabel = formatCollapsedToolSummaryText(summary.label) ?? summary.label;
  const argumentPreview = toolArgumentPreview(card.args);
  const displayName = distinctSummaryText(argumentPreview ?? summary.name, displayLabel);
  const aiTitle = getToolCallTitle(card.name, card.args);
  if (aiTitle) {
    return html`
      <span class="chat-tool-row__title">${aiTitle}</span>
      <span class="chat-tool-row__detail">${argumentPreview ?? displayLabel}</span>
    `;
  }
  return html`
    <span class="chat-tool-msg-summary__label">${displayLabel}</span>
    ${displayName
      ? html`<span class="chat-tool-msg-summary__names">${displayName}</span>`
      : nothing}
  `;
}

type ProgressReceiptStep = {
  step: string;
  status: "pending" | "in_progress" | "completed";
};

function progressReceiptSteps(value: unknown): ProgressReceiptStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const step = asNullableRecord(entry);
    if (
      typeof step?.step !== "string" ||
      (step.status !== "pending" && step.status !== "in_progress" && step.status !== "completed")
    ) {
      return [];
    }
    return [{ step: step.step, status: step.status }];
  });
}

function renderProgressCardReceipt(card: ToolCard, outcome: ToolCardOutcome) {
  if (card.name.trim().toLowerCase() !== "progress_card") {
    return null;
  }
  const args = asNullableRecord(card.args);
  const steps = progressReceiptSteps(args?.plan);
  const markdown = typeof args?.markdown === "string" ? args.markdown.trim() : "";
  const completed = steps.filter((step) => step.status === "completed").length;
  const current =
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status === "pending") ??
    steps.findLast((step) => step.status === "completed");
  const label =
    outcome === "failed"
      ? t("sessionProgressCard.receipt.failed")
      : outcome === "running"
        ? t("sessionProgressCard.receipt.updating")
        : steps.length > 0
          ? t("sessionProgressCard.receipt.updated", {
              completed: String(completed),
              current: current?.step ?? "",
              total: String(steps.length),
            })
          : markdown
            ? t("sessionProgressCard.receipt.noteUpdated")
            : t("sessionProgressCard.receipt.cleared");
  return html`<div class="chat-tool-msg-collapse chat-progress-card-receipt">
    <div class="chat-tool-msg-summary chat-tool-row" role="status">
      <span class="chat-tool-msg-summary__icon">${renderToolIcon("listChecks")}</span>
      <span class="chat-tool-msg-summary__label">${label}</span>
      ${outcome === "failed"
        ? html`<span class="chat-tool-row__badge">${t("chat.toolCards.failed")}</span>`
        : nothing}
      ${outcome === "running"
        ? html`<span
            class="chat-tool-row__spinner"
            aria-label=${t("chat.toolCards.running")}
          ></span>`
        : nothing}
    </div>
  </div>`;
}

function renderFileToolRowContent(
  card: ToolCard,
  view: ToolCallView,
  outcome: ToolCardOutcome,
  workspaceFilePath: string | null,
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void,
) {
  const verb = resolveToolRowVerb(view, outcome);
  if (!verb || !view.target) {
    return renderToolRowContent(card, view, outcome);
  }
  const stat =
    outcome === "succeeded"
      ? view.stat
      : outcome === "running"
        ? card.liveDiffStat
        : undefined;
  const filename = compactToolTarget(view.target, view.kind);
  return html`
    <span class="chat-tool-row__verb">${verb}</span>
    ${workspaceFilePath && onOpenWorkspaceFile
      ? html`<button
          class="chat-tool-row__file-link"
          type="button"
          title=${t("chat.toolCards.openFile")}
          @click=${(event: MouseEvent) => {
            event.stopPropagation();
            onOpenWorkspaceFile({ path: workspaceFilePath });
          }}
        >
          ${filename}
        </button>`
      : html`<span class="chat-tool-row__target">${filename}</span>`}
    ${stat ? renderDiffStatChips(stat) : nothing}
  `;
}

// ── Command syntax highlighting ──

type CommandToken = { text: string; cls: "name" | "flag" | "str" | "num" | "op" | "plain" | "ws" };

const COMMAND_HIGHLIGHT_MAX_CHARS = 2_000;
const COMMAND_OP_CHARS = new Set(["|", ";", "&", "<", ">"]);

/** Small shell-ish tokenizer for display colors only; never used for execution. */
function tokenizeCommand(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let index = 0;
  let expectName = true;
  while (index < command.length) {
    const char = command.charAt(index);
    if (/\s/.test(char)) {
      let end = index;
      while (end < command.length && /\s/.test(command.charAt(end))) {
        end++;
      }
      tokens.push({ text: command.slice(index, end), cls: "ws" });
      index = end;
      continue;
    }
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < command.length && command.charAt(end) !== char) {
        end += command.charAt(end) === "\\" ? 2 : 1;
      }
      end = Math.min(end + 1, command.length);
      tokens.push({ text: command.slice(index, end), cls: "str" });
      index = end;
      expectName = false;
      continue;
    }
    if (COMMAND_OP_CHARS.has(char)) {
      let end = index;
      while (end < command.length && COMMAND_OP_CHARS.has(command.charAt(end))) {
        end++;
      }
      tokens.push({ text: command.slice(index, end), cls: "op" });
      index = end;
      expectName = true;
      continue;
    }
    let end = index;
    while (
      end < command.length &&
      !/\s/.test(command.charAt(end)) &&
      !COMMAND_OP_CHARS.has(command.charAt(end)) &&
      command.charAt(end) !== "'" &&
      command.charAt(end) !== '"'
    ) {
      end++;
    }
    const word = command.slice(index, end);
    const cls = expectName
      ? "name"
      : word.startsWith("-")
        ? "flag"
        : /^\d+(?:[.,]\d+)?$/.test(word)
          ? "num"
          : "plain";
    tokens.push({ text: word, cls });
    index = end;
    expectName = false;
  }
  return tokens;
}

function renderHighlightedCommand(command: string) {
  if (command.length > COMMAND_HIGHLIGHT_MAX_CHARS) {
    return html`${command}`;
  }
  return html`${tokenizeCommand(command).map((token) =>
    token.cls === "ws" || token.cls === "plain"
      ? html`${token.text}`
      : html`<span class="chat-cmd--${token.cls}">${token.text}</span>`,
  )}`;
}

// ── Key-value args display (generic tools) ──

const KV_MAX_KEYS = 12;
const KV_MAX_VALUE_CHARS = 400;

function formatKeyValue(value: unknown): string {
  if (typeof value === "string") {
    return truncateUtf16Safe(value, KV_MAX_VALUE_CHARS);
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return truncateUtf16Safe(JSON.stringify(value), KV_MAX_VALUE_CHARS);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function renderArgsKeyValueList(args: Record<string, unknown>) {
  return html`
    <div class="chat-tool-kv">
      ${Object.entries(args).map(
        ([key, value]) => html`
          <div class="chat-tool-kv__row">
            <span class="chat-tool-kv__key">${key}:</span>
            <span class="chat-tool-kv__value">${formatKeyValue(value)}</span>
          </div>
        `,
      )}
    </div>
  `;
}

function canRenderArgsAsKeyValue(args: unknown): args is Record<string, unknown> {
  if (!isRecord(args)) {
    return false;
  }
  const keys = Object.keys(args);
  return keys.length > 0 && keys.length <= KV_MAX_KEYS;
}

// Args already represented in the collapsed row / header detail for kinds that
// summarize their primary target; everything else stays auditable on expand.
const ROW_SUMMARIZED_ARG_KEYS: Partial<Record<ToolCallView["kind"], ReadonlySet<string>>> = {
  read: new Set(["path", "file_path", "filePath", "notebook_path"]),
  search: new Set(["pattern", "query", "glob", "path"]),
  fetch: new Set(["url"]),
};

function extraArgsBeyondRowTarget(
  args: unknown,
  kind: ToolCallView["kind"],
): Record<string, unknown> | null {
  if (!isRecord(args)) {
    return null;
  }
  const summarized = ROW_SUMMARIZED_ARG_KEYS[kind];
  if (!summarized) {
    return args;
  }
  const extras = Object.fromEntries(Object.entries(args).filter(([key]) => !summarized.has(key)));
  return Object.keys(extras).length > 0 ? extras : null;
}

function resolveToolWorkspaceFilePath(card: ToolCard, view: ToolCallView): string | null {
  const args = asNullableRecord(card.args);
  if (args) {
    for (const key of ["path", "file_path", "filePath", "notebook_path"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  const fallback = `${view.targetDetail ? `${view.targetDetail}/` : ""}${view.target ?? ""}`;
  return fallback.trim() || null;
}

function renderToolWorkspaceFilePath(
  label: string,
  path: string | null,
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void,
) {
  return path && onOpenWorkspaceFile
    ? html`
        <button
          class="chat-tool-card__detail chat-tool-card__detail-link"
          type="button"
          title=${t("chat.toolCards.openFile")}
          @click=${() => onOpenWorkspaceFile({ path })}
        >
          ${label}
        </button>
      `
    : html`<div class="chat-tool-card__detail">${label}</div>`;
}

function renderToolOutcome(outcome: ToolCardOutcome, exitCode?: number) {
  const label =
    outcome === "failed"
      ? exitCode === undefined
        ? t("chat.toolCards.failed")
        : t("chat.toolCards.exitCode", { code: String(exitCode) })
      : outcome === "running"
        ? t("chat.toolCards.running")
        : outcome === "succeeded"
          ? t("chat.toolCards.completed")
          : null;
  return label ? html`<div class="chat-tool-card__outcome">${label}</div>` : nothing;
}

function renderTerminalBlock(
  command: string,
  output: string | undefined,
  outcome: ToolCardOutcome,
  exitCode?: number,
) {
  return html`
    <div class="chat-tool-term">
      <div class="chat-tool-term__cmd">
        <span class="chat-tool-term__prompt">$</span
        ><code>${renderHighlightedCommand(command)}</code>
      </div>
      ${output?.trim()
        ? html`<pre class="chat-tool-term__out"><code>${output}</code></pre>`
        : nothing}
      ${renderToolOutcome(outcome, exitCode)}
    </div>
  `;
}

function serializeDiff(lines: readonly { kind: string; text: string }[]): string {
  return lines
    .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`)
    .join("\n");
}

export function resolveCollapsedToolDetail(card: ToolCard, displayDetail: string | undefined) {
  const directDetail = displayDetail?.trim();
  if (directDetail) {
    return displayDetail;
  }
  if (typeof card.args !== "string") {
    return undefined;
  }
  const inputText = card.inputText?.trim() ? card.inputText : card.args;
  return formatCollapsedToolPreviewText(inputText);
}

function resolveCollapsedToolSummaryParts(params: {
  card: ToolCard;
  displayLabel: string;
  displayDetail: string | undefined;
}): { label: string; name?: string } {
  const displayDetail = params.displayDetail?.trim();
  if (displayDetail) {
    return { label: params.displayLabel, name: displayDetail };
  }

  return {
    label:
      typeof params.card.args === "string"
        ? (resolveCollapsedToolDetail(params.card, undefined) ?? params.displayLabel)
        : params.displayLabel,
  };
}

export function isRunningToolCard(card: ToolCard, runActive: boolean | undefined): boolean {
  // Only live tool-stream cards can be running; historical transcript calls
  // without results (aborted runs) must stay inert during later runs. The
  // result event ends the running state — partial streamed output does not.
  return resolveToolCardOutcome(card, runActive) === "running";
}

export function resolveToolRowText(card: ToolCard, runActive?: boolean): string {
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  if (view.kind === "command" && view.command) {
    return `$ ${firstCommandLine(view.command)}`;
  }
  const verb = resolveToolRowVerb(view, resolveToolCardOutcome(card, runActive));
  if (verb && view.target) {
    return `${verb} ${view.target}`;
  }
  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  return [display.label, toolArgumentPreview(card.args)].filter(Boolean).join(" ");
}

export function renderToolCard(
  card: ToolCard,
  opts: {
    expanded: boolean;
    onToggleExpanded: (id: string) => void;
    runActive?: boolean;
    sessionKey?: string;
    agentId?: string;
    onOpenSidebar?: (content: SidebarContent) => void;
    onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
    canvasPluginSurfaceUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
) {
  const outcome = resolveToolCardOutcome(card, opts.runActive);
  const progressReceipt = renderProgressCardReceipt(card, outcome);
  if (progressReceipt) {
    return progressReceipt;
  }
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  const isError = outcome === "failed";
  const isRunning = outcome === "running";
  const expanded = opts.expanded || isRunning;
  const icon = TOOL_ROW_ICONS[view.kind] ?? display.icon;
  const workspaceFilePath =
    view.kind === "edit" || view.kind === "write" ? resolveToolWorkspaceFilePath(card, view) : null;
  const isFileMutation = Boolean(workspaceFilePath && (view.kind === "edit" || view.kind === "write"));

  return html`
    <div
      class="chat-tool-msg-collapse chat-tool-msg-collapse--manual ${expanded
        ? "is-open"
        : ""}"
    >
      ${isFileMutation
        ? html`<div
            class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row chat-tool-row--file ${isRunning
              ? "chat-tool-row--running"
              : ""}"
            @pointerenter=${syncToolDisclosureOverflow}
            @focusin=${syncToolDisclosureOverflow}
          >
            <button
              class="chat-tool-row__toggle"
              type="button"
              aria-expanded=${String(expanded)}
              aria-label=${resolveToolRowText(card, opts.runActive)}
              @click=${() => opts.onToggleExpanded(card.id)}
            ></button>
            <span class="chat-tool-msg-summary__icon">${renderToolIcon(icon)}</span>
            <span class="chat-tool-disclosure__content"
              >${renderFileToolRowContent(
                card,
                view,
                outcome,
                workspaceFilePath,
                opts.onOpenWorkspaceFile,
              )}</span
            >
            <span class="chat-tool-row__chevron" aria-hidden="true">${icons.chevronRight}</span>
          </div>`
        : html`<button
        class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row ${isRunning
          ? "chat-tool-row--running"
          : ""}"
        type="button"
        aria-expanded=${String(expanded)}
        @pointerenter=${syncToolDisclosureOverflow}
        @focus=${syncToolDisclosureOverflow}
        @click=${(event: MouseEvent) => {
          if (shouldToggleSelectableDisclosure(event)) {
            opts.onToggleExpanded(card.id);
          }
        }}
      >
        <span class="chat-tool-msg-summary__icon">${renderToolIcon(icon)}</span>
        <span class="chat-tool-disclosure__content"
          >${renderToolRowContent(card, view, outcome)}</span
        >
        <span class="chat-tool-row__chevron" aria-hidden="true">${icons.chevronRight}</span>
      </button>`}
      ${expanded
        ? html`
            <div class="chat-tool-msg-body">
              ${renderExpandedToolCardContent(
                card,
                opts.sessionKey,
                opts.onOpenSidebar,
                opts.canvasPluginSurfaceUrl,
                opts.embedSandboxMode ?? "scripts",
                opts.allowExternalEmbedUrls ?? false,
                opts.runActive,
                opts.onOpenWorkspaceFile,
              )}
            </div>
          `
        : nothing}
    </div>
  `;
}

export function renderExpandedToolCardContent(
  card: ToolCard,
  sessionKey?: string,
  onOpenSidebar?: (content: SidebarContent) => void,
  canvasPluginSurfaceUrl?: string | null,
  embedSandboxMode: EmbedSandboxMode = "scripts",
  allowExternalEmbedUrls = false,
  runActive?: boolean,
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void,
) {
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  // File/search rows already carry their target; the "with …" connector only
  // reads well for generic tools ("with query …"), not "with from sessions.ts".
  const detail =
    view.kind === "read" || view.kind === "search" || view.kind === "fetch"
      ? display.detail
      : formatToolDetail(display);
  const hasOutput = Boolean(card.outputText?.trim());
  const hasInput = Boolean(card.inputText?.trim());
  const isError = isToolCardError(card);
  const outcome = resolveToolCardOutcome(card, runActive);
  const workspaceFilePath =
    view.kind === "read" || view.kind === "edit" || view.kind === "write"
      ? resolveToolWorkspaceFilePath(card, view)
      : null;
  const canOpenSidebar = Boolean(onOpenSidebar);
  const fullMessageRequest = buildToolSidebarFullMessageRequest(card, sessionKey);
  const previewSidebarContent =
    card.preview?.kind === "canvas"
      ? buildPreviewSidebarContent(card.preview, card.outputText, { fullMessageRequest })
      : null;
  const sidebarActionContent =
    previewSidebarContent ??
    buildSidebarContent(buildToolCardSidebarContent(card), {
      fullMessageRequest,
      rawText: card.outputText ?? null,
    });
  const visiblePreview = card.preview
    ? renderToolPreview(card.preview, "chat_tool", {
        onOpenSidebar,
        rawText: card.outputText,
        canvasPluginSurfaceUrl,
        embedSandboxMode,
        allowExternalEmbedUrls,
        sessionKey,
      })
    : nothing;
  const sidebarAction = canOpenSidebar
    ? html`
        <openclaw-tooltip content=${t("chat.toolCards.openDetails")}>
          <button
            class="chat-tool-card__action-btn"
            type="button"
            @click=${() => onOpenSidebar?.(sidebarActionContent)}
            aria-label=${t("chat.toolCards.openDetails")}
          >
            <span class="chat-tool-card__action-icon">${icons.panelRightOpen}</span>
          </button>
        </openclaw-tooltip>
      `
    : nothing;
  const diffCopyAction =
    view.diff && view.diff.length > 0
      ? html`
          <openclaw-tooltip content=${t("common.copy")}>
            <button
              class="chat-tool-card__action-btn"
              type="button"
              @click=${() => void copyToClipboard(serializeDiff(view.diff ?? []))}
              aria-label=${t("common.copy")}
            >
              <span class="chat-tool-card__action-icon">${icons.copy}</span>
            </button>
          </openclaw-tooltip>
        `
      : nothing;

  // Command calls render terminal-style: `$ command` + raw output. Remaining
  // args (workdir, timeout, env…) stay visible as key-value rows so identical
  // commands in different contexts remain distinguishable in the audit trail.
  if (view.kind === "command" && view.command && !card.preview) {
    const argsRecord = asNullableRecord(card.args);
    const extraArgs = Object.fromEntries(
      Object.entries(argsRecord ?? {}).filter(([key]) => key !== "command"),
    );
    return html`
      <div class="chat-tool-card chat-tool-card--flush ${isError ? "chat-tool-card--error" : ""}">
        <div class="chat-tool-card__actions">${sidebarAction}</div>
        ${renderTerminalBlock(
          view.command,
          card.outputText,
          outcome,
          card.exitCode,
        )}
        ${Object.keys(extraArgs).length > 0 ? renderArgsKeyValueList(extraArgs) : nothing}
      </div>
    `;
  }

  // Edits and writes with a resolvable diff render it inline; the raw tool
  // output stays reachable behind the raw-details toggle.
  if ((view.kind === "edit" || view.kind === "write") && view.diff && view.diff.length > 0) {
    return html`
      <div class="chat-tool-card ${isError ? "chat-tool-card--error" : ""}">
        <div class="chat-tool-card__header">
          ${renderToolWorkspaceFilePath(
            workspaceFilePath ?? view.target ?? "",
            workspaceFilePath,
            onOpenWorkspaceFile,
          )}
          <div class="chat-tool-card__actions">${diffCopyAction}${sidebarAction}</div>
        </div>
        ${renderDiffBlock(view.diff, outcome)}
        ${renderToolOutcome(outcome, card.exitCode)}
        ${isError && hasOutput
          ? renderToolDataBlock({ label: t("chat.toolCards.toolError"), text: card.outputText! })
          : hasOutput
            ? renderRawOutputToggle(card.outputText!)
            : nothing}
      </div>
    `;
  }

  // File reads and searches summarize their primary target in the row, so the
  // full args JSON is noise — but any remaining args (filters, limits, request
  // options…) stay visible as key-value rows for auditability.
  const summarizedKind = view.kind === "read" || view.kind === "search" || view.kind === "fetch";
  const inputBlockArgs = summarizedKind
    ? extraArgsBeyondRowTarget(card.args, view.kind)
    : card.args;
  const showInputBlock = hasInput && (!summarizedKind || inputBlockArgs !== null);

  return html`
    <div class="chat-tool-card ${isError ? "chat-tool-card--error" : ""}">
      ${detail || canOpenSidebar
        ? html`
            <div class="chat-tool-card__header">
              ${detail
                ? view.kind === "read"
                  ? renderToolWorkspaceFilePath(detail, workspaceFilePath, onOpenWorkspaceFile)
                  : html`<div class="chat-tool-card__detail">${detail}</div>`
                : nothing}
              ${sidebarAction}
            </div>
          `
        : nothing}
      ${showInputBlock
        ? canRenderArgsAsKeyValue(inputBlockArgs)
          ? renderArgsKeyValueList(inputBlockArgs)
          : renderToolDataBlock({
              label: t("chat.toolCards.toolInput"),
              text: card.inputText!,
            })
        : nothing}
      ${hasOutput
        ? card.preview
          ? html`${visiblePreview} ${renderRawOutputToggle(card.outputText!)}`
          : renderToolDataBlock({
              label: t(isError ? "chat.toolCards.toolError" : "chat.toolCards.toolOutput"),
              text: card.outputText!,
            })
        : isError
          ? renderToolDataBlock({
              label: t("chat.toolCards.toolError"),
              text: t("chat.toolCards.noOutputFailed"),
            })
          : nothing}
      ${renderToolOutcome(outcome, card.exitCode)}
    </div>
  `;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
