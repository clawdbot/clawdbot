import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { createIMessageRpcClient } from "./client.js";
import { extractMarkdownFormatRuns } from "./markdown-format.js";
import { resolveIMessageMessageId as resolveIMessageMessageIdImpl } from "./monitor-reply-cache.js";
import type { IMessageTarget } from "./targets.js";

type CliRunOptions = {
  cliPath: string;
  dbPath?: string;
  timeoutMs?: number;
};

type IMessageBridgeActionOptions = CliRunOptions & {
  chatGuid: string;
};

type IMessageBridgeSendResult = {
  messageId: string;
};

type TempFileInput = {
  buffer: Uint8Array;
  filename: string;
};

type IMessageChatListResponse = {
  chats?: unknown;
};

function asChatList(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const chats = (value as IMessageChatListResponse).chats;
  if (!Array.isArray(chats)) {
    return [];
  }
  return chats.filter(
    (chat): chat is Record<string, unknown> =>
      chat != null && typeof chat === "object" && !Array.isArray(chat),
  );
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// 30s TTL on the chats.list cache, keyed by cliPath+dbPath. Long enough to
// absorb a burst of agent actions; short enough that a freshly-created
// chat shows up without restarting the gateway.
const CHAT_LIST_CACHE_TTL_MS = 30 * 1000;
type ChatListCacheEntry = {
  list: ReadonlyArray<Record<string, unknown>>;
  expiresAt: number;
};
const chatListCache = new Map<string, ChatListCacheEntry>();

function chatListCacheKey(cliPath: string, dbPath?: string): string {
  return `${cliPath}\0${dbPath ?? ""}`;
}

function chatListCacheGet(
  cliPath: string,
  dbPath?: string,
): ReadonlyArray<Record<string, unknown>> | null {
  const entry = chatListCache.get(chatListCacheKey(cliPath, dbPath));
  if (!entry) {
    return null;
  }
  if (entry.expiresAt < Date.now()) {
    chatListCache.delete(chatListCacheKey(cliPath, dbPath));
    return null;
  }
  return entry.list;
}

function chatListCacheSet(
  cliPath: string,
  dbPath: string | undefined,
  list: ReadonlyArray<Record<string, unknown>>,
): void {
  chatListCache.set(chatListCacheKey(cliPath, dbPath), {
    list,
    expiresAt: Date.now() + CHAT_LIST_CACHE_TTL_MS,
  });
}

/**
 * Strip the iMessage;-;/SMS;-;/any;-; service prefix that Messages uses
 * for direct DM chats. Different layers report direct DMs in different
 * forms — the action surface synthesizes `iMessage;-;<phone>` from a
 * handle target, while imsg's chats.list returns `identifier: <phone>`
 * and `guid: any;-;<phone>`. Comparing the raw strings would falsely
 * miss the match. Mirror of the same helper in monitor-reply-cache.ts.
 */
export function _normalizeDirectChatIdentifierForTest(raw: string): string {
  return normalizeDirectChatIdentifier(raw);
}

export function _findChatGuidForTest(
  chats: readonly Record<string, unknown>[],
  target: Extract<IMessageTarget, { kind: "chat_id" | "chat_identifier" }>,
): string | null {
  return findChatGuid(chats, target);
}

function normalizeDirectChatIdentifier(raw: string): string {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  for (const prefix of ["imessage;-;", "sms;-;", "any;-;"]) {
    if (lowered.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}

function findChatGuid(
  chats: readonly Record<string, unknown>[],
  target: Extract<IMessageTarget, { kind: "chat_id" | "chat_identifier" }>,
): string | null {
  if (target.kind === "chat_id") {
    for (const chat of chats) {
      const id = numberFromUnknown(chat.id);
      const guid = stringFromUnknown(chat.guid);
      if (id === target.chatId && guid) {
        return guid;
      }
    }
    return null;
  }
  // target.kind === "chat_identifier"
  const wanted = normalizeDirectChatIdentifier(target.chatIdentifier);
  for (const chat of chats) {
    const identifier = stringFromUnknown(chat.identifier);
    const guid = stringFromUnknown(chat.guid);
    if (!guid) {
      continue;
    }
    if (
      identifier === target.chatIdentifier ||
      guid === target.chatIdentifier ||
      (identifier && normalizeDirectChatIdentifier(identifier) === wanted) ||
      normalizeDirectChatIdentifier(guid) === wanted
    ) {
      return guid;
    }
  }
  return null;
}

function buildIMessageCliJsonArgs(args: readonly string[], options: CliRunOptions): string[] {
  const dbPath = options.dbPath?.trim();
  return [...args, ...(dbPath ? ["--db", dbPath] : []), "--json"];
}

async function runIMessageCliJson(
  args: readonly string[],
  options: CliRunOptions,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.cliPath, buildIMessageCliJsonArgs(args, options), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killEscalation: ReturnType<typeof setTimeout> | null = null;
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
            // If SIGTERM doesn't take within 2s (wedged child, ignored
            // signal handler), escalate to SIGKILL so the process doesn't
            // linger as a zombie.
            killEscalation = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // best-effort
              }
            }, 2000);
            reject(new Error(`iMessage action timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs)
        : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killEscalation) {
        clearTimeout(killEscalation);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killEscalation) {
        clearTimeout(killEscalation);
      }
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const last = lines.at(-1);
      let parsed: Record<string, unknown> | null = null;
      if (last) {
        try {
          const value = JSON.parse(last);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            parsed = value as Record<string, unknown>;
          }
        } catch {
          parsed = null;
        }
      }
      if (code !== 0) {
        const detail =
          (typeof parsed?.error === "string" && parsed.error.trim()) ||
          stderr.trim() ||
          stdout.trim() ||
          `imsg exited with code ${code}`;
        reject(new Error(detail));
        return;
      }
      if (!parsed) {
        reject(new Error(`imsg returned non-JSON output: ${stdout.trim() || stderr.trim()}`));
        return;
      }
      if (parsed.success === false) {
        const error =
          typeof parsed.error === "string" && parsed.error.trim()
            ? parsed.error.trim()
            : "iMessage action failed";
        reject(new Error(error));
        return;
      }
      resolve(parsed);
    });
  });
}

function resolveMessageId(result: Record<string, unknown>): string {
  const raw =
    (typeof result.messageGuid === "string" && result.messageGuid.trim()) ||
    (typeof result.messageId === "string" && result.messageId.trim()) ||
    (typeof result.guid === "string" && result.guid.trim()) ||
    (typeof result.id === "string" && result.id.trim());
  return raw || "ok";
}

async function withTempFile<T>(input: TempFileInput, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(resolvePreferredOpenClawTmpDir(), "openclaw-imessage-"));
  const safeExt = extname(input.filename).slice(0, 16) || ".bin";
  const filePath = join(dir, `upload${safeExt}`);
  try {
    await writeFile(filePath, input.buffer);
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const imessageActionsRuntime = {
  resolveIMessageMessageId: resolveIMessageMessageIdImpl,

  async resolveChatGuidForTarget(params: {
    target: Extract<IMessageTarget, { kind: "chat_id" | "chat_identifier" }>;
    options: CliRunOptions;
  }): Promise<string | null> {
    // Each `chats.list` call spawns a fresh imsg rpc subprocess and pulls
    // every chat the account knows about. Bursts of agent actions (react
    // then reply, reply then add-participant, etc.) all paid that cost
    // until we cached the chats list per cliPath+dbPath for ~30 seconds.
    const cached = chatListCacheGet(params.options.cliPath, params.options.dbPath);
    if (cached) {
      return findChatGuid(cached, params.target);
    }
    const client = await createIMessageRpcClient({
      cliPath: params.options.cliPath,
      dbPath: params.options.dbPath,
    });
    try {
      const result = await client.request<IMessageChatListResponse>(
        "chats.list",
        { limit: 1000 },
        { timeoutMs: params.options.timeoutMs },
      );
      const list = asChatList(result);
      chatListCacheSet(params.options.cliPath, params.options.dbPath, list);
      return findChatGuid(list, params.target);
    } finally {
      await client.stop();
    }
  },

  async sendReaction(params: {
    chatGuid: string;
    messageId: string;
    reaction: string;
    remove?: boolean;
    partIndex?: number;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      [
        "tapback",
        "--chat",
        params.chatGuid,
        "--message",
        params.messageId,
        "--kind",
        params.reaction,
        "--part",
        String(params.partIndex ?? 0),
        ...(params.remove ? ["--remove"] : []),
      ],
      params.options,
    );
  },

  async editMessage(params: {
    chatGuid: string;
    messageId: string;
    text: string;
    backwardsCompatMessage?: string;
    partIndex?: number;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      [
        "edit",
        "--chat",
        params.chatGuid,
        "--message",
        params.messageId,
        "--new-text",
        params.text,
        "--bc-text",
        params.backwardsCompatMessage ?? params.text,
        "--part",
        String(params.partIndex ?? 0),
      ],
      params.options,
    );
  },

  async unsendMessage(params: {
    chatGuid: string;
    messageId: string;
    partIndex?: number;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      [
        "unsend",
        "--chat",
        params.chatGuid,
        "--message",
        params.messageId,
        "--part",
        String(params.partIndex ?? 0),
      ],
      params.options,
    );
  },

  async sendRichMessage(params: {
    chatGuid: string;
    text: string;
    effectId?: string;
    replyToMessageId?: string;
    partIndex?: number;
    // Optional attachment as an in-memory buffer that we stage to a temp
    // file before invoking imsg. The buffer must already have been loaded
    // by the outbound media resolver (mediaLocalRoots/sandbox/size limits)
    // — this runtime intentionally does not accept a raw filesystem path,
    // because that would let an attacker-controlled path bypass the
    // resolver and let imsg send any host-readable file. Requires an imsg
    // build that accepts `send-rich --file` (openclaw/imsg#114); callers
    // must feature-detect via the cached private-api status first.
    attachment?: { kind: "buffer"; buffer: Uint8Array; filename: string };
    options: IMessageBridgeActionOptions;
  }): Promise<IMessageBridgeSendResult> {
    // Extract markdown bold/italic/underline/strikethrough into typed-run
    // ranges so the recipient sees actual styling rather than literal
    // asterisks. This mirrors the same extraction the rpc-send path does;
    // any caller that hits the bridge via `imsg send-rich` benefits without
    // needing to pre-format the text themselves.
    const formatted = extractMarkdownFormatRuns(params.text);
    const buildArgs = (filePath?: string): string[] => [
      "send-rich",
      "--chat",
      params.chatGuid,
      "--text",
      formatted.text,
      "--part",
      String(params.partIndex ?? 0),
      ...(params.effectId ? ["--effect", params.effectId] : []),
      ...(params.replyToMessageId ? ["--reply-to", params.replyToMessageId] : []),
      ...(formatted.ranges.length > 0 ? ["--format", JSON.stringify(formatted.ranges)] : []),
      ...(filePath ? ["--file", filePath] : []),
    ];

    if (params.attachment) {
      return await withTempFile(
        { buffer: params.attachment.buffer, filename: params.attachment.filename },
        async (filePath) => {
          const result = await runIMessageCliJson(buildArgs(filePath), params.options);
          return { messageId: resolveMessageId(result) };
        },
      );
    }

    const result = await runIMessageCliJson(buildArgs(), params.options);
    return { messageId: resolveMessageId(result) };
  },

  async renameGroup(params: {
    chatGuid: string;
    displayName: string;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      ["chat-name", "--chat", params.chatGuid, "--name", params.displayName],
      params.options,
    );
  },

  async setGroupIcon(params: {
    chatGuid: string;
    buffer: Uint8Array;
    filename: string;
    options: IMessageBridgeActionOptions;
  }) {
    await withTempFile({ buffer: params.buffer, filename: params.filename }, async (filePath) => {
      await runIMessageCliJson(
        ["chat-photo", "--chat", params.chatGuid, "--file", filePath],
        params.options,
      );
    });
  },

  async addParticipant(params: {
    chatGuid: string;
    address: string;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      ["chat-add-member", "--chat", params.chatGuid, "--address", params.address],
      params.options,
    );
  },

  async removeParticipant(params: {
    chatGuid: string;
    address: string;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      ["chat-remove-member", "--chat", params.chatGuid, "--address", params.address],
      params.options,
    );
  },

  async leaveGroup(params: { chatGuid: string; options: IMessageBridgeActionOptions }) {
    await runIMessageCliJson(["chat-leave", "--chat", params.chatGuid], params.options);
  },

  async sendAttachment(params: {
    chatGuid: string;
    buffer: Uint8Array;
    filename: string;
    asVoice?: boolean;
    options: IMessageBridgeActionOptions;
  }): Promise<IMessageBridgeSendResult> {
    return await withTempFile(
      { buffer: params.buffer, filename: params.filename },
      async (filePath) => {
        const result = await runIMessageCliJson(
          [
            "send-attachment",
            "--chat",
            params.chatGuid,
            "--file",
            filePath,
            ...(params.asVoice ? ["--audio"] : []),
          ],
          params.options,
        );
        return { messageId: resolveMessageId(result) };
      },
    );
  },
};

export type IMessageActionsRuntime = typeof imessageActionsRuntime;
