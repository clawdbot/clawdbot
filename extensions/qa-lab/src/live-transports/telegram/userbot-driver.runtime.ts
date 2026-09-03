import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type TelegramTextEntity = {
  offset: number;
  length: number;
  type: Record<string, unknown> & { "@type": string };
};

export type TelegramUserbotUpdate = {
  entities: TelegramTextEntity[];
  botApiMessageId?: number;
  chatId: number;
  contentType?: string;
  kind: "edit" | "message";
  messageId: number;
  replyToMessageId?: number;
  senderId: number;
  senderUsername?: string;
  text: string;
  timestamp: number;
};

function isUtf16Boundary(text: string, offset: number) {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function parseTextEntities(value: unknown, text: string): TelegramTextEntity[] {
  if (!Array.isArray(value)) {
    throw new Error("Telegram userbot update has invalid entities.");
  }
  return value.map((entity: unknown) => {
    if (!isRecord(entity)) {
      throw new Error("Telegram userbot update has an invalid entity.");
    }
    const { offset, length, type } = entity;
    // TDLib counts UTF-16 units; accepting a split surrogate would corrupt the observed range.
    if (
      typeof offset !== "number" ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      typeof length !== "number" ||
      !Number.isInteger(length) ||
      length <= 0 ||
      offset + length > text.length ||
      !isUtf16Boundary(text, offset) ||
      !isUtf16Boundary(text, offset + length) ||
      !isRecord(type) ||
      typeof type["@type"] !== "string" ||
      !type["@type"]
    ) {
      throw new Error("Telegram userbot update has an invalid entity.");
    }
    return { offset, length, type: { ...type, "@type": type["@type"] } };
  });
}

function parseUserbotUpdate(value: unknown): TelegramUserbotUpdate {
  if (!isRecord(value)) {
    throw new Error("Telegram userbot emitted an invalid update.");
  }
  const kind = value.kind;
  if (kind !== "message" && kind !== "edit") {
    throw new Error("Telegram userbot emitted an unknown update kind.");
  }
  const { chatId, messageId, senderId, timestamp } = value;
  if (
    typeof chatId !== "number" ||
    typeof messageId !== "number" ||
    typeof senderId !== "number" ||
    typeof timestamp !== "number"
  ) {
    throw new Error("Telegram userbot update has invalid numeric fields.");
  }
  if (typeof value.text !== "string") {
    throw new Error("Telegram userbot update has invalid text.");
  }
  return {
    kind,
    chatId,
    messageId,
    senderId,
    timestamp,
    text: value.text,
    entities: parseTextEntities(value.entities, value.text),
    ...(typeof value.contentType === "string" ? { contentType: value.contentType } : {}),
    ...(typeof value.botApiMessageId === "number"
      ? { botApiMessageId: value.botApiMessageId }
      : {}),
    ...(typeof value.replyToMessageId === "number"
      ? { replyToMessageId: value.replyToMessageId }
      : {}),
    ...(typeof value.senderUsername === "string" ? { senderUsername: value.senderUsername } : {}),
  };
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export class TelegramUserbotDriver {
  private activeChatId: number | undefined;
  private closing = false;
  private commandId = 0;
  private readonly pending = new Map<
    string,
    { reject(error: Error): void; resolve(value: TelegramUserbotUpdate): void }
  >();
  private readyReject: (error: Error) => void = () => undefined;
  private readyResolve: () => void = () => undefined;
  private readonly ready: Promise<void>;
  private stderr = "";
  private terminalError: Error | undefined;
  private updateChain = Promise.resolve();

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onUpdate: (update: TelegramUserbotUpdate) => Promise<void> | void,
    private readonly leaseHealth: {
      assertHealthy(): void;
      whenUnhealthy: Promise<Error>;
    },
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_096);
    });
    child.once("error", (error) => this.fail(error));
    void leaseHealth.whenUnhealthy.then((error) => {
      this.fail(error);
      child.kill("SIGTERM");
    });
    child.once("exit", (code, signal) => {
      if (this.terminalError || this.closing) {
        return;
      }
      const detail = this.stderr.trim();
      this.fail(
        new Error(
          `Telegram userbot exited before cleanup (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  }

  static async start(params: {
    chatId: string;
    driverEnv: Record<string, string>;
    leaseHealth: { assertHealthy(): void; whenUnhealthy: Promise<Error> };
    onUpdate(update: TelegramUserbotUpdate): Promise<void> | void;
    userDriverPath: string;
  }): Promise<TelegramUserbotDriver> {
    params.leaseHealth.assertHealthy();
    const child = spawn("python3", [params.userDriverPath, "serve", "--chat", params.chatId], {
      env: { ...process.env, ...params.driverEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const driver = new TelegramUserbotDriver(
      child,
      (update) => params.onUpdate(update),
      params.leaseHealth,
    );
    const timer = setTimeout(
      () => driver.fail(new Error("Telegram userbot did not become ready within 120000ms.")),
      120_000,
    );
    timer.unref?.();
    try {
      await driver.ready;
      return driver;
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleLine(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch (error) {
      this.fail(new Error(`Telegram userbot emitted invalid JSON: ${formatErrorMessage(error)}`));
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") {
      this.fail(new Error("Telegram userbot emitted an invalid protocol message."));
      return;
    }
    if (message.type === "ready") {
      const chatId = message.chatId;
      if (typeof chatId !== "number" || !Number.isInteger(chatId) || chatId === 0) {
        this.fail(new Error("Telegram userbot emitted an invalid ready chat id."));
        return;
      }
      this.activeChatId = chatId;
      this.readyResolve();
      return;
    }
    if (message.type === "update") {
      try {
        const update = parseUserbotUpdate(message.update);
        this.updateChain = this.updateChain
          .then(async () => await this.onUpdate(update))
          .catch((error: unknown) => this.fail(error));
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") {
      this.fail(new Error("Telegram userbot emitted an unknown protocol message."));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.fail(new Error("Telegram userbot emitted a response for an unknown command."));
      return;
    }
    this.pending.delete(message.id);
    if (typeof message.error === "string") {
      pending.reject(new Error(message.error));
      return;
    }
    if (!isRecord(message.result)) {
      pending.reject(new Error("Telegram userbot emitted an invalid command result."));
      return;
    }
    try {
      pending.resolve(parseUserbotUpdate({ ...message.result, kind: "message" }));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(formatErrorMessage(error)));
    }
  }

  private fail(error: unknown) {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error instanceof Error ? error : new Error(formatErrorMessage(error));
    this.readyReject(this.terminalError);
    for (const pending of this.pending.values()) {
      pending.reject(this.terminalError);
    }
    this.pending.clear();
  }

  assertHealthy() {
    if (this.closing) {
      throw new Error("Telegram userbot is closed.");
    }
    if (this.terminalError) {
      throw this.terminalError;
    }
  }

  get chatId(): number {
    if (this.activeChatId === undefined) {
      throw new Error("Telegram userbot chat id is unavailable before readiness.");
    }
    return this.activeChatId;
  }

  async send(params: { replyToMessageId?: number; text: string }): Promise<TelegramUserbotUpdate> {
    this.leaseHealth.assertHealthy();
    this.assertHealthy();
    this.commandId += 1;
    const id = String(this.commandId);
    const result = new Promise<TelegramUserbotUpdate>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(
      `${JSON.stringify({ id, method: "send", text: params.text, replyToMessageId: params.replyToMessageId })}\n`,
    );
    return await result;
  }

  async close() {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.child.stdin.end();
    if (!(await waitForChildExit(this.child, 5_000))) {
      this.child.kill("SIGTERM");
    }
    if (!(await waitForChildExit(this.child, 2_000))) {
      this.child.kill("SIGKILL");
      await waitForChildExit(this.child, 2_000);
    }
    await this.updateChain;
  }
}
