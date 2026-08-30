import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type TelegramUserbotUpdate = {
  botApiMessageId?: number;
  chatId: number;
  kind: "edit" | "message";
  messageId: number;
  replyToMessageId?: number;
  senderId: number;
  senderUsername?: string;
  text: string;
  timestamp: number;
};

function parseUserbotUpdate(value: unknown): TelegramUserbotUpdate {
  if (!isRecord(value)) {
    throw new Error("Telegram userbot emitted an invalid update.");
  }
  const kind = value.kind;
  if (kind !== "message" && kind !== "edit") {
    throw new Error("Telegram userbot emitted an unknown update kind.");
  }
  for (const key of ["chatId", "messageId", "senderId", "timestamp"] as const) {
    if (typeof value[key] !== "number") {
      throw new Error(`Telegram userbot update has invalid ${key}.`);
    }
  }
  if (typeof value.text !== "string") {
    throw new Error("Telegram userbot update has invalid text.");
  }
  return {
    kind,
    chatId: value.chatId,
    messageId: value.messageId,
    senderId: value.senderId,
    timestamp: value.timestamp,
    text: value.text,
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
    onUpdate(update: TelegramUserbotUpdate): Promise<void> | void;
    userDriverPath: string;
  }): Promise<TelegramUserbotDriver> {
    const child = spawn("python3", [params.userDriverPath, "serve", "--chat", params.chatId], {
      env: { ...process.env, ...params.driverEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const driver = new TelegramUserbotDriver(child, params.onUpdate);
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

  async send(params: { replyToMessageId?: number; text: string }): Promise<TelegramUserbotUpdate> {
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
