import { html } from "lit";

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

export function renderHighlightedCommand(command: string) {
  if (command.length > COMMAND_HIGHLIGHT_MAX_CHARS) {
    return html`${command}`;
  }
  return html`${tokenizeCommand(command).map((token) =>
    token.cls === "ws" || token.cls === "plain"
      ? html`${token.text}`
      : html`<span class="chat-cmd--${token.cls}">${token.text}</span>`,
  )}`;
}
