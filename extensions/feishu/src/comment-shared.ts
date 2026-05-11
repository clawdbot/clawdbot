import {
  isRecord as sharedIsRecord,
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { FEISHU_COMMENT_FILE_TYPES, type CommentFileType } from "./comment-target.js";

export function encodeQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const trimmed = value?.trim();
    if (trimmed) {
      query.set(key, trimmed);
    }
  }
  const queryString = query.toString();
  return queryString ? `?${queryString}` : "";
}

export const readString = readStringValue;

export const normalizeString = normalizeOptionalString;

export const isRecord = sharedIsRecord;

export function formatFeishuApiError(
  error: unknown,
  options: {
    includeConfigParams?: boolean;
    includeNestedErrorLogId?: boolean;
  } = {},
): string {
  if (!isRecord(error)) {
    return typeof error === "string" ? error : JSON.stringify(error);
  }
  const config = isRecord(error.config) ? error.config : undefined;
  const response = isRecord(error.response) ? error.response : undefined;
  const responseData = isRecord(response?.data) ? response?.data : undefined;
  const feishuLogId =
    readString(responseData?.log_id) ||
    (options.includeNestedErrorLogId
      ? readString(isRecord(responseData?.error) ? responseData.error.log_id : undefined)
      : undefined);
  const nestedError = isRecord(responseData?.error) ? responseData.error : undefined;

  return JSON.stringify({
    message:
      typeof error.message === "string"
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error),
    code: readString(error.code),
    method: readString(config?.method),
    url: readString(config?.url),
    ...(options.includeConfigParams ? { params: config?.params } : {}),
    http_status: typeof response?.status === "number" ? response.status : undefined,
    feishu_code:
      typeof responseData?.code === "number" ? responseData.code : readString(responseData?.code),
    feishu_msg: readString(responseData?.msg),
    feishu_log_id: feishuLogId,
    feishu_troubleshooter:
      readString(responseData?.troubleshooter) || readString(nestedError?.troubleshooter),
  });
}

function formatFeishuApiFailure(
  error: unknown,
  errorPrefix: string,
  options: {
    includeConfigParams?: boolean;
    includeNestedErrorLogId?: boolean;
  } = {},
): string {
  const details = formatFeishuApiError(error, options);
  return `${errorPrefix}: ${details || "unknown error"}`;
}

export function createFeishuApiError(
  error: unknown,
  errorPrefix: string,
  options: {
    includeConfigParams?: boolean;
    includeNestedErrorLogId?: boolean;
  } = {},
): Error {
  return new Error(formatFeishuApiFailure(error, errorPrefix, options), { cause: error });
}

export async function requestFeishuApi<T>(
  request: () => Promise<T>,
  errorPrefix: string,
  options: {
    includeConfigParams?: boolean;
    includeNestedErrorLogId?: boolean;
  } = {},
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw createFeishuApiError(error, errorPrefix, options);
  }
}

type ParsedCommentDocumentRef = {
  fileType?: CommentFileType;
  fileToken?: string;
};

type ParsedCommentMention = {
  userId: string;
  displayText: string;
  isBotMention: boolean;
};

type ParsedCommentLinkedDocumentKind =
  | CommentFileType
  | "wiki"
  | "mindnote"
  | "bitable"
  | "base"
  | "unknown";

type ParsedCommentResolvedDocumentType = Exclude<
  ParsedCommentLinkedDocumentKind,
  "wiki" | "unknown"
>;

export type ParsedCommentLinkedDocument = {
  rawUrl: string;
  urlKind: ParsedCommentLinkedDocumentKind;
  wikiNodeToken?: string;
  resolvedObjType?: ParsedCommentResolvedDocumentType;
  resolvedObjToken?: string;
  isCurrentDocument?: boolean;
};

export type ParsedCommentContent = {
  plainText?: string;
  semanticText?: string;
  mentions: ParsedCommentMention[];
  linkedDocuments: ParsedCommentLinkedDocument[];
  botMentioned: boolean;
};

function readDocsLinkUrl(element: Record<string, unknown>): string | undefined {
  const docsLink = isRecord(element.docs_link) ? element.docs_link : undefined;
  return (
    normalizeString(docsLink?.url) ||
    normalizeString(docsLink?.link) ||
    normalizeString(element.url) ||
    normalizeString(element.link) ||
    undefined
  );
}

function readMentionUserId(element: Record<string, unknown>): string | undefined {
  const mention = isRecord(element.mention) ? element.mention : undefined;
  const person = isRecord(element.person) ? element.person : undefined;
  return (
    normalizeString(person?.user_id) ||
    normalizeString(mention?.user_id) ||
    normalizeString(mention?.open_id) ||
    normalizeString(element.mention_user) ||
    normalizeString(element.user_id) ||
    undefined
  );
}

function readMentionDisplayText(element: Record<string, unknown>, userId: string): string {
  const mention = isRecord(element.mention) ? element.mention : undefined;
  const mentionName =
    normalizeString(mention?.name) ||
    normalizeString(mention?.display_name) ||
    normalizeString(element.name);
  return mentionName ? `@${mentionName}` : `@${userId}`;
}

function normalizeCommentText(parts: string[]): string | undefined {
  const text = parts.join("").trim();
  return text || undefined;
}

function normalizeCommentSemanticText(parts: string[]): string | undefined {
  const text = parts.join("").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function readElementTextPreservingWhitespace(element: Record<string, unknown>): string | undefined {
  return (
    (isRecord(element.text_run)
      ? readString(element.text_run.content) || readString(element.text_run.text)
      : undefined) ||
    readString(element.text) ||
    readString(element.content) ||
    readString(element.name) ||
    undefined
  );
}

const FEISHU_LINK_TOKEN_MIN_LENGTH = 22;
const FEISHU_LINK_TOKEN_MAX_LENGTH = 28;
const COMMENT_LINK_KIND_ALIASES = new Map<string, ParsedCommentResolvedDocumentType | "wiki">([
  ["doc", "doc"],
  ["docs", "doc"],
  ["docx", "docx"],
  ["sheet", "sheet"],
  ["sheets", "sheet"],
  ["slide", "slides"],
  ["slides", "slides"],
  ["file", "file"],
  ["files", "file"],
  ["wiki", "wiki"],
  ["mindnote", "mindnote"],
  ["mindnotes", "mindnote"],
  ["bitable", "bitable"],
  ["base", "base"],
]);

function isCommentFileType(
  value: ParsedCommentResolvedDocumentType | "wiki" | undefined,
): value is CommentFileType {
  return (
    typeof value === "string" && (FEISHU_COMMENT_FILE_TYPES as readonly string[]).includes(value)
  );
}

function isReasonableFeishuLinkToken(token: string | undefined): token is string {
  return (
    typeof token === "string" &&
    token.length >= FEISHU_LINK_TOKEN_MIN_LENGTH &&
    token.length <= FEISHU_LINK_TOKEN_MAX_LENGTH
  );
}

function parseCommentLinkedDocumentPath(pathname: string): {
  urlKind: ParsedCommentResolvedDocumentType | "wiki";
  token: string;
} | null {
  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const offset = segments[0]?.toLowerCase() === "space" ? 1 : 0;
  const kind = COMMENT_LINK_KIND_ALIASES.get(segments[offset]?.toLowerCase() ?? "");
  const token = normalizeString(segments[offset + 1]);
  if (!kind || !isReasonableFeishuLinkToken(token)) {
    return null;
  }
  return { urlKind: kind, token };
}

function hasResolvedLinkedDocumentReference(link: ParsedCommentLinkedDocument): boolean {
  return (
    link.urlKind !== "unknown" && (Boolean(link.resolvedObjToken) || Boolean(link.wikiNodeToken))
  );
}

export function resolveCommentLinkedDocumentFromUrl(params: {
  rawUrl: string;
  currentDocument?: ParsedCommentDocumentRef;
}): ParsedCommentLinkedDocument {
  const link: ParsedCommentLinkedDocument = {
    rawUrl: params.rawUrl,
    urlKind: "unknown",
  };
  try {
    const parsed = new URL(params.rawUrl);
    const parsedPath = parseCommentLinkedDocumentPath(parsed.pathname);
    if (!parsedPath) {
      return link;
    }
    const { urlKind, token } = parsedPath;
    link.urlKind = urlKind;
    if (urlKind === "wiki") {
      link.urlKind = "wiki";
      link.wikiNodeToken = token;
    } else {
      link.resolvedObjType = urlKind;
      link.resolvedObjToken = token;
    }
    if (
      link.resolvedObjType &&
      link.resolvedObjToken &&
      isCommentFileType(link.resolvedObjType) &&
      params.currentDocument?.fileType === link.resolvedObjType &&
      params.currentDocument.fileToken === link.resolvedObjToken
    ) {
      link.isCurrentDocument = true;
    } else if (
      link.resolvedObjType &&
      link.resolvedObjToken &&
      isCommentFileType(link.resolvedObjType)
    ) {
      link.isCurrentDocument = false;
    }
  } catch {
    return link;
  }
  return link;
}

export function parseCommentContentElements(params: {
  elements?: unknown[];
  botOpenIds?: Iterable<string | undefined>;
  currentDocument?: ParsedCommentDocumentRef;
}): ParsedCommentContent {
  const elements = Array.isArray(params.elements) ? params.elements : [];
  const plainTextParts: string[] = [];
  const semanticTextParts: string[] = [];
  const mentions: ParsedCommentMention[] = [];
  const linkedDocuments: ParsedCommentLinkedDocument[] = [];
  const botIds = new Set(
    Array.from(params.botOpenIds ?? [])
      .map((value) => normalizeString(value))
      .filter((value): value is string => Boolean(value)),
  );
  const linkedDocumentKeys = new Set<string>();
  let botMentioned = false;

  for (const rawElement of elements) {
    if (!isRecord(rawElement)) {
      continue;
    }
    const element = rawElement;
    const type = normalizeString(element.type);
    const text =
      (type === "text_run" ? readElementTextPreservingWhitespace(element) : undefined) ||
      (type === "text" ? readElementTextPreservingWhitespace(element) : undefined) ||
      (type === "docs_link" || type === "link" ? readDocsLinkUrl(element) : undefined) ||
      (type === "mention" || type === "mention_user" || type === "person"
        ? (() => {
            const userId = readMentionUserId(element);
            return userId ? readMentionDisplayText(element, userId) : undefined;
          })()
        : undefined) ||
      readElementTextPreservingWhitespace(element) ||
      undefined;

    if (type === "mention" || type === "mention_user" || type === "person") {
      const userId = readMentionUserId(element);
      if (userId) {
        const displayText = readMentionDisplayText(element, userId);
        const isBotMention = botIds.has(userId);
        mentions.push({ userId, displayText, isBotMention });
        plainTextParts.push(displayText);
        if (!isBotMention) {
          semanticTextParts.push(displayText);
        } else {
          botMentioned = true;
        }
        continue;
      }
    }

    if (type === "docs_link" || type === "link") {
      const rawUrl = readDocsLinkUrl(element);
      if (rawUrl) {
        plainTextParts.push(rawUrl);
        semanticTextParts.push(rawUrl);
        const linkedDocument = resolveCommentLinkedDocumentFromUrl({
          rawUrl,
          currentDocument: params.currentDocument,
        });
        if (hasResolvedLinkedDocumentReference(linkedDocument)) {
          const key = [
            linkedDocument.rawUrl,
            linkedDocument.urlKind,
            linkedDocument.resolvedObjType,
            linkedDocument.resolvedObjToken,
            linkedDocument.wikiNodeToken,
          ].join(":");
          if (!linkedDocumentKeys.has(key)) {
            linkedDocumentKeys.add(key);
            linkedDocuments.push(linkedDocument);
          }
        }
        continue;
      }
    }

    if (text) {
      plainTextParts.push(text);
      semanticTextParts.push(text);
    }
  }

  return {
    plainText: normalizeCommentText(plainTextParts),
    semanticText: normalizeCommentSemanticText(semanticTextParts),
    mentions,
    linkedDocuments,
    botMentioned,
  };
}

export function extractReplyText(
  reply: { content?: { elements?: unknown[] } } | undefined,
): string | undefined {
  if (!reply || !isRecord(reply.content)) {
    return undefined;
  }
  return parseCommentContentElements({
    elements: Array.isArray(reply.content.elements) ? reply.content.elements : [],
  }).plainText;
}
