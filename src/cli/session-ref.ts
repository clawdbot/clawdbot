import { isSensitiveUrlQueryParamName } from "@openclaw/net-policy/redact-sensitive-url";
import {
  type ControlUiSessionPathTarget,
  parseControlUiSessionPath,
} from "@openclaw/session-url-contract/parse";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../gateway/connection-details.js";
import { normalizeWebSocketProtocol } from "../gateway/websocket-protocol.js";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

const SESSION_TARGET_HELP =
  "Accepted session targets: https://host[/base]/{chat|dashboard}/<agent>[/<ref>], <host>/<agent>/<ref>, or a bare <slug>-<shortid>, <shortid>, or agent:... key.";

export class SessionTargetParseError extends Error {
  constructor() {
    super(SESSION_TARGET_HELP);
    this.name = "SessionTargetParseError";
  }
}

export type SessionTargetRef =
  | { kind: "main" }
  | { kind: "short"; shortId: string; slugHint?: string }
  | { kind: "literal"; sessionKey: string };

export type SessionTargetInput =
  | {
      kind: "url";
      origin: string;
      basePath: string;
      agentId: string;
      ref: SessionTargetRef;
    }
  | { kind: "ref"; ref: Exclude<SessionTargetRef, { kind: "main" }> };

const BARE_SESSION_TUI_VALUE_OPTIONS = {
  "--token": "token",
  "--password": "password",
  "--tls-fingerprint": "tlsFingerprint",
  "--thinking": "thinking",
  "--message": "message",
  "--timeout-ms": "timeoutMs",
  "--history-limit": "historyLimit",
} as const;

export type BareSessionTuiOptions = Partial<
  Record<
    (typeof BARE_SESSION_TUI_VALUE_OPTIONS)[keyof typeof BARE_SESSION_TUI_VALUE_OPTIONS],
    string
  >
> & { deliver?: boolean };

function refFromPathTarget(target: ControlUiSessionPathTarget): SessionTargetRef {
  if (target.kind === "main") {
    return { kind: "main" };
  }
  if (target.kind === "short") {
    return {
      kind: "short",
      shortId: target.shortId,
      ...(target.slugHint ? { slugHint: target.slugHint } : {}),
    };
  }
  return { kind: "literal", sessionKey: target.sessionKey };
}

function parseControlPath(pathname: string): {
  basePath: string;
  target: ControlUiSessionPathTarget;
} {
  const direct = parseControlUiSessionPath(pathname);
  if (direct) {
    return { basePath: "", target: direct };
  }
  const segments = pathname.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    if (segments[index] !== "chat" && segments[index] !== "dashboard") {
      continue;
    }
    const basePath = segments.slice(0, index).join("/");
    const target = parseControlUiSessionPath(pathname, basePath);
    if (target) {
      return { basePath, target };
    }
  }
  throw new SessionTargetParseError();
}

function rejectUrlCredentials(url: URL): void {
  const fragmentParams = new URLSearchParams(url.hash.replace(/^#/u, ""));
  const sensitiveParam = [...url.searchParams.keys(), ...fragmentParams.keys()].some(
    isSensitiveUrlQueryParamName,
  );
  if (url.username || url.password || sensitiveParam) {
    throw new Error(
      "Session URLs must not contain credentials. Pass --token or --password instead.",
    );
  }
}

function parseSessionUrl(raw: string): SessionTargetInput {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SessionTargetParseError();
  }
  rejectUrlCredentials(url);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new SessionTargetParseError();
  }
  url.protocol = normalizeWebSocketProtocol(url.protocol);
  const parsed = parseControlPath(url.pathname);
  const gatewayUrl = `${url.origin}${parsed.basePath}`;
  // Keep the established plaintext transport gate and its operator guidance canonical.
  buildGatewayConnectionDetailsWithResolvers({ config: {}, url: gatewayUrl });
  return {
    kind: "url",
    origin: url.origin,
    basePath: parsed.basePath,
    agentId: parsed.target.agentId,
    ref: refFromPathTarget(parsed.target),
  };
}

function parseHostShorthand(raw: string): SessionTargetInput | null {
  const normalized = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const parts = normalized.split("/");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    return null;
  }
  let host: URL;
  try {
    host = new URL(`wss://${parts[0]}`);
  } catch {
    throw new SessionTargetParseError();
  }
  rejectUrlCredentials(host);
  if (host.pathname !== "/" || host.search || host.hash) {
    throw new SessionTargetParseError();
  }
  const target = parseControlUiSessionPath(`/dashboard/${parts[1]}/${parts[2]}`);
  if (!target) {
    throw new SessionTargetParseError();
  }
  return {
    kind: "url",
    origin: host.origin,
    basePath: "",
    agentId: target.agentId,
    ref: refFromPathTarget(target),
  };
}

export function parseSessionTargetInput(raw: string): SessionTargetInput {
  const value = raw.trim();
  if (!value) {
    throw new SessionTargetParseError();
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    return parseSessionUrl(value);
  }
  const agentKey = parseAgentSessionKey(value);
  if (agentKey) {
    return {
      kind: "ref",
      ref: {
        kind: "literal",
        sessionKey: `agent:${agentKey.agentId}:${agentKey.rest}`,
      },
    };
  }
  const shorthand = parseHostShorthand(value);
  if (shorthand) {
    return shorthand;
  }
  const short = parseControlUiSessionPath(`/dashboard/main/${value}`);
  if (short?.kind === "short") {
    return {
      kind: "ref",
      ref: {
        kind: "short",
        shortId: short.shortId,
        ...(short.slugHint ? { slugHint: short.slugHint } : {}),
      },
    };
  }
  throw new SessionTargetParseError();
}

export type BareSessionInvocation = {
  target: string;
  options: BareSessionTuiOptions;
};

function isSessionUrlInputCandidate(raw: string): boolean {
  return /^(?:https?|wss?):\/\//iu.test(raw.trim());
}

function findBareSessionUrlIndex(argv: readonly string[]): number {
  for (let index = 2; index < argv.length; index += 1) {
    const rootConsumed = consumeRootOptionToken(argv, index);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    const arg = argv[index];
    if (arg && isSessionUrlInputCandidate(arg)) {
      return index;
    }
  }
  return -1;
}

function bareSessionOptionError(flag: string): Error {
  return new Error(
    `Unsupported bare session URL option: ${sanitizeTerminalText(flag)}. Use \`openclaw tui <url> --help\` for the full option list.`,
  );
}

/** Parse the complete bare-root URL invocation before generic command discovery can see secrets. */
export function parseBareSessionInvocation(argv: readonly string[]): BareSessionInvocation | null {
  const targetIndex = findBareSessionUrlIndex(argv);
  if (targetIndex === -1) {
    return null;
  }
  const options: BareSessionTuiOptions = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (index === targetIndex) {
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      throw bareSessionOptionError(FLAG_TERMINATOR);
    }
    const rootConsumed = consumeRootOptionToken(argv, index);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    if (arg === "--deliver") {
      options.deliver = true;
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const optionKey =
      BARE_SESSION_TUI_VALUE_OPTIONS[flag as keyof typeof BARE_SESSION_TUI_VALUE_OPTIONS];
    if (!optionKey) {
      if (!arg.startsWith("-")) {
        // A positional before the URL is an explicit core/plugin command owner.
        // Leave its URL argument untouched for Commander and plugin routing.
        if (index < targetIndex) {
          return null;
        }
        throw new Error(
          "Unexpected extra argument for bare session URL. Use `openclaw tui <url> --help` for the full option list.",
        );
      }
      throw bareSessionOptionError(flag);
    }
    const value = equalsIndex === -1 ? argv[index + 1] : arg.slice(equalsIndex + 1);
    if (
      !value ||
      value === FLAG_TERMINATOR ||
      (equalsIndex === -1 && (index + 1 === targetIndex || value.startsWith("-")))
    ) {
      throw new Error(`${flag} requires a value.`);
    }
    options[optionKey] = value;
    if (equalsIndex === -1) {
      index += 1;
    }
  }
  return { target: argv[targetIndex] ?? "", options };
}
