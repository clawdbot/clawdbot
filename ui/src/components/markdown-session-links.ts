import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { ControlUiSessionNamespace } from "@openclaw/session-url-contract";
import type { MarkdownIt, Token } from "markdown-it";
import { resolveGatewayPublicOrigin } from "../../../src/config/gateway-public-origin.js";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { resolveControlUiPaths } from "../app/browser.ts";
import type { ApplicationContext } from "../app/context.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { hasMarkdownLinkBoundaries } from "./markdown-link-boundary.ts";

export const SESSION_LINK_SCAN_RE = /agent:[^\s<>"'`]*[^\s<>"'`.,;:!?)}\]]/g;

type SessionKeyTarget = {
  sessionKey: string;
  agentId: string;
};

type SessionPathTarget = {
  namespace: ControlUiSessionNamespace;
  pathname: string;
  search?: string;
  hash?: string;
};

export type SessionLinkTarget = SessionKeyTarget | SessionPathTarget;

function parseSessionLinkKey(raw: string): SessionKeyTarget | null {
  const sessionKey = raw.trim();
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed || `agent:${parsed.agentId}:${parsed.rest}` !== sessionKey.toLowerCase()) {
    return null;
  }
  return { sessionKey, agentId: parsed.agentId };
}

export function parseMarkdownSessionUrl(raw: string, basePath?: string, mainKey?: string) {
  if (!/^(?:https?:\/\/|\/)/i.test(raw.trim())) {
    return null;
  }
  try {
    const url = new URL(raw, globalThis.location.href);
    const target = sessionRefFromPath(
      url.pathname,
      basePath ?? resolveControlUiPaths(globalThis.location.pathname)[0],
      mainKey,
    );
    return target && (url.protocol === "http:" || url.protocol === "https:")
      ? { url, target }
      : null;
  } catch {
    return null;
  }
}

export function installMarkdownSessionLinks(markdownParser: MarkdownIt, scanPattern: RegExp): void {
  // Capture cleaned hrefs before file decoration can claim session-shaped paths.
  markdownParser.core.ruler.before("file-links", "session-links", (state) => {
    if (state.env?.sessionLinks !== true) {
      return;
    }
    const decorate = (token: Token, raw: string): boolean => {
      const key = parseSessionLinkKey(raw);
      const path = key ? null : parseMarkdownSessionUrl(raw);
      if (!key && !path) {
        return false;
      }
      if (path) {
        // The context-aware titler also recognizes the Gateway's configured public origin.
        token.attrSet("data-session-href", raw);
        if (path.url.origin !== globalThis.location.origin) {
          return false;
        }
        token.attrSet("href", raw);
      } else if (key) {
        token.attrSet("data-session-key", key.sessionKey);
      }
      token.attrJoin("class", "markdown-session-link");
      token.attrSet("role", "link");
      token.attrSet("tabindex", "0");
      return true;
    };
    for (const blockToken of state.tokens) {
      const children = blockToken.children;
      if (blockToken.type !== "inline" || !children) {
        continue;
      }
      let linkDepth = 0;
      for (let index = 0; index < children.length; index++) {
        const token = children[index];
        if (!token) {
          continue;
        }
        if (token.type === "link_open") {
          decorate(token, String(token.attrGet("href") ?? ""));
          linkDepth++;
        } else if (token.type === "link_close") {
          linkDepth--;
        } else if (linkDepth === 0 && token.type === "code_inline") {
          const open = new state.Token("link_open", "a", 1);
          if (decorate(open, token.content)) {
            children.splice(index, 1, open, token, new state.Token("link_close", "a", -1));
            index += 2;
          } else if (open.attrGet("data-session-href")) {
            token.attrSet("data-session-href", token.content);
          }
        } else if (linkDepth === 0 && token.type === "text") {
          const replacements: Token[] = [];
          let cursor = 0;
          const text = (content: string) => {
            const label = new state.Token("text", "", 0);
            label.content = content;
            replacements.push(label);
          };
          for (const match of token.content.matchAll(scanPattern)) {
            const end = match.index + match[0].length;
            const open = new state.Token("link_open", "a", 1);
            if (
              !hasMarkdownLinkBoundaries(token.content, match.index, end) ||
              !decorate(open, match[0])
            ) {
              continue;
            }
            text(token.content.slice(cursor, match.index));
            replacements.push(open);
            text(match[0]);
            replacements.push(new state.Token("link_close", "a", -1));
            cursor = end;
          }
          if (cursor) {
            text(token.content.slice(cursor));
            children.splice(index, 1, ...replacements);
            index += replacements.length - 1;
          }
        }
      }
    }
  });
}

export function markdownSessionPublicOrigin(
  context?: ApplicationContext | null,
): string | undefined {
  const config = context?.runtimeConfig?.state.configSnapshot?.runtimeConfig;
  return resolveGatewayPublicOrigin({
    gateway: { publicOrigin: readNonBlankString(asOptionalRecord(config?.gateway)?.publicOrigin) },
  });
}

export function markdownSessionLinkFromEvent(
  event: Event,
  basePath?: string,
): SessionLinkTarget | null {
  const anchor =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>("a, [data-session-href]")
      : null;
  const sessionKey = anchor?.dataset.sessionKey;
  if (sessionKey && !anchor.dataset.sessionHref) {
    return parseSessionLinkKey(sessionKey);
  }
  // Lit assigns context before the lazy provider upgrades; routing must not wait for its card.
  const context = anchor?.closest<HTMLElement & { context?: ApplicationContext | null }>(
    "openclaw-session-progress-hovercard-provider",
  )?.context;
  const href = anchor?.getAttribute("href") ?? anchor?.dataset.sessionHref;
  const path = href ? parseMarkdownSessionUrl(href, basePath ?? context?.basePath) : null;
  if (
    !path ||
    (path.url.origin !== globalThis.location.origin &&
      path.url.origin !== markdownSessionPublicOrigin(context))
  ) {
    return null;
  }
  const { url, target: parsed } = path;
  return {
    namespace: parsed.namespace,
    pathname: url.pathname,
    ...(url.search ? { search: url.search } : {}),
    ...(url.hash ? { hash: url.hash } : {}),
  };
}

export function markdownSessionLinkFromKeyboardEvent(
  event: KeyboardEvent,
  basePath?: string,
): SessionLinkTarget | null {
  if (event.key !== "Enter" && event.key !== " ") {
    return null;
  }
  const target = markdownSessionLinkFromEvent(event, basePath);
  if (target) {
    event.preventDefault();
  }
  return target;
}

export function navigateMarkdownSession(
  context: ApplicationContext,
  target: SessionLinkTarget,
): void {
  if ("pathname" in target) {
    const { namespace, ...options } = target;
    context.navigate(namespace, options);
    return;
  }
  const navigation = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey: target.sessionKey,
    agentId: target.agentId,
    exactKey: true,
    preferenceDerivedFace: true,
  });
  context.navigate("chat", navigation.options);
}
