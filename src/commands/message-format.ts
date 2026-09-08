/** Human-readable formatter for `openclaw message` action results. */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  getTerminalTableWidth,
  renderTable,
  renderTerminalSafeTable,
} from "../../packages/terminal-core/src/table.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
import { formatGatewaySummary, formatOutboundDeliverySummary } from "../infra/outbound/format.js";
import {
  resolveMessageActionMessageId,
  resolveMessageActionOutcome,
  type MessageActionResult,
} from "../infra/outbound/message-action-contracts.js";
import { formatTargetDisplay } from "../infra/outbound/target-resolver.js";
import { shortenText } from "./text-format.js";

const resolveChannelLabel = (channel: ChannelId) =>
  getLoadedChannelPlugin(channel)?.meta.label ?? channel;

function firstNonemptyString(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = typeof record?.[key] === "string" && record?.[key];
    if (value) {
      return value as string; // SAFETY: Preserve the old second accessor read after its string check.
    }
  }
  return "";
}

type FormatOpts = {
  width: number;
  /** Max rows to render. Defaults to 25 when omitted. */
  displayLimit?: number;
};

function renderSummaryValue(value: unknown): string {
  if (value == null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `${value.length} items`;
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
      return String(value);
    default:
      return typeof value;
  }
}

function renderObjectSummary(payload: unknown, opts: FormatOpts): string {
  if (!payload || typeof payload !== "object") {
    return String(payload);
  }
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return theme.muted("(empty)");
  }

  const rows = keys.slice(0, 20).map((k) => {
    const value = renderSummaryValue(obj[k]);
    return { Key: k, Value: shortenText(value, 96) };
  });
  return renderTable({
    width: opts.width,
    columns: [
      { key: "Key", header: "Key", minWidth: 16 },
      { key: "Value", header: "Value", flex: true, minWidth: 24 },
    ],
    rows,
  }).trimEnd();
}

function renderMessageList(messages: unknown[], opts: FormatOpts, emptyLabel: string): string {
  const cap = opts.displayLimit ?? 25;
  const rows = messages.slice(0, cap).map((m) => {
    const msg = m as Record<string, unknown>;
    const id = firstNonemptyString(msg, "id", "ts", "messageId");
    const authorObj = msg.author as Record<string, unknown> | undefined;
    const author =
      firstNonemptyString(msg, "authorTag") ||
      firstNonemptyString(authorObj, "username") ||
      firstNonemptyString(msg, "user");
    const time = firstNonemptyString(msg, "timestamp", "ts");
    const text = firstNonemptyString(msg, "content", "text");
    return {
      Time: shortenText(time, 28),
      Author: shortenText(author, 22),
      Text: shortenText(text.replace(/\s+/g, " ").trim(), 90),
      Id: shortenText(id, 22),
    };
  });

  if (rows.length === 0) {
    return theme.muted(emptyLabel);
  }

  return renderTable({
    width: opts.width,
    columns: [
      { key: "Time", header: "Time", minWidth: 14 },
      { key: "Author", header: "Author", minWidth: 10 },
      { key: "Text", header: "Text", flex: true, minWidth: 24 },
      { key: "Id", header: "Id", minWidth: 10 },
    ],
    rows,
  }).trimEnd();
}

function extractDiscordSearchResultsMessages(results: unknown): unknown[] | null {
  if (!results || typeof results !== "object") {
    return null;
  }
  const raw = (results as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) {
    return null;
  }
  // Discord search returns messages as array-of-array; first element is the message.
  const flattened: unknown[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length > 0) {
      flattened.push(entry[0]);
    } else if (entry && typeof entry === "object") {
      flattened.push(entry);
    }
  }
  return flattened;
}

function renderReactions(payload: unknown, opts: FormatOpts): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const reactions = (payload as { reactions?: unknown }).reactions;
  if (!Array.isArray(reactions)) {
    return null;
  }

  const rows = reactions.slice(0, opts.displayLimit ?? 50).map((r) => {
    const entry = r as Record<string, unknown>;
    const emojiObj = entry.emoji as Record<string, unknown> | undefined;
    const emoji =
      firstNonemptyString(emojiObj, "raw") || firstNonemptyString(entry, "name", "emoji", "key");
    const count = typeof entry.count === "number" ? String(entry.count) : "";
    const userList = Array.isArray(entry.users)
      ? (entry.users as unknown[])
          .slice(0, 8)
          .map((u) => {
            if (typeof u === "string") {
              return u;
            }
            if (!u || typeof u !== "object") {
              return "";
            }
            const user = u as Record<string, unknown>;
            return firstNonemptyString(user, "tag", "username", "id");
          })
          .filter(Boolean)
      : [];
    return {
      Emoji: emoji,
      Count: count,
      Users: shortenText(userList.join(", "), 72),
    };
  });

  if (rows.length === 0) {
    return theme.muted("No reactions.");
  }

  // Escape remote labels and users only for display; raw keys remain identities in JSON.
  return renderTerminalSafeTable({
    width: opts.width,
    columns: [
      { key: "Emoji", header: "Emoji", minWidth: 8 },
      { key: "Count", header: "Count", align: "right", minWidth: 6 },
      { key: "Users", header: "Users", flex: true, minWidth: 20 },
    ],
    rows,
  }).trimEnd();
}

/**
 * Emit a muted hint when the provider payload signals more results are available
 * beyond the current page (e.g. hasMore, nextBatch, @odata.nextLink).
 */
function renderPaginationHint(payload: unknown, muted: (text: string) => string): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  if (
    obj.hasMore === true ||
    (typeof obj.nextBatch === "string" && obj.nextBatch) ||
    (typeof obj["@odata.nextLink"] === "string" && obj["@odata.nextLink"])
  ) {
    return muted(
      "More results available. Use --limit to fetch more, or --json for the raw cursor.",
    );
  }
  return null;
}

export function formatMessageCliText(
  result: MessageActionResult,
  opts?: { displayLimit?: number },
): string[] {
  const rich = isRich();
  const ok = (text: string) => (rich ? theme.success(text) : text);
  const fail = (text: string) => (rich ? theme.error(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  const heading = (text: string) => (rich ? theme.heading(text) : text);

  const width = getTerminalTableWidth();
  const displayLimit = opts?.displayLimit;
  const formatOpts: FormatOpts = { width, displayLimit };

  if (result.dryRun) {
    return [muted(`[dry-run] would run ${result.action} via ${result.channel}`)];
  }

  const outcome = resolveMessageActionOutcome(result);
  if (result.kind === "broadcast") {
    const results = result.payload.results ?? [];
    const rows = results.map((entry) => ({
      Channel: resolveChannelLabel(entry.channel),
      Target: shortenText(formatTargetDisplay({ channel: entry.channel, target: entry.to }), 36),
      Status: entry.ok ? "ok" : "error",
      Error: entry.ok ? "" : shortenText(entry.error ?? "unknown error", 48),
    }));
    const okCount = results.filter((entry) => entry.ok).length;
    const total = results.length;
    const successful = outcome.ok;
    const headingLine = (successful ? ok : fail)(
      `${successful ? "✅ Broadcast complete" : "❌ Broadcast failed"} (${okCount}/${total} succeeded, ${total - okCount} failed)`,
    );
    return [
      headingLine,
      renderTable({
        width: formatOpts.width,
        columns: [
          { key: "Channel", header: "Channel", minWidth: 10 },
          { key: "Target", header: "Target", minWidth: 12, flex: true },
          { key: "Status", header: "Status", minWidth: 6 },
          { key: "Error", header: "Error", minWidth: 20, flex: true },
        ],
        rows,
      }).trimEnd(),
    ];
  }

  if (!outcome.ok) {
    const messageId = result.kind === "send" ? result.sendResult?.result?.messageId : undefined;
    return [fail(`❌ ${outcome.error}${messageId ? ` Message ID: ${messageId}` : ""}`)];
  }

  if (result.kind === "send") {
    if (result.handledBy === "core" && result.sendResult) {
      const send = result.sendResult;
      if (send.via === "direct") {
        const directResult = send.result as OutboundDeliveryResult | undefined;
        return [ok(formatOutboundDeliverySummary(send.channel, directResult))];
      }
      const gatewayResult = send.result as { messageId?: string } | undefined;
      return [
        ok(
          formatGatewaySummary({
            channel: send.channel,
            messageId: gatewayResult?.messageId ?? null,
          }),
        ),
      ];
    }

    const label = resolveChannelLabel(result.channel);
    const msgId = resolveMessageActionMessageId(result.payload);
    return [ok(`✅ Sent via ${label}.${msgId ? ` Message ID: ${msgId}` : ""}`)];
  }

  if (result.kind === "poll") {
    if (result.handledBy === "core" && result.pollResult) {
      const poll = result.pollResult;
      const pollId = (poll.result as { pollId?: string } | undefined)?.pollId;
      const msgId = poll.result?.messageId ?? null;
      if (poll.via === "direct") {
        const directResult = poll.result
          ? ({ ...poll.result, channel: poll.channel } satisfies OutboundDeliveryResult)
          : undefined;
        const lines = [
          ok(
            formatOutboundDeliverySummary(poll.channel, directResult, {
              action: "Poll sent",
            }),
          ),
        ];
        if (pollId) {
          lines.push(ok(`Poll id: ${pollId}`));
        }
        return lines;
      }
      const lines = [
        ok(
          formatGatewaySummary({
            action: "Poll sent",
            channel: poll.channel,
            messageId: msgId,
          }),
        ),
      ];
      if (pollId) {
        lines.push(ok(`Poll id: ${pollId}`));
      }
      return lines;
    }

    const label = resolveChannelLabel(result.channel);
    const msgId = resolveMessageActionMessageId(result.payload);
    return [ok(`✅ Poll sent via ${label}.${msgId ? ` Message ID: ${msgId}` : ""}`)];
  }

  // Channel actions share the generic plugin-action payload shape, so format
  // known read/reaction shapes first and fall back to a compact object table.
  const payload = result.payload;
  const lines: string[] = [];

  if (result.action === "react") {
    const added = (payload as { added?: unknown }).added;
    const removed = (payload as { removed?: unknown }).removed;
    if (typeof added === "string" && added.trim()) {
      lines.push(ok(`✅ Reaction added: ${added.trim()}`));
      return lines;
    }
    if (typeof removed === "string" && removed.trim()) {
      lines.push(ok(`✅ Reaction removed: ${removed.trim()}`));
      return lines;
    }
    if (Array.isArray(removed)) {
      const list = normalizeStringEntries(removed).join(", ");
      lines.push(ok(`✅ Reactions removed${list ? `: ${list}` : ""}`));
      return lines;
    }
    lines.push(ok("✅ Reaction updated."));
    return lines;
  }

  const reactionsTable = renderReactions(payload, formatOpts);
  if (reactionsTable !== null && result.action === "reactions") {
    lines.push(heading("Reactions"));
    lines.push(reactionsTable);
    return lines;
  }

  if (result.action === "read" || result.action === "list-pins") {
    const read = result.action === "read";
    const messages =
      payload && typeof payload === "object"
        ? (payload as { messages?: unknown; pins?: unknown })[read ? "messages" : "pins"]
        : undefined;
    if (Array.isArray(messages)) {
      const table = renderMessageList(messages, formatOpts, read ? "No messages." : "No pins.");
      lines.push(heading(read ? "Messages" : "Pinned messages"));
      lines.push(table);
      const hint = renderPaginationHint(payload, muted);
      if (hint) {
        lines.push(hint);
      }
      return lines;
    }
  }

  if (result.action === "search") {
    const results = (payload as { results?: unknown }).results;
    const list = extractDiscordSearchResultsMessages(results);
    if (list) {
      lines.push(heading("Search results"));
      lines.push(renderMessageList(list, formatOpts, "No results."));
      // Discord's approximate result count cannot prove another page exists.
      const hint = renderPaginationHint(payload, muted) ?? renderPaginationHint(results, muted);
      if (hint) {
        lines.push(hint);
      }
      return lines;
    }
  }

  // Generic success + compact details table.
  lines.push(ok(`✅ ${result.action} via ${resolveChannelLabel(result.channel)}.`));
  const summary = renderObjectSummary(payload, formatOpts);
  lines.push("");
  lines.push(summary);
  lines.push("");
  lines.push(muted("Tip: use --json for full output."));
  return lines;
}
