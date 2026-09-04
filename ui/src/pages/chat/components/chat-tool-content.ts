import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { renderCopyButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import { isMarkdownBlockArtText } from "../../../components/markdown-text.ts";
import "../../../components/tooltip.ts";
import { syncTabGroupLabel } from "../../../components/web-awesome-tabs.ts";
import { t } from "../../../i18n/index.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import type { DiffFilePaths } from "../../../lib/chat/tool-call-diff.ts";
import { resolveToolCallView, type ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import {
  isToolCardError,
  resolveToolCardOutcome,
  type ToolPreview,
} from "../../../lib/chat/tool-cards.ts";
import { formatToolDetail, resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { renderHighlightedCommand } from "./chat-command-highlight.ts";
import { renderDiffBlock } from "./chat-diff-render.ts";
import type { SidebarContent } from "./chat-sidebar.ts";

function formatToolOutputForSidebar(text: string): string {
  if (isMarkdownBlockArtText(text)) {
    return "```\n" + text + "\n```";
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      // Keep the source literal: reserialization can change numbers, escapes, and duplicate keys.
      return "```json\n" + trimmed + "\n```";
    } catch {
      return text;
    }
  }
  return text;
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
  // SAFETY: This handler is attached only to the raw-details button below.
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

function buildSidebarContent(value: string, options?: { rawText?: string | null }): SidebarContent {
  return {
    kind: "markdown",
    content: value,
    ...(options?.rawText ? { rawText: options.rawText } : {}),
  };
}

function buildPreviewSidebarContent(
  preview: ToolPreview,
  rawText?: string | null,
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
  };
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
      <div class="chat-tool-card__raw-body" hidden>${renderToolDataBlock({ text })}</div>
    </div>
  `;
}

// Plain tool output is the block's default content, so it carries no header;
// only input/error blocks need a label to stay distinguishable.
function renderToolDataBlock(params: { label?: string; text: string }) {
  const { label, text } = params;
  const codeClass = isMarkdownBlockArtText(text) ? "markdown-block-art" : "";
  return html`
    <div class="chat-tool-card__block">
      ${
        label
          ? html`<div class="chat-tool-card__block-header">
              <span class="chat-tool-card__block-icon">${icons.zap}</span>
              <span class="chat-tool-card__block-label">${label}</span>
            </div>`
          : nothing
      }
      <pre class="chat-tool-card__block-content"><code class=${codeClass}>${text}</code></pre>
    </div>
  `;
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

export function toolWorkspacePath(card: ToolCard, view: ToolCallView): string | null {
  if (view.kind !== "read" && view.kind !== "edit" && view.kind !== "write") {
    return null;
  }
  const singleOperation = view.fileOperations?.length === 1 ? view.fileOperations[0] : undefined;
  // A delete removes its own target, so the workspace loader would always
  // report "Failed to load"; the row keeps its disclosure but no file action.
  if (singleOperation?.operation === "delete") {
    return null;
  }
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
  const fallbackPath = fallback.trim();
  // Aggregate patch labels ("2 files", "a.ts → b.ts") name no single file, so
  // only a recorded operation matching the rendered path stays navigable.
  if (view.fileOperations) {
    return singleOperation?.path === fallbackPath ? singleOperation.path : null;
  }
  return fallbackPath || null;
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

/** Neutral end-state line every expanded tool surface closes with. */
export function renderToolOutcome(outcome: ToolCardOutcome, exitCode?: number) {
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

function renderTerminalBlock(command: string, output: string | undefined) {
  return html`
    <div class="chat-tool-term">
      <div class="chat-tool-term__cmd">
        <span class="chat-tool-term__prompt">$</span
        ><code>${renderHighlightedCommand(command)}</code>
      </div>
      ${
        output?.trim()
          ? html`<pre class="chat-tool-term__out"><code>${output}</code></pre>`
          : nothing
      }
    </div>
  `;
}

function renderToolCardModes(
  card: ToolCard,
  messageKey: string,
  diff: NonNullable<ToolCallView["diff"]>,
  outcome: ToolCardOutcome,
  isError: boolean,
  file: DiffFilePaths,
) {
  // Call IDs repeat across messages; scope DOM identity without copying source cards.
  const id = `${messageKey}:${card.id}`;
  const active = isError ? "raw" : "diff";
  const modeLabel = t("chat.toolCards.viewMode");
  return html`
    <wa-tab-group
      class="chat-tool-card__modes"
      aria-label=${modeLabel}
      .active=${active}
      activation="auto"
      without-scroll-controls
      ${ref((element) => syncTabGroupLabel(element, modeLabel))}
    >
      <wa-tab slot="nav" id=${`${id}-diff-tab`} panel="diff" ?active=${active === "diff"}>
        ${t("chat.toolCards.diff")}
      </wa-tab>
      <wa-tab slot="nav" id=${`${id}-raw-tab`} panel="raw" ?active=${active === "raw"}>
        ${t("chat.toolCards.raw")}
      </wa-tab>
      <wa-tab-panel id=${`${id}-diff-panel`} name="diff" ?active=${active === "diff"}>
        ${renderDiffBlock(diff, outcome, undefined, file)}
      </wa-tab-panel>
      <wa-tab-panel id=${`${id}-raw-panel`} name="raw" ?active=${active === "raw"}>
        ${renderToolDataBlock({
          ...(isError ? { label: t("chat.toolCards.toolError") } : {}),
          text: card.outputText!,
        })}
      </wa-tab-panel>
    </wa-tab-group>
  `;
}

function serializeDiff(lines: readonly { kind: string; text: string }[]): string {
  return lines
    .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`)
    .join("\n");
}

export type ToolRenderOptions = {
  messageKey: string;
  runActive?: boolean;
  onOpenSidebar?: (content: SidebarContent) => void;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
};

export function renderExpandedToolCardContent(
  card: ToolCard,
  { messageKey, onOpenSidebar, runActive, onOpenWorkspaceFile }: ToolRenderOptions,
) {
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  // File/search rows already carry their target; the "with …" connector only
  // reads well for generic tools ("with query …"), not "with from sessions.ts".
  const summarizedKind = view.kind === "read" || view.kind === "search" || view.kind === "fetch";
  const detail = summarizedKind ? display.detail : formatToolDetail(display);
  const hasOutput = Boolean(card.outputText?.trim());
  const hasInput = Boolean(card.inputText?.trim());
  const isError = isToolCardError(card);
  const outcome = resolveToolCardOutcome(card, runActive);
  const workspaceFilePath = toolWorkspacePath(card, view);
  const canOpenSidebar = Boolean(onOpenSidebar);
  const previewSidebarContent =
    card.preview?.kind === "canvas"
      ? buildPreviewSidebarContent(card.preview, card.outputText)
      : null;
  const sidebarActionContent =
    previewSidebarContent ??
    buildSidebarContent(buildToolCardSidebarContent(card), {
      rawText: card.outputText ?? null,
    });
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
      ? renderCopyButton(serializeDiff(view.diff), t("common.copy"))
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
        ${renderTerminalBlock(view.command, card.outputText)}
        ${Object.keys(extraArgs).length > 0 ? renderArgsKeyValueList(extraArgs) : nothing}
        ${renderToolOutcome(outcome, card.exitCode)}
      </div>
    `;
  }

  // Edits and writes with a resolvable diff render it inline. When raw output
  // also exists, the shared tab primitive owns both views and their semantics.
  if ((view.kind === "edit" || view.kind === "write") && view.diff && view.diff.length > 0) {
    const file = view.fileOperations?.[0] ?? { path: view.target ?? "" };
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
        ${
          hasOutput
            ? renderToolCardModes(card, messageKey, view.diff, outcome, isError, file)
            : renderDiffBlock(view.diff, outcome, undefined, file)
        }
        ${renderToolOutcome(outcome, card.exitCode)}
      </div>
    `;
  }

  // File reads and searches summarize their primary target in the row, so the
  // full args JSON is noise — but any remaining args (filters, limits, request
  // options…) stay visible as key-value rows for auditability.
  const inputBlockArgs = summarizedKind
    ? extraArgsBeyondRowTarget(card.args, view.kind)
    : card.args;
  const showInputBlock = hasInput && (!summarizedKind || inputBlockArgs !== null);

  return html`
    <div class="chat-tool-card ${isError ? "chat-tool-card--error" : ""}">
      ${
        detail || canOpenSidebar
          ? html`
              <div class="chat-tool-card__header">
                ${
                  detail
                    ? view.kind === "read"
                      ? renderToolWorkspaceFilePath(detail, workspaceFilePath, onOpenWorkspaceFile)
                      : html`<div class="chat-tool-card__detail">${detail}</div>`
                    : nothing
                }
                <div class="chat-tool-card__actions">${sidebarAction}</div>
              </div>
            `
          : nothing
      }
      ${
        showInputBlock
          ? canRenderArgsAsKeyValue(inputBlockArgs)
            ? renderArgsKeyValueList(inputBlockArgs)
            : renderToolDataBlock({
                label: t("chat.toolCards.toolInput"),
                text: card.inputText!,
              })
          : nothing
      }
      ${
        hasOutput
          ? card.preview?.kind === "canvas"
            ? renderRawOutputToggle(card.outputText!)
            : renderToolDataBlock({
                ...(isError ? { label: t("chat.toolCards.toolError") } : {}),
                text: card.outputText!,
              })
          : isError
            ? renderToolDataBlock({
                label: t("chat.toolCards.toolError"),
                text: t("chat.toolCards.noOutputFailed"),
              })
            : nothing
      }
      ${renderToolOutcome(outcome, card.exitCode)}
    </div>
  `;
}
