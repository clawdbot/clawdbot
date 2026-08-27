import { Buffer } from "node:buffer";
import type { Event } from "nostr-tools";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { BUZZ_MENTION_MAX_COUNT } from "./mentions.js";

export const BUZZ_NORMAL_MESSAGE_KIND = 9;
export const BUZZ_TYPING_INDICATOR_KIND = 20_002;
const BUZZ_RICH_MESSAGE_KIND = 40_002;
export const BUZZ_DIFF_MESSAGE_KIND = 40_008;
export const BUZZ_INBOUND_MESSAGE_KINDS = [
  BUZZ_NORMAL_MESSAGE_KIND,
  BUZZ_RICH_MESSAGE_KIND,
  BUZZ_DIFF_MESSAGE_KIND,
] as const;

type BuzzInboundMessageKind = (typeof BUZZ_INBOUND_MESSAGE_KINDS)[number];

// Buzz relay ingest accepts up to 256 KiB generally; diff events have their
// own stricter validator. Keep inbound admission aligned with those limits.
const BUZZ_MESSAGE_CONTENT_MAX_BYTES = 256 * 1024;
const BUZZ_DIFF_CONTENT_MAX_BYTES = 60 * 1024;
const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const BUZZ_DIFF_CONTEXT_FIELD_MAX_CHARS = 256;
const BUZZ_DIFF_AGENT_CONTEXT_MAX_CHARS = 4_000;
const BUZZ_DIFF_AGENT_CONTEXT_TRUNCATED_SUFFIX = "\n...[Buzz diff truncated for model context]";
const BUZZ_INBOUND_MESSAGE_KIND_SET = new Set<number>(BUZZ_INBOUND_MESSAGE_KINDS);

export function isBuzzInboundMessageKind(kind: number): boolean {
  return BUZZ_INBOUND_MESSAGE_KIND_SET.has(kind);
}

interface BuzzDiffMetadata {
  repoUrl: string;
  commitSha: string;
  filePath?: string;
  parentCommitSha?: string;
  sourceBranch?: string;
  targetBranch?: string;
  pullRequestNumber?: number;
  language?: string;
  description?: string;
  truncated: boolean;
  altText?: string;
}

export interface BuzzInboundMessage {
  id: string;
  kind: BuzzInboundMessageKind;
  senderPubkey: string;
  text: string;
  channelId: string;
  createdAt: number;
  threadId?: string;
  replyToId?: string;
  mentionedPubkeys: string[];
  diff?: BuzzDiffMetadata;
}

function tagValue(event: Event, name: string): string | undefined {
  const value = event.tags.find((tag) => tag[0] === name)?.[1]?.trim();
  return value ? value : undefined;
}

function markerTagValue(event: Event, marker: string): string | undefined {
  const value = event.tags.find((tag) => tag[0] === "e" && tag[3] === marker)?.[1]?.trim();
  return value ? value : undefined;
}

function isHexAtLeast(value: string, minimumLength: number): boolean {
  return value.length >= minimumLength && /^[a-f0-9]+$/iu.test(value);
}

function parseBuzzDiffMetadata(event: Event): BuzzDiffMetadata | null {
  let repoUrl: string | undefined;
  let commitSha: string | undefined;
  let filePath: string | undefined;
  let parentCommitSha: string | undefined;
  let sourceBranch: string | undefined;
  let targetBranch: string | undefined;
  let pullRequestNumber: number | undefined;
  let language: string | undefined;
  let description: string | undefined;
  let truncated = false;
  let altText: string | undefined;

  for (const tag of event.tags) {
    const name = tag[0];
    const value = tag[1];
    if (!name || value === undefined) {
      continue;
    }
    switch (name) {
      case "repo":
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
          return null;
        }
        repoUrl ??= value;
        break;
      case "commit":
        if (!isHexAtLeast(value, 7)) {
          return null;
        }
        commitSha ??= value;
        break;
      case "file":
        filePath ??= value;
        break;
      case "parent-commit":
        if (!isHexAtLeast(value, 7)) {
          return null;
        }
        parentCommitSha ??= value;
        break;
      case "branch":
        if (!value || !tag[2]) {
          return null;
        }
        sourceBranch ??= value;
        targetBranch ??= tag[2];
        break;
      case "pr": {
        if (!/^[0-9]+$/u.test(value)) {
          return null;
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 0xffff_ffff) {
          return null;
        }
        pullRequestNumber ??= parsed;
        break;
      }
      case "l":
        language ??= value;
        break;
      case "description":
        description ??= value;
        break;
      case "truncated":
        truncated ||= value === "true";
        break;
      case "alt":
        altText ??= value;
        break;
      default:
        break;
    }
  }

  if (!repoUrl || !commitSha) {
    return null;
  }
  return {
    repoUrl,
    commitSha,
    filePath,
    parentCommitSha,
    sourceBranch,
    targetBranch,
    pullRequestNumber,
    language,
    description,
    truncated,
    altText,
  };
}

function boundedDiffContextValue(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= BUZZ_DIFF_CONTEXT_FIELD_MAX_CHARS) {
    return singleLine;
  }
  return `${truncateUtf16Safe(singleLine, BUZZ_DIFF_CONTEXT_FIELD_MAX_CHARS - 3)}...`;
}

export function formatBuzzMessageForAgent(message: BuzzInboundMessage): string {
  if (message.kind !== BUZZ_DIFF_MESSAGE_KIND || !message.diff) {
    return message.text;
  }
  const { diff } = message;
  const metadata = [
    `Repository: ${boundedDiffContextValue(diff.repoUrl)}`,
    `Commit: ${boundedDiffContextValue(diff.commitSha)}`,
    diff.parentCommitSha
      ? `Parent commit: ${boundedDiffContextValue(diff.parentCommitSha)}`
      : undefined,
    diff.filePath ? `File: ${boundedDiffContextValue(diff.filePath)}` : undefined,
    diff.sourceBranch && diff.targetBranch
      ? `Branches: ${boundedDiffContextValue(diff.sourceBranch)} -> ${boundedDiffContextValue(diff.targetBranch)}`
      : undefined,
    diff.pullRequestNumber ? `Pull request: #${diff.pullRequestNumber}` : undefined,
    diff.language ? `Language: ${boundedDiffContextValue(diff.language)}` : undefined,
    diff.description ? `Description: ${boundedDiffContextValue(diff.description)}` : undefined,
    diff.altText ? `Alt text: ${boundedDiffContextValue(diff.altText)}` : undefined,
    diff.truncated ? "Truncated: yes" : undefined,
  ].filter((line): line is string => Boolean(line));

  const prefix = [`[Buzz structured diff]`, ...metadata, "", "Unified diff:"].join("\n");
  const fullContext = `${prefix}\n${message.text}`;
  if (fullContext.length <= BUZZ_DIFF_AGENT_CONTEXT_MAX_CHARS) {
    return fullContext;
  }

  const bodyBudget =
    BUZZ_DIFF_AGENT_CONTEXT_MAX_CHARS -
    prefix.length -
    1 -
    BUZZ_DIFF_AGENT_CONTEXT_TRUNCATED_SUFFIX.length;
  if (bodyBudget <= 0) {
    const prefixBudget =
      BUZZ_DIFF_AGENT_CONTEXT_MAX_CHARS - BUZZ_DIFF_AGENT_CONTEXT_TRUNCATED_SUFFIX.length;
    return `${truncateUtf16Safe(prefix, prefixBudget).trimEnd()}${BUZZ_DIFF_AGENT_CONTEXT_TRUNCATED_SUFFIX}`;
  }
  return `${prefix}\n${truncateUtf16Safe(message.text, bodyBudget).trimEnd()}${BUZZ_DIFF_AGENT_CONTEXT_TRUNCATED_SUFFIX}`;
}

export function parseBuzzMessageEvent(event: Event): BuzzInboundMessage | null {
  if (
    !isBuzzInboundMessageKind(event.kind) ||
    !event.content.trim() ||
    Buffer.byteLength(event.content, "utf8") >
      (event.kind === BUZZ_DIFF_MESSAGE_KIND
        ? BUZZ_DIFF_CONTENT_MAX_BYTES
        : BUZZ_MESSAGE_CONTENT_MAX_BYTES)
  ) {
    return null;
  }
  const channelId = tagValue(event, "h");
  if (!channelId) {
    return null;
  }
  const rootId = markerTagValue(event, "root");
  const replyToId = markerTagValue(event, "reply");
  const kind = event.kind as BuzzInboundMessageKind;
  const diff = kind === BUZZ_DIFF_MESSAGE_KIND ? parseBuzzDiffMetadata(event) : undefined;
  if (kind === BUZZ_DIFF_MESSAGE_KIND && !diff) {
    return null;
  }
  const mentionTagValues = event.tags
    .filter((tag) => tag[0] === "p" && Boolean(tag[1]))
    .map((tag) => (tag[1] as string).trim().toLowerCase())
    .filter(Boolean);
  if (mentionTagValues.length > BUZZ_MENTION_MAX_COUNT) {
    return null;
  }
  const mentionedPubkeys = [...new Set(mentionTagValues)];
  return {
    id: event.id,
    kind,
    senderPubkey: event.pubkey,
    text: event.content,
    channelId,
    createdAt: event.created_at,
    threadId: rootId ?? replyToId,
    replyToId,
    mentionedPubkeys,
    ...(diff ? { diff } : {}),
  };
}

export function buildBuzzMessageTags(params: {
  channelId: string;
  threadId?: string;
  replyToId?: string;
  mentionedPubkeys?: readonly string[];
}): string[][] {
  const tags: string[][] = [["h", params.channelId]];
  const parentId = params.replyToId ?? params.threadId;
  if (params.threadId && parentId !== params.threadId) {
    tags.push(["e", params.threadId, "", "root"]);
  }
  if (parentId) {
    tags.push(["e", parentId, "", "reply"]);
  }
  const mentionedPubkeys = [
    ...new Set((params.mentionedPubkeys ?? []).map((publicKey) => publicKey.trim().toLowerCase())),
  ];
  if (mentionedPubkeys.length > BUZZ_MENTION_MAX_COUNT) {
    throw new Error(`Buzz messages support at most ${BUZZ_MENTION_MAX_COUNT} mentions`);
  }
  for (const publicKey of mentionedPubkeys) {
    if (!HEX_PUBLIC_KEY_PATTERN.test(publicKey)) {
      throw new Error("Buzz mentions require 64-character hex public keys");
    }
    tags.push(["p", publicKey]);
  }
  return tags;
}
