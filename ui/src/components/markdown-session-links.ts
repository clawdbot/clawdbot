import type MarkdownIt from "markdown-it";
import type { ApplicationContext } from "../app/context.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";

export const SESSION_LINK_SCAN_RE = /agent:[^\s<>"'`]*[^\s<>"'`.,;:!?)}\]]/g;

export type SessionLinkTarget = {
  sessionKey: string;
  agentId: string;
};

type SessionLinkMeta = {
  sessionKey: string;
};

function isSessionLinkBoundaryBefore(value: string, index: number): boolean {
  const char = value[index - 1];
  return char === undefined || /\s/.test(char) || "([{<\"'`".includes(char);
}

function isSessionLinkBoundaryAfter(value: string, index: number): boolean {
  const char = value[index];
  return char === undefined || /\s/.test(char) || ".,;:!?)]}>\"'".includes(char);
}

function parseSessionLinkKey(raw: string): SessionLinkTarget | null {
  const sessionKey = raw.trim();
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed || `agent:${parsed.agentId}:${parsed.rest}` !== sessionKey.toLowerCase()) {
    return null;
  }
  return { sessionKey, agentId: parsed.agentId };
}

export function installMarkdownSessionLinks(markdownParser: MarkdownIt, scanPattern: RegExp): void {
  markdownParser.core.ruler.after("linkify", "session-links", (state) => {
    const sessionLinks: unknown = state.env?.sessionLinks;
    if (sessionLinks !== true) {
      return;
    }
    for (const blockToken of state.tokens) {
      if (blockToken.type !== "inline" || !blockToken.children) {
        continue;
      }
      const children = blockToken.children;
      let linkDepth = 0;
      for (let index = 0; index < children.length; index++) {
        const token = children[index];
        if (!token) {
          continue;
        }
        if (token.type === "link_open") {
          linkDepth += 1;
          continue;
        }
        if (token.type === "link_close") {
          linkDepth = Math.max(0, linkDepth - 1);
          continue;
        }
        if (linkDepth > 0) {
          continue;
        }
        if (token.type === "code_inline") {
          const target = parseSessionLinkKey(token.content);
          if (target) {
            token.meta = {
              ...token.meta,
              sessionLink: { sessionKey: target.sessionKey } satisfies SessionLinkMeta,
            };
          }
          continue;
        }
        if (token.type !== "text") {
          continue;
        }

        const replacements: typeof children = [];
        let cursor = 0;
        scanPattern.lastIndex = 0;
        for (const match of token.content.matchAll(scanPattern)) {
          const matchIndex = match.index;
          const matched = match[0];
          const matchEnd = matchIndex + matched.length;
          if (
            !isSessionLinkBoundaryBefore(token.content, matchIndex) ||
            !isSessionLinkBoundaryAfter(token.content, matchEnd) ||
            !parseSessionLinkKey(matched)
          ) {
            continue;
          }
          if (matchIndex > cursor) {
            const leading = new state.Token("text", "", 0);
            leading.content = token.content.slice(cursor, matchIndex);
            replacements.push(leading);
          }
          const open = new state.Token("link_open", "a", 1);
          open.markup = "session-link";
          open.attrSet("class", "markdown-session-link");
          open.attrSet("role", "link");
          open.attrSet("tabindex", "0");
          open.attrSet("data-session-key", matched);
          const label = new state.Token("text", "", 0);
          label.content = matched;
          const close = new state.Token("link_close", "a", -1);
          close.markup = "session-link";
          replacements.push(open, label, close);
          cursor = matchEnd;
        }
        if (replacements.length === 0) {
          continue;
        }
        if (cursor < token.content.length) {
          const trailing = new state.Token("text", "", 0);
          trailing.content = token.content.slice(cursor);
          replacements.push(trailing);
        }
        children.splice(index, 1, ...replacements);
        index += replacements.length - 1;
      }
    }
  });
}

export function markdownSessionLinkFromEvent(event: Event): SessionLinkTarget | null {
  const target = event.target;
  if (!(target instanceof Element)) {
    return null;
  }
  const sessionKey = target.closest<HTMLAnchorElement>("a[data-session-key]")?.dataset.sessionKey;
  return sessionKey ? parseSessionLinkKey(sessionKey) : null;
}

export function markdownSessionLinkFromKeyboardEvent(
  event: KeyboardEvent,
): SessionLinkTarget | null {
  if (event.key !== "Enter" && event.key !== " ") {
    return null;
  }
  const target = markdownSessionLinkFromEvent(event);
  if (target) {
    event.preventDefault();
  }
  return target;
}

export function navigateMarkdownSession(
  context: ApplicationContext,
  target: SessionLinkTarget,
): void {
  const navigation = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey: target.sessionKey,
    agentId: target.agentId,
    preferenceDerivedFace: true,
  });
  context.navigate("chat", navigation.options);
}
