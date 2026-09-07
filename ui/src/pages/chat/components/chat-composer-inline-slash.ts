import {
  getSlashCommandCompletions,
  type InlineSlashCompletion,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";

type InlineSlashState = {
  slashMenuCompletion: InlineSlashCompletion | null;
};

type InlineSlashHost = {
  getDraft: () => string;
  commitDraft: (next: string) => void;
  getTextarea: () => HTMLTextAreaElement | null;
};

type InlineSlashArgumentInvocation = {
  command: SlashCommandDef;
  completion: InlineSlashCompletion;
};

function commitDraftWithCaret(host: InlineSlashHost, next: string, caret: number): void {
  const target = host.getTextarea();
  if (target) {
    target.value = next;
    adjustTextareaHeight(target);
  }
  host.commitDraft(next);
  queueMicrotask(() => {
    const textarea = host.getTextarea();
    if (!textarea) {
      return;
    }
    textarea.focus({ preventScroll: true });
    textarea.selectionStart = caret;
    textarea.selectionEnd = caret;
  });
}

export function commitInlineSlashSelection(
  replacement: string,
  state: InlineSlashState,
  host: InlineSlashHost,
): boolean {
  const completion = state.slashMenuCompletion;
  if (!completion?.inline) {
    return false;
  }
  const current = host.getTextarea()?.value ?? host.getDraft();
  const after = current.slice(completion.end);
  const separator = after.length === 0 || !/^\s/u.test(after) ? " " : "";
  const next = `${current.slice(0, completion.start)}${replacement}${separator}${after}`;
  commitDraftWithCaret(host, next, completion.start + replacement.length + separator.length);
  return true;
}

export function beginInlineFreeformSlashArguments(
  commandName: string,
  state: InlineSlashState,
  host: InlineSlashHost,
): boolean {
  const completion = state.slashMenuCompletion;
  if (!completion?.inline) {
    return false;
  }
  const current = host.getTextarea()?.value ?? host.getDraft();
  const replacement = `/${commandName} `;
  const next = `${current.slice(0, completion.start)}${replacement}${current.slice(completion.end)}`;
  const caret = completion.start + replacement.length;
  commitDraftWithCaret(host, next, caret);
  state.slashMenuCompletion = {
    query: commandName,
    start: completion.start,
    end: caret,
    inline: true,
    argumentStart: caret,
  };
  return true;
}

export function removeInlineSlashSelection(
  state: InlineSlashState,
  host: InlineSlashHost,
): boolean {
  const completion = state.slashMenuCompletion;
  if (!completion?.inline) {
    return false;
  }
  const current = host.getTextarea()?.value ?? host.getDraft();
  const before = current.slice(0, completion.start);
  let after = current.slice(completion.end);
  if (/\s$/u.test(before) && /^\s/u.test(after)) {
    after = after.slice(1);
  } else if (before.length === 0 && /^\s/u.test(after)) {
    after = after.slice(1);
  }
  commitDraftWithCaret(host, `${before}${after}`, before.length);
  return true;
}

export function hasActiveInlineSlashArgumentPrefix(
  text: string,
  caret: number,
  completion: InlineSlashCompletion,
  commandName: string,
): boolean {
  const commandToken = `/${completion.query}`;
  const argumentStart = completion.argumentStart ?? completion.start + `/${commandName} `.length;
  const prefix = text.slice(completion.start, argumentStart);
  return (
    caret >= argumentStart &&
    prefix.startsWith(commandToken) &&
    /^\s+$/u.test(prefix.slice(commandToken.length))
  );
}

export function findDirectInlineSlashArgumentInvocation(
  text: string,
  caret = text.length,
): InlineSlashArgumentInvocation | null {
  const boundedCaret = Math.max(0, Math.min(caret, text.length));
  const prefix = text.slice(0, boundedCaret);
  const commandPattern = /(?:^|\s)\/([^\s/:]+)\s+/gu;
  let invocation: InlineSlashArgumentInvocation | null = null;

  for (const match of prefix.matchAll(commandPattern)) {
    const typedName = match[1]?.toLowerCase();
    if (!typedName || match.index === undefined) {
      continue;
    }
    const command = getSlashCommandCompletions(typedName, {
      showAll: true,
      inlineOnly: true,
    }).find(
      (entry) =>
        entry.name.toLowerCase() === typedName ||
        entry.aliases?.some((alias) => alias.replace(/^\//u, "").toLowerCase() === typedName),
    );
    if (!command?.args || command.source === "skill") {
      continue;
    }
    const start = match.index + match[0].indexOf("/");
    const args = prefix.slice(match.index + match[0].length).trim();
    if (/\s/u.test(args) && !command.allowsInlineMultiWordArgs) {
      continue;
    }
    invocation = {
      command,
      completion: {
        query: typedName,
        start,
        end: boundedCaret,
        inline:
          text.slice(0, start).trim().length > 0 || text.slice(boundedCaret).trim().length > 0,
        argumentStart: match.index + match[0].length,
      },
    };
  }

  return invocation?.completion.inline ? invocation : null;
}
