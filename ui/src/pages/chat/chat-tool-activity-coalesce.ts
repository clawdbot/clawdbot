// Reconcile invocation projections before grouping so summaries and expanded
// cards consume the same calls, regardless of history/live delivery order.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import type { ChatItem, ToolCard } from "../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { resolveToolBlockId } from "./chat-thread-items.ts";
import { chatItemStartsUserTurn } from "./chat-turn-boundary.ts";
import { buildToolStreamIdentity, extractToolMessageRefs } from "./tool-stream-identity.ts";

type MessageItem = Extract<ChatItem, { kind: "message" }>;
type ProjectedItem = MessageItem & {
  message: Record<string, unknown> & { content: unknown[] };
};
type Source = {
  item: MessageItem;
  message: Record<string, unknown>;
  index: number;
  remaining: unknown[];
  standalone: boolean;
};
type Projection = {
  source: Source;
  block: Record<string, unknown>;
  id: string;
  runId?: string;
  name: string;
  call: boolean;
  rank: number;
};
type Invocation = {
  first: number;
  call?: Projection;
  result?: Projection;
  live?: Record<string, unknown>;
  attachments: unknown[];
  projections: Projection[];
};

function resultBlock(card: ToolCard): Record<string, unknown> {
  return {
    type: "tool_result",
    id: card.callId,
    name: card.name,
    text: card.outputText ?? "",
    details: card.details,
    isError: card.isError,
    exitCode: card.exitCode,
  };
}

function readProjections(item: MessageItem, index: number): Projection[] {
  let message = asRecord(item.message);
  if (!message) {
    return [];
  }
  let content = Array.isArray(message.content) ? message.content : [];
  const isToolBlock = (block: unknown) => {
    const type = asRecord(block)?.type;
    return isToolCallContentType(type) || isToolResultContentType(type);
  };
  let blocks = content.filter(isToolBlock);
  // Resolve no-id fallback once through the card owner. Keep anonymous pairs
  // in the source while identified siblings still join the invocation registry.
  if (blocks.some((block) => !resolveToolBlockId(asRecord(block)!, message!))) {
    const pending = [...extractToolCardsCached(message, item.key)];
    content = content.flatMap((block) => {
      if (!isToolBlock(block)) {
        return [block];
      }
      const raw = asRecord(block)!;
      const id = resolveToolBlockId(raw, message!);
      const call = isToolCallContentType(raw.type);
      const cardIndex = pending.findIndex(
        (card) => call === Object.hasOwn(card, "args") && (!id || card.callId === id),
      );
      if (cardIndex < 0) {
        return [];
      }
      const card = pending.splice(cardIndex, 1)[0]!;
      const fields = { id: card.callId, name: card.name, details: card.details };
      return [
        ...(call ? [{ ...raw, ...fields, arguments: card.args }] : []),
        ...(!call || card.completed || card.outputText !== undefined ? [resultBlock(card)] : []),
      ];
    });
    message = { ...message, content };
    blocks = content.filter(
      (block) => isToolBlock(block) && resolveToolBlockId(asRecord(block)!, message!),
    );
    if (blocks.length === 0) {
      return [];
    }
  }
  const standalone = blocks.length === 0;
  if (standalone) {
    const [card] = extractToolCardsCached(message, item.key);
    if (!card?.callId) {
      return [];
    }
    blocks = [resultBlock(card)];
  }
  const source: Source = {
    item,
    message,
    index,
    standalone,
    remaining: content.filter(
      (block) => !blocks.includes(block) && (!standalone || asRecord(block)?.type !== "text"),
    ),
  };
  return blocks.map((block) => {
    const raw = asRecord(block)!;
    const id = resolveToolBlockId(raw, message)!;
    const call = isToolCallContentType(raw.type);
    const live = message["__openclawToolStreamLive"] === true;
    const [card] = extractToolCardsCached({ ...message, content: [raw] });
    return {
      source,
      id,
      call,
      runId: normalizeOptionalString(raw.runId) ?? normalizeOptionalString(message.runId),
      name:
        normalizeOptionalString(raw.name) ??
        normalizeOptionalString(message.toolName) ??
        normalizeOptionalString(message.tool_name) ??
        "tool",
      // Durable results outrank live terminal snapshots, which outrank partial
      // updates. A late partial replay must not resurrect a completed call.
      rank: call
        ? live
          ? 1
          : 2
        : !live
          ? 3
          : message["__openclawToolStreamResultReceived"] === true
            ? 2
            : 1,
      block: {
        ...raw,
        id,
        ...(call ? { arguments: card?.args } : { text: card?.outputText }),
        ...(card?.details !== undefined ? { details: card.details } : {}),
        ...(card?.isError !== undefined ? { isError: card.isError } : {}),
        ...(card?.exitCode !== undefined ? { exitCode: card.exitCode } : {}),
      },
    };
  });
}

function preferProjection(previous: Projection | undefined, next: Projection): Projection {
  if (!previous) {
    return next;
  }
  const [fallback, preferred] = next.rank >= previous.rank ? [previous, next] : [next, previous];
  const details = asRecord(fallback.block.details);
  const preferredDetails = asRecord(preferred.block.details);
  return {
    ...preferred,
    name: preferred.name === "tool" ? fallback.name : preferred.name,
    block: {
      ...Object.fromEntries(
        Object.entries(fallback.block).filter(([, value]) => value !== undefined),
      ),
      ...Object.fromEntries(
        Object.entries(preferred.block).filter(([, value]) => value !== undefined),
      ),
      ...(details && preferredDetails ? { details: { ...details, ...preferredDetails } } : {}),
      // Payload aliases must not let stale text outrank a newer content/input.
      ...(preferred.call
        ? { arguments: preferred.block.arguments ?? fallback.block.arguments }
        : { text: preferred.block.text }),
    },
  };
}

function coalesceTurn(items: ChatItem[]): ChatItem[] {
  const projections = items.flatMap((item, index) =>
    item.kind === "message" ? readProjections(item, index) : [],
  );
  if (projections.length === 0) {
    return items;
  }
  const runs = new Map<string, Set<string>>();
  // Resolve missing-run ownership from the entire turn, not the prefix seen
  // so far: a later sibling with a reused id makes unscoped history ambiguous.
  for (const item of items) {
    if (item.kind !== "message") {
      continue;
    }
    for (const ref of extractToolMessageRefs(item.message)) {
      if (ref.runId) {
        const owners = runs.get(ref.id) ?? new Set<string>();
        owners.add(ref.runId);
        runs.set(ref.id, owners);
      }
    }
  }
  const identity = (projection: Projection) => {
    const owners = runs.get(projection.id);
    projection.runId ??= owners?.size === 1 ? owners.values().next().value : undefined;
    return buildToolStreamIdentity(projection.runId ?? "", projection.id);
  };
  const names = new Map<string, Set<string>>();
  for (const projection of projections) {
    const key = identity(projection);
    const known = names.get(key) ?? new Set<string>();
    if (projection.name !== "tool") {
      known.add(projection.name.toLowerCase());
    }
    names.set(key, known);
  }
  const invocations = new Map<string, Invocation>();
  const sources = new Map<number, Source>();
  for (const projection of projections) {
    sources.set(projection.source.index, projection.source);
    const key = identity(projection);
    const knownNames = names.get(key)!;
    const name =
      projection.name === "tool" && knownNames.size === 1
        ? knownNames.values().next().value
        : projection.name.toLowerCase();
    const invocationKey = JSON.stringify([key, name]);
    const invocation = invocations.get(invocationKey) ?? {
      first: projection.source.index,
      attachments: [],
      projections: [],
    };
    invocation.projections.push(projection);
    if (projection.call) {
      invocation.call = preferProjection(invocation.call, projection);
    } else {
      invocation.result = preferProjection(invocation.result, projection);
    }
    if (projection.source.message["__openclawToolStreamLive"] === true) {
      invocation.live = projection.source.message;
    }
    if (projection.source.standalone) {
      invocation.attachments.push(...projection.source.remaining);
      projection.source.remaining = [];
    }
    invocations.set(invocationKey, invocation);
  }
  const rows = new Map<number, ProjectedItem[]>();
  const bundles = new Map<string, { item: ProjectedItem; index: number }>();
  const unchanged = new Set(sources.values());
  for (const invocation of invocations.values()) {
    const owners = new Set(invocation.projections.map((projection) => projection.source));
    if (
      owners.size > 1 ||
      invocation.projections.length >
        Number(Boolean(invocation.call)) + Number(Boolean(invocation.result))
    ) {
      owners.forEach((source) => unchanged.delete(source));
    }
  }
  for (const invocation of invocations.values()) {
    const owner = invocation.call ?? invocation.result!;
    if (unchanged.has(owner.source)) {
      continue;
    }
    const message = owner.source.message;
    const result = invocation.result;
    const completed = result !== undefined && result.rank > 1;
    const transcript =
      message.messageId ??
      asRecord(message["__openclaw"])?.id ??
      result?.source.message.messageId ??
      asRecord(result?.source.message["__openclaw"])?.id;
    const content = [
      ...(invocation.call ? [{ ...invocation.call.block, name: invocation.call.name }] : []),
      ...(result ? [{ ...result.block, name: invocation.call?.name ?? result.name }] : []),
      ...invocation.attachments,
    ];
    // Batch only calls with the same message-scoped rendering metadata. Separate
    // result refs or completion states need separate rows, never sibling flags.
    const bundleKey = JSON.stringify([
      owner.source.index,
      owner.runId,
      Boolean(invocation.live),
      completed,
      transcript,
      invocation.live?.["__openclawToolStreamDiffStat"],
      invocation.live?.["__openclawToolStreamReceivedAt"],
      (names.get(identity(owner))?.size ?? 0) > 1 ? owner.name : undefined,
    ]);
    const bundle = bundles.get(bundleKey);
    if (bundle) {
      bundle.item.message.content.push(...content);
      bundle.index = Math.min(bundle.index, invocation.first);
      continue;
    }
    const item: ProjectedItem = {
      ...owner.source.item,
      key: `${owner.source.item.key}:invocation:${identity(owner)}:${owner.name}`,
      message: {
        ...message,
        role: invocation.call ? "assistant" : message.role,
        runId: owner.runId,
        content,
        ...(transcript ? { messageId: transcript } : {}),
        ...(invocation.live
          ? {
              __openclawToolStreamLive: true,
              __openclawToolStreamResultReceived: completed,
              __openclawToolStreamDiffStat: completed
                ? undefined
                : invocation.live["__openclawToolStreamDiffStat"],
              __openclawToolStreamReceivedAt: invocation.live["__openclawToolStreamReceivedAt"],
            }
          : {}),
      },
    };
    bundles.set(bundleKey, { item, index: invocation.first });
  }
  for (const { item, index } of bundles.values()) {
    const row = rows.get(index) ?? [];
    row.push(item);
    rows.set(index, row);
  }
  return items.flatMap((item, index) => {
    const source = sources.get(index);
    if (!source || unchanged.has(source)) {
      return [item];
    }
    const row = rows.get(index) ?? [];
    if (source.remaining.length > 0) {
      // Keep surrounding prose/media at its original position even when all
      // tool blocks in this projection were already represented elsewhere.
      if (row.length > 0) {
        const pending = row.map((entry) => ({
          message: entry.message,
          blocks: entry.message.content,
        }));
        pending.forEach(({ message }) => {
          message.content = [];
        });
        let current = pending[0]!;
        const blocks = Array.isArray(source.message.content) ? source.message.content : [];
        for (const block of blocks) {
          if (source.remaining.includes(block)) {
            current.message.content.push(block);
            continue;
          }
          const raw = asRecord(block) ?? {};
          const id = resolveToolBlockId(raw, source.message);
          for (const target of pending) {
            const matches = target.blocks.filter((entry) => {
              const record = asRecord(entry);
              return record?.id === id && (!raw.name || raw.name === record?.name);
            });
            if (matches.length > 0) {
              target.message.content.push(...matches);
              target.blocks = target.blocks.filter((entry) => !matches.includes(entry));
              current = target;
            }
          }
        }
        pending.forEach((entry) => entry.message.content.push(...entry.blocks));
      } else {
        row.unshift({
          ...source.item,
          message: {
            ...source.message,
            content: source.remaining,
            toolCallId: undefined,
            tool_call_id: undefined,
            toolUseId: undefined,
            tool_use_id: undefined,
            toolName: undefined,
            tool_name: undefined,
          },
        });
      }
    }
    return row;
  });
}

export function coalesceToolActivityMessages(items: ChatItem[]): ChatItem[] {
  const result: ChatItem[] = [];
  let turn: ChatItem[] = [];
  for (const item of items) {
    if (chatItemStartsUserTurn(item) || item.kind === "divider") {
      result.push(...coalesceTurn(turn), item);
      turn = [];
    } else {
      turn.push(item);
    }
  }
  result.push(...coalesceTurn(turn));
  return result;
}
