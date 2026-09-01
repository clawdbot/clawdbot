import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  hasInboundMetadataSentinel,
  stripInboundMetadata,
} from "../../auto-reply/reply/strip-inbound-meta.js";
import {
  getBootEchoContextForSession,
  stripBootEchoFromOutboundText,
} from "../../gateway/boot-echo-guard.js";
import {
  parseInteractiveParam,
  parseJsonMessageParam,
} from "../../infra/outbound/message-action-params.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import { stripInternalRuntimeContext } from "../internal-runtime-context.js";
import { readStringArrayParam, readToolStringParam } from "./common.js";
export function normalizeEscapedLineBreaksForVisibleText(text: string): string {
  if (!text.includes("\\")) {
    return text;
  }
  // The send path turns literal "\n" sequences into line breaks later; match
  // that before privacy stripping so escaped delimiter lines cannot bypass it.
  return text.replace(/\\r\\n|\\n|\\r/g, "\n");
}

export type VisibleTextSuppressionReason =
  | "internal_runtime_context_echo"
  | "inbound_metadata_echo"
  | "poll_vote_echo";

function sanitizeUserVisibleToolTextResult(
  text: string,
  bootPrompt: string | undefined,
): {
  text: string;
  suppressionReason?: VisibleTextSuppressionReason;
} {
  const normalized = normalizeEscapedLineBreaksForVisibleText(text);
  const strippedReasoning = stripFormattedReasoningMessage(normalized);
  const strippedInternal = stripInternalRuntimeContext(strippedReasoning);
  const strippedBoot = stripBootEchoFromOutboundText(strippedInternal, bootPrompt);
  const strippedInbound = hasInboundMetadataSentinel(strippedBoot)
    ? stripInboundMetadata(strippedBoot)
    : strippedBoot;
  const suppressionReason =
    strippedBoot.trim().length === 0 &&
    strippedReasoning.trim().length > 0 &&
    (strippedInternal !== strippedReasoning || strippedBoot !== strippedInternal)
      ? "internal_runtime_context_echo"
      : strippedInbound.trim().length === 0 &&
          strippedBoot.trim().length > 0 &&
          strippedInbound !== strippedBoot
        ? "inbound_metadata_echo"
        : undefined;
  return {
    text: strippedInbound,
    ...(suppressionReason ? { suppressionReason } : {}),
  };
}

function sanitizeStringParam(
  params: Record<string, unknown>,
  field: string,
  bootPrompt: string | undefined,
): VisibleTextSuppressionReason | undefined {
  if (typeof params[field] !== "string") {
    return undefined;
  }
  const sanitized = sanitizeUserVisibleToolTextResult(params[field], bootPrompt);
  params[field] = sanitized.text;
  return sanitized.suppressionReason;
}

function sanitizeStringArrayParam(
  params: Record<string, unknown>,
  field: string,
  bootPrompt: string | undefined,
): VisibleTextSuppressionReason | undefined {
  const value = params[field];
  if (typeof value === "string") {
    const sanitized = sanitizeUserVisibleToolTextResult(value, bootPrompt);
    params[field] = sanitized.text;
    return sanitized.suppressionReason;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  let suppressionReason: VisibleTextSuppressionReason | undefined;
  params[field] = value.map((entry) => {
    if (typeof entry !== "string") {
      return entry;
    }
    const sanitized = sanitizeUserVisibleToolTextResult(entry, bootPrompt);
    suppressionReason ??= sanitized.suppressionReason;
    return sanitized.text;
  });
  return suppressionReason;
}

function sanitizePresentationTextFieldsResult(
  value: unknown,
  bootPrompt: string | undefined,
): { value: unknown; suppressionReason?: VisibleTextSuppressionReason } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value };
  }
  let suppressionReason: VisibleTextSuppressionReason | undefined;
  const presentation = { ...(value as Record<string, unknown>) };
  if (typeof presentation.title === "string") {
    const sanitized = sanitizeUserVisibleToolTextResult(presentation.title, bootPrompt);
    presentation.title = sanitized.text;
    suppressionReason ??= sanitized.suppressionReason;
  }
  if (Array.isArray(presentation.blocks)) {
    presentation.blocks = presentation.blocks.map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return block;
      }
      const sanitizedBlock = { ...(block as Record<string, unknown>) };
      for (const field of ["text", "placeholder", "title", "xLabel", "yLabel"]) {
        if (typeof sanitizedBlock[field] === "string") {
          const sanitized = sanitizeUserVisibleToolTextResult(sanitizedBlock[field], bootPrompt);
          sanitizedBlock[field] = sanitized.text;
          suppressionReason ??= sanitized.suppressionReason;
        }
      }
      if (normalizeOptionalLowercaseString(sanitizedBlock.type) === "table") {
        if (typeof sanitizedBlock.caption === "string") {
          const sanitized = sanitizeUserVisibleToolTextResult(sanitizedBlock.caption, bootPrompt);
          sanitizedBlock.caption = sanitized.text.trim();
          suppressionReason ??= sanitized.suppressionReason;
        }
        if (Array.isArray(sanitizedBlock.headers)) {
          sanitizedBlock.headers = sanitizedBlock.headers.map((header) => {
            if (typeof header !== "string") {
              return header;
            }
            const sanitized = sanitizeUserVisibleToolTextResult(header, bootPrompt);
            suppressionReason ??= sanitized.suppressionReason;
            return sanitized.text.trim();
          });
        }
        if (Array.isArray(sanitizedBlock.rows)) {
          sanitizedBlock.rows = sanitizedBlock.rows.map((row) => {
            if (!Array.isArray(row)) {
              return row;
            }
            return row.map((cell) => {
              if (typeof cell !== "string") {
                return cell;
              }
              const sanitized = sanitizeUserVisibleToolTextResult(cell, bootPrompt);
              suppressionReason ??= sanitized.suppressionReason;
              return sanitized.text.trim();
            });
          });
        }
      }
      if (Array.isArray(sanitizedBlock.buttons)) {
        sanitizedBlock.buttons = sanitizedBlock.buttons.map((button) => {
          if (!button || typeof button !== "object" || Array.isArray(button)) {
            return button;
          }
          const sanitizedButton = { ...(button as Record<string, unknown>) };
          if (typeof sanitizedButton.label === "string") {
            const sanitized = sanitizeUserVisibleToolTextResult(sanitizedButton.label, bootPrompt);
            sanitizedButton.label = sanitized.text;
            suppressionReason ??= sanitized.suppressionReason;
          }
          if (typeof sanitizedButton.url === "string") {
            const sanitized = sanitizeUserVisibleToolTextResult(sanitizedButton.url, bootPrompt);
            if (sanitized.text) {
              sanitizedButton.url = sanitized.text;
            } else {
              delete sanitizedButton.url;
            }
            suppressionReason ??= sanitized.suppressionReason;
          }
          for (const webAppField of ["webApp", "web_app"]) {
            const webApp = sanitizedButton[webAppField];
            if (!webApp || typeof webApp !== "object" || Array.isArray(webApp)) {
              continue;
            }
            const sanitizedWebApp = { ...(webApp as Record<string, unknown>) };
            if (typeof sanitizedWebApp.url !== "string") {
              continue;
            }
            const sanitized = sanitizeUserVisibleToolTextResult(sanitizedWebApp.url, bootPrompt);
            if (sanitized.text) {
              sanitizedWebApp.url = sanitized.text;
              sanitizedButton[webAppField] = sanitizedWebApp;
            } else {
              delete sanitizedButton[webAppField];
            }
            suppressionReason ??= sanitized.suppressionReason;
          }
          const action = sanitizedButton.action;
          if (action && typeof action === "object" && !Array.isArray(action)) {
            const sanitizedAction = { ...(action as Record<string, unknown>) };
            if (
              (sanitizedAction.type === "url" || sanitizedAction.type === "web-app") &&
              typeof sanitizedAction.url === "string"
            ) {
              const sanitized = sanitizeUserVisibleToolTextResult(sanitizedAction.url, bootPrompt);
              if (sanitized.text) {
                sanitizedAction.url = sanitized.text;
                sanitizedButton.action = sanitizedAction;
              } else if (
                sanitizedAction.type === "web-app" &&
                typeof sanitizedAction.widgetId === "string" &&
                sanitizedAction.widgetId.trim()
              ) {
                delete sanitizedAction.url;
                sanitizedButton.action = sanitizedAction;
              } else {
                // Explicit typed actions own the control. If sanitization removes
                // the target, legacy shadow fields must not become active fallbacks.
                delete sanitizedButton.action;
                delete sanitizedButton.value;
                delete sanitizedButton.url;
                delete sanitizedButton.webApp;
                delete sanitizedButton.web_app;
              }
              suppressionReason ??= sanitized.suppressionReason;
            }
          }
          return sanitizedButton;
        });
      }
      if (Array.isArray(sanitizedBlock.options)) {
        sanitizedBlock.options = sanitizedBlock.options.map((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            return option;
          }
          const sanitizedOption = { ...(option as Record<string, unknown>) };
          if (typeof sanitizedOption.label === "string") {
            const sanitized = sanitizeUserVisibleToolTextResult(sanitizedOption.label, bootPrompt);
            sanitizedOption.label = sanitized.text;
            suppressionReason ??= sanitized.suppressionReason;
          }
          return sanitizedOption;
        });
      }
      if (Array.isArray(sanitizedBlock.categories)) {
        sanitizedBlock.categories = sanitizedBlock.categories.map((category) => {
          if (typeof category !== "string") {
            return category;
          }
          const sanitized = sanitizeUserVisibleToolTextResult(category, bootPrompt);
          suppressionReason ??= sanitized.suppressionReason;
          return sanitized.text;
        });
      }
      if (Array.isArray(sanitizedBlock.segments)) {
        sanitizedBlock.segments = sanitizedBlock.segments.map((segment) => {
          if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
            return segment;
          }
          const sanitizedSegment = { ...(segment as Record<string, unknown>) };
          if (typeof sanitizedSegment.label === "string") {
            const sanitized = sanitizeUserVisibleToolTextResult(sanitizedSegment.label, bootPrompt);
            sanitizedSegment.label = sanitized.text;
            suppressionReason ??= sanitized.suppressionReason;
          }
          return sanitizedSegment;
        });
      }
      if (Array.isArray(sanitizedBlock.series)) {
        sanitizedBlock.series = sanitizedBlock.series.map((series) => {
          if (!series || typeof series !== "object" || Array.isArray(series)) {
            return series;
          }
          const sanitizedSeries = { ...(series as Record<string, unknown>) };
          if (typeof sanitizedSeries.name === "string") {
            const sanitized = sanitizeUserVisibleToolTextResult(sanitizedSeries.name, bootPrompt);
            sanitizedSeries.name = sanitized.text;
            suppressionReason ??= sanitized.suppressionReason;
          }
          return sanitizedSeries;
        });
      }
      return sanitizedBlock;
    });
  }
  return { value: presentation, ...(suppressionReason ? { suppressionReason } : {}) };
}

function readFirstStringParam(params: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = readToolStringParam(params, key);
    if (value) {
      return value;
    }
  }
  return "";
}

function readStructuredAttachmentMediaParams(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const values: string[] = [];
  for (const attachment of value) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      continue;
    }
    const record = attachment as Record<string, unknown>;
    for (const key of ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"]) {
      const candidate = readToolStringParam(record, key);
      if (candidate) {
        values.push(candidate);
      }
    }
  }
  return values;
}

export function hasSanitizedSendPayloadContent(params: Record<string, unknown>): boolean {
  const text = ["message", "text", "content", "caption", "SendMessage"]
    .map((field) => (typeof params[field] === "string" ? params[field] : ""))
    .filter((value) => value.trim())
    .join("\n");
  const mediaUrls = [
    ...(readStringArrayParam(params, "mediaUrls") ?? []),
    ...readStructuredAttachmentMediaParams(params.attachments),
  ];
  return hasReplyPayloadContent({
    text,
    mediaUrl: readFirstStringParam(params, ["media", "mediaUrl", "path", "filePath", "fileUrl"]),
    mediaUrls,
    presentation: params.presentation,
    interactive: params.interactive,
    location: params.location,
  });
}

export function sanitizeMessageToolVisiblePayload(
  params: Record<string, unknown>,
  agentSessionKey?: string,
): VisibleTextSuppressionReason | undefined {
  // Sanitize outbound text fields in three layers:
  //
  // 1. `stripFormattedReasoningMessage` — drops reasoning blocks
  //    that some models emit into tool arguments.
  // 2. `stripInternalRuntimeContext` — removes internal-runtime-context
  //    delimited blocks (the same strip applied to final replies via
  //    `sanitizeUserFacingText`). Catches wrapped BOOT.md or webchat
  //    runtime-context echoes that preserve the marker lines.
  // 3. `stripBootEchoFromOutboundText` — defense-in-depth check against
  //    the active boot prompt for this session. Catches verbatim echoes
  //    that paraphrase out the wrapper markers but reproduce a
  //    substantial chunk of the boot prompt content. Refs #53732.
  const bootPromptForSession = getBootEchoContextForSession(agentSessionKey);
  let suppressedVisiblePayloadReason: VisibleTextSuppressionReason | undefined;
  parseJsonMessageParam(params, "presentation");
  parseInteractiveParam(params);
  for (const field of [
    "text",
    "content",
    "message",
    "caption",
    "SendMessage",
    "quoteText",
    "quote_text",
  ]) {
    const suppressionReason = sanitizeStringParam(params, field, bootPromptForSession);
    suppressedVisiblePayloadReason ??= suppressionReason;
  }
  for (const field of ["pollQuestion", "poll_question"]) {
    const suppressionReason = sanitizeStringParam(params, field, bootPromptForSession);
    suppressedVisiblePayloadReason ??= suppressionReason;
  }
  for (const field of ["pollOption", "poll_option"]) {
    const suppressionReason = sanitizeStringArrayParam(params, field, bootPromptForSession);
    suppressedVisiblePayloadReason ??= suppressionReason;
  }
  const sanitizedPresentation = sanitizePresentationTextFieldsResult(
    params.presentation,
    bootPromptForSession,
  );
  params.presentation = sanitizedPresentation.value;
  suppressedVisiblePayloadReason ??= sanitizedPresentation.suppressionReason;
  const sanitizedInteractive = sanitizePresentationTextFieldsResult(
    params.interactive,
    bootPromptForSession,
  );
  params.interactive = sanitizedInteractive.value;
  suppressedVisiblePayloadReason ??= sanitizedInteractive.suppressionReason;
  return suppressedVisiblePayloadReason;
}
