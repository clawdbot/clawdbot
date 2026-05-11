import net from "node:net";
import tls from "node:tls";
import { withTimeout } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  parseIrcLine,
  parseIrcPrefix,
  sanitizeIrcOutboundText,
  sanitizeIrcTarget,
} from "./protocol.js";

const IRC_ERROR_CODES = new Set(["432", "464", "465"]);
const IRC_NICK_COLLISION_CODES = new Set(["433", "436"]);

type IrcPrivmsgEvent = {
  senderNick: string;
  senderUser?: string;
  senderHost?: string;
  target: string;
  text: string;
  rawLine: string;
};

export type IrcClientOptions = {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username: string;
  realname: string;
  password?: string;
  nickserv?: IrcNickServOptions;
  channels?: string[];
  connectTimeoutMs?: number;
  messageChunkMaxChars?: number;
  abortSignal?: AbortSignal;
  onPrivmsg?: (event: IrcPrivmsgEvent) => void | Promise<void>;
  onNotice?: (text: string, target?: string) => void;
  onError?: (error: Error) => void;
  onLine?: (line: string) => void;
};

type IrcNickServOptions = {
  enabled?: boolean;
  service?: string;
  password?: string;
  register?: boolean;
  registerEmail?: string;
};

export type IrcClient = {
  nick: string;
  isReady: () => boolean;
  sendRaw: (line: string) => void;
  join: (channel: string) => void;
  sendPrivmsg: (target: string, text: string) => void;
  quit: (reason?: string) => void;
  close: () => void;
};

function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === "string" ? err : JSON.stringify(err));
}

function buildFallbackNick(nick: string): string {
  const normalized = nick.replace(/\s+/g, "");
  const safe = normalized.replace(/[^A-Za-z0-9_\-[\]\\`^{}|]/g, "");
  const base = safe || "openclaw";
  const suffix = "_";
  const maxNickLen = 30;
  if (base.length >= maxNickLen) {
    return `${base.slice(0, maxNickLen - suffix.length)}${suffix}`;
  }
  return `${base}${suffix}`;
}

function normalizeIrcNick(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

export function buildIrcNickServCommands(options?: IrcNickServOptions): string[] {
  if (!options || options.enabled === false) {
    return [];
  }
  const password = sanitizeIrcOutboundText(options.password ?? "");
  if (!password) {
    return [];
  }
  const service = sanitizeIrcTarget(options.service?.trim() || "NickServ");
  const commands = [`PRIVMSG ${service} :IDENTIFY ${password}`];
  if (options.register) {
    const registerEmail = sanitizeIrcOutboundText(options.registerEmail ?? "");
    if (!registerEmail) {
      throw new Error("IRC NickServ register requires registerEmail");
    }
    commands.push(`PRIVMSG ${service} :REGISTER ${password} ${registerEmail}`);
  }
  return commands;
}

export async function connectIrcClient(options: IrcClientOptions): Promise<IrcClient> {
  const timeoutMs = options.connectTimeoutMs != null ? options.connectTimeoutMs : 15000;
  const messageChunkMaxChars =
    options.messageChunkMaxChars != null ? options.messageChunkMaxChars : 350;

  if (!options.host.trim()) {
    throw new Error("IRC host is required");
  }
  if (!options.nick.trim()) {
    throw new Error("IRC nick is required");
  }

  const desiredNick = options.nick.trim();
  let currentNick = desiredNick;
  let ready = false;
  let closed = false;
  let nickServRecoverAttempted = false;
  let fallbackNickAttempted = false;

  const socket = options.tls
    ? tls.connect({
        host: options.host,
        port: options.port,
        servername: options.host,
      })
    : net.connect({ host: options.host, port: options.port });

  socket.setEncoding("utf8");

  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const fail = (err: unknown) => {
    const error = toError(err);
    if (options.onError) {
      options.onError(error);
    }
    if (!ready && rejectReady) {
      rejectReady(error);
      rejectReady = null;
      resolveReady = null;
    }
  };

  const sendRaw = (line: string) => {
    const cleaned = line.replace(/[\r\n]+/g, "").trim();
    if (!cleaned) {
      throw new Error("IRC command cannot be empty");
    }
    socket.write(`${cleaned}\r\n`);
  };

  const tryRecoverNickCollision = (): boolean => {
    const nickServEnabled = options.nickserv?.enabled !== false;
    const nickservPassword = sanitizeIrcOutboundText(options.nickserv?.password ?? "");
    if (nickServEnabled && !nickServRecoverAttempted && nickservPassword) {
      nickServRecoverAttempted = true;
      try {
        const service = sanitizeIrcTarget(options.nickserv?.service?.trim() || "NickServ");
        sendRaw(`PRIVMSG ${service} :GHOST ${desiredNick} ${nickservPassword}`);
        sendRaw(`NICK ${desiredNick}`);
        return true;
      } catch (err) {
        fail(err);
      }
    }

    if (!fallbackNickAttempted) {
      fallbackNickAttempted = true;
      const fallbackNick = buildFallbackNick(desiredNick);
      if (normalizeIrcNick(fallbackNick) !== normalizeIrcNick(currentNick)) {
        try {
          sendRaw(`NICK ${fallbackNick}`);
          currentNick = fallbackNick;
          return true;
        } catch (err) {
          fail(err);
        }
      }
    }
    return false;
  };

  const join = (channel: string) => {
    const target = sanitizeIrcTarget(channel);
    if (!target.startsWith("#") && !target.startsWith("&")) {
      throw new Error(`IRC JOIN target must be a channel: ${channel}`);
    }
    sendRaw(`JOIN ${target}`);
  };

  const sendPrivmsg = (target: string, text: string) => {
    const normalizedTarget = sanitizeIrcTarget(target);
    const cleaned = sanitizeIrcOutboundText(text);
    if (!cleaned) {
      return;
    }
    let remaining = cleaned;
    while (remaining.length > 0) {
      let chunk = remaining;
      if (chunk.length > messageChunkMaxChars) {
        let splitAt = chunk.lastIndexOf(" ", messageChunkMaxChars);
        if (splitAt < Math.floor(messageChunkMaxChars / 2)) {
          splitAt = messageChunkMaxChars;
        }
        chunk = chunk.slice(0, splitAt).trim();
      }
      if (!chunk) {
        break;
      }
      sendRaw(`PRIVMSG ${normalizedTarget} :${chunk}`);
      remaining = remaining.slice(chunk.length).trimStart();
    }
  };

  const quit = (reason?: string) => {
    if (closed) {
      return;
    }
    closed = true;
    const safeReason = sanitizeIrcOutboundText(reason != null ? reason : "bye");
    try {
      if (safeReason) {
        sendRaw(`QUIT :${safeReason}`);
      } else {
        sendRaw("QUIT");
      }
    } catch {
      // Ignore quit failures while shutting down.
    }
    socket.end();
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    socket.destroy();
  };

  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const rawLine = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");

      if (!rawLine) {
        continue;
      }
      if (options.onLine) {
        options.onLine(rawLine);
      }

      const line = parseIrcLine(rawLine);
      if (!line) {
        continue;
      }

      if (line.command === "PING") {
        const payload =
          line.trailing != null ? line.trailing : line.params[0] != null ? line.params[0] : "";
        sendRaw(`PONG :${payload}`);
        continue;
      }

      if (line.command === "NICK") {
        const prefix = parseIrcPrefix(line.prefix);
        if (prefix.nick && normalizeIrcNick(prefix.nick) === normalizeIrcNick(currentNick)) {
          const next =
            line.trailing != null
              ? line.trailing
              : line.params[0] != null
                ? line.params[0]
                : currentNick;
          currentNick = next.trim();
        }
        continue;
      }

      if (!ready && IRC_NICK_COLLISION_CODES.has(line.command)) {
        if (tryRecoverNickCollision()) {
          continue;
        }
        const detail =
          line.trailing != null ? line.trailing : line.params.join(" ") || "nickname in use";
        fail(new Error(`IRC login failed (${line.command}): ${detail}`));
        close();
        return;
      }

      if (!ready && IRC_ERROR_CODES.has(line.command)) {
        const detail =
          line.trailing != null ? line.trailing : line.params.join(" ") || "login rejected";
        fail(new Error(`IRC login failed (${line.command}): ${detail}`));
        close();
        return;
      }

      if (line.command === "001") {
        ready = true;
        const nickParam = line.params[0];
        if (nickParam && nickParam.trim()) {
          currentNick = nickParam.trim();
        }
        try {
          const nickServCommands = buildIrcNickServCommands(options.nickserv);
          for (const command of nickServCommands) {
            sendRaw(command);
          }
        } catch (err) {
          fail(err);
        }
        for (const channel of options.channels || []) {
          const trimmed = channel.trim();
          if (!trimmed) {
            continue;
          }
          try {
            join(trimmed);
          } catch (err) {
            fail(err);
          }
        }
        if (resolveReady) {
          resolveReady();
        }
        resolveReady = null;
        rejectReady = null;
        continue;
      }

      if (line.command === "NOTICE") {
        if (options.onNotice) {
          options.onNotice(line.trailing != null ? line.trailing : "", line.params[0]);
        }
        continue;
      }

      if (line.command === "PRIVMSG") {
        const targetParam = line.params[0];
        const target = targetParam ? targetParam.trim() : "";
        const text = line.trailing != null ? line.trailing : "";
        const prefix = parseIrcPrefix(line.prefix);
        const senderNick = prefix.nick ? prefix.nick.trim() : "";
        if (!target || !senderNick || !text.trim()) {
          continue;
        }
        if (options.onPrivmsg) {
          void Promise.resolve(
            options.onPrivmsg({
              senderNick,
              senderUser: prefix.user ? prefix.user.trim() : undefined,
              senderHost: prefix.host ? prefix.host.trim() : undefined,
              target,
              text,
              rawLine,
            }),
          ).catch((error) => {
            fail(error);
          });
        }
      }
    }
  });

  socket.once("connect", () => {
    try {
      if (options.password && options.password.trim()) {
        sendRaw(`PASS ${options.password.trim()}`);
      }
      sendRaw(`NICK ${options.nick.trim()}`);
      sendRaw(`USER ${options.username.trim()} 0 * :${sanitizeIrcOutboundText(options.realname)}`);
    } catch (err) {
      fail(err);
      close();
    }
  });

  socket.once("error", (err: unknown) => {
    fail(err);
  });

  socket.once("close", () => {
    if (!closed) {
      closed = true;
      if (!ready) {
        fail(new Error("IRC connection closed before ready"));
      }
    }
  });

  if (options.abortSignal) {
    const abort = () => {
      quit("shutdown");
    };
    if (options.abortSignal.aborted) {
      abort();
    } else {
      options.abortSignal.addEventListener("abort", abort, { once: true });
    }
  }

  await withTimeout(readyPromise, timeoutMs, "IRC connect");

  return {
    get nick() {
      return currentNick;
    },
    isReady: () => ready && !closed,
    sendRaw,
    join,
    sendPrivmsg,
    quit,
    close,
  };
}
