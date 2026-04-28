import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultSlackAccountId, resolveSlackAccount } from "./accounts.js";

const SLACK_BUTTON_MAX_ITEMS = 5;
const SLACK_SELECT_MAX_ITEMS = 100;
const SLACK_DIRECTIVE_RE = /\[\[(slack_buttons|slack_select):\s*([^\]]+)\]\]/gi;
const SLACK_OPTIONS_LINE_RE = /^\s*Options:\s*(.+?)\s*\.?\s*$/i;
const SLACK_AUTO_SELECT_MAX_ITEMS = 12;
const SLACK_SIMPLE_OPTION_RE = /^[a-z0-9][a-z0-9 _+/-]{0,31}$/i;

type SlackChoice = {
  label: string;
  value: string;
  style?: "primary" | "secondary" | "success" | "danger";
};

function parseChoice(raw: string, options?: { allowStyle?: boolean }): SlackChoice | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const delimiter = trimmed.indexOf(":");
  if (delimiter === -1) {
    return {
      label: trimmed,
      value: trimmed,
    };
  }
  const label = trimmed.slice(0, delimiter).trim();
  let value = trimmed.slice(delimiter + 1).trim();
  if (!label || !value) {
    return null;
  }
  let style: SlackChoice["style"];
  if (options?.allowStyle) {
    const styleDelimiter = value.lastIndexOf(":");
    if (styleDelimiter !== -1) {
      const maybeStyle = normalizeLowercaseStringOrEmpty(value.slice(styleDelimiter + 1));
      if (
        maybeStyle === "primary" ||
        maybeStyle === "secondary" ||
        maybeStyle === "success" ||
        maybeStyle === "danger"
      ) {
        const unstyledValue = value.slice(0, styleDelimiter).trim();
        if (unstyledValue) {
          value = unstyledValue;
          style = maybeStyle;
        }
      }
    }
  }
  return style ? { label, value, style } : { label, value };
}

function parseChoices(
  raw: string,
  maxItems: number,
  options?: { allowStyle?: boolean },
): SlackChoice[] {
  return raw
    .split(",")
    .map((entry) => parseChoice(entry, options))
    .filter((entry): entry is SlackChoice => Boolean(entry))
    .slice(0, maxItems);
}

function buildTextBlock(
  text: string,
): NonNullable<ReplyPayload["interactive"]>["blocks"][number] | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return { type: "text", text: trimmed };
}

function buildButtonsBlock(
  raw: string,
): NonNullable<ReplyPayload["interactive"]>["blocks"][number] | null {
  const choices = parseChoices(raw, SLACK_BUTTON_MAX_ITEMS, { allowStyle: true });
  if (choices.length === 0) {
    return null;
  }
  return {
    type: "buttons",
    buttons: choices.map((choice) =>
      Object.assign(
        { label: choice.label, value: choice.value },
        choice.style ? { style: choice.style } : {},
      ),
    ),
  };
}

function buildSelectBlock(
  raw: string,
): NonNullable<ReplyPayload["interactive"]>["blocks"][number] | null {
  const parts = raw
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const [first, second] = parts;
  const placeholder = parts.length >= 2 ? first : "Choose an option";
  const choices = parseChoices(parts.length >= 2 ? second : first, SLACK_SELECT_MAX_ITEMS);
  if (choices.length === 0) {
    return null;
  }
  return {
    type: "select",
    placeholder,
    options: choices,
  };
}

function hasSlackBlocks(payload: ReplyPayload): boolean {
  const blocks = (payload.channelData?.slack as { blocks?: unknown } | undefined)?.blocks;
  if (typeof blocks === "string") {
    return blocks.trim().length > 0;
  }
  return Array.isArray(blocks) && blocks.length > 0;
}

function parseSimpleSlackOptions(raw: string): SlackChoice[] | null {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length < 2 || entries.length > SLACK_AUTO_SELECT_MAX_ITEMS) {
    return null;
  }
  if (!entries.every((entry) => SLACK_SIMPLE_OPTION_RE.test(entry))) {
    return null;
  }
  const deduped = new Set(entries.map((entry) => normalizeLowercaseStringOrEmpty(entry)));
  if (deduped.size !== entries.length) {
    return null;
  }
  return entries.map((entry) => ({
    label: entry,
    value: entry,
  }));
}

function resolveInteractiveRepliesFromCapabilities(capabilities: unknown): boolean {
  if (!capabilities) {
    return false;
  }
  if (Array.isArray(capabilities)) {
    return capabilities.some(
      (entry) => normalizeLowercaseStringOrEmpty(String(entry)) === "interactivereplies",
    );
  }
  if (typeof capabilities === "object") {
    return (capabilities as { interactiveReplies?: unknown }).interactiveReplies === true;
  }
  return false;
}

export function isSlackInteractiveRepliesEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  });
  return resolveInteractiveRepliesFromCapabilities(account.config.capabilities);
}

export function compileSlackInteractiveReplies(payload: ReplyPayload): ReplyPayload {
  const text = payload.text;
  if (!text) {
    return payload;
  }

  const generatedBlocks: NonNullable<ReplyPayload["interactive"]>["blocks"] = [];
  const visibleTextParts: string[] = [];
  let cursor = 0;
  let matchedDirective = false;
  let generatedInteractiveBlock = false;
  SLACK_DIRECTIVE_RE.lastIndex = 0;

  for (const match of text.matchAll(SLACK_DIRECTIVE_RE)) {
    matchedDirective = true;
    const matchText = match[0];
    const directiveType = match[1];
    const body = match[2];
    const index = match.index ?? 0;
    const precedingText = text.slice(cursor, index);
    visibleTextParts.push(precedingText);
    const section = buildTextBlock(precedingText);
    if (section) {
      generatedBlocks.push(section);
    }
    const block =
      normalizeLowercaseStringOrEmpty(directiveType) === "slack_buttons"
        ? buildButtonsBlock(body)
        : buildSelectBlock(body);
    if (block) {
      generatedInteractiveBlock = true;
      generatedBlocks.push(block);
    }
    cursor = index + matchText.length;
  }

  const trailingText = text.slice(cursor);
  visibleTextParts.push(trailingText);
  const trailingSection = buildTextBlock(trailingText);
  if (trailingSection) {
    generatedBlocks.push(trailingSection);
  }
  const cleanedText = visibleTextParts.join("");

  if (!matchedDirective || !generatedInteractiveBlock) {
    return parseSlackOptionsLine(payload);
  }

  return {
    ...payload,
    text: cleanedText.trim() || undefined,
    interactive: {
      blocks: [...(payload.interactive?.blocks ?? []), ...generatedBlocks],
    },
  };
}

export function parseSlackOptionsLine(payload: ReplyPayload): ReplyPayload {
  const text = payload.text;
  if (!text || payload.interactive?.blocks?.length || hasSlackBlocks(payload)) {
    return payload;
  }

  const lines = text.split("\n");
  const lastNonEmptyIndex = [...lines.keys()].toReversed().find((index) => lines[index]?.trim());
  if (lastNonEmptyIndex == null) {
    return payload;
  }

  const optionsLine = lines[lastNonEmptyIndex] ?? "";
  const match = optionsLine.match(SLACK_OPTIONS_LINE_RE);
  if (!match) {
    return payload;
  }

  const choices = parseSimpleSlackOptions(match[1] ?? "");
  if (!choices) {
    return payload;
  }

  const bodyText = lines
    .filter((_, index) => index !== lastNonEmptyIndex)
    .join("\n")
    .trim();
  const generatedBlocks: NonNullable<ReplyPayload["interactive"]>["blocks"] = [];
  const bodyBlock = buildTextBlock(bodyText);
  if (bodyBlock) {
    generatedBlocks.push(bodyBlock);
  }
  generatedBlocks.push(
    choices.length <= SLACK_BUTTON_MAX_ITEMS
      ? {
          type: "buttons",
          buttons: choices,
        }
      : {
          type: "select",
          placeholder: "Choose an option",
          options: choices,
        },
  );

  return {
    ...payload,
    text: bodyText || undefined,
    interactive: {
      blocks: [...(payload.interactive?.blocks ?? []), ...generatedBlocks],
    },
  };
}
