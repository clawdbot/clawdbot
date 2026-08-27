import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ImapAccountConfig } from "./config.js";
import { renderImapPrompt } from "./prompt.js";
import { evaluateImapSender, type MailAuthenticator } from "./sender-gate.js";
import {
  advanceImapCursor,
  countImapSkip,
  initializeImapCursor,
  recordImapAttempt,
  rememberImapMessage,
  type ImapWatcherState,
} from "./state.js";

const MAX_SOURCE_BYTES = 1_048_576;
const MAX_ATTEMPTS = 3;
const MAX_RECONNECT_DELAY_MS = 60_000;

type ImapWatcherOptions = {
  accountId: string;
  account: ImapAccountConfig;
  runtime: OpenClawPluginApi["runtime"];
  state: ImapWatcherState;
  context: OpenClawPluginServiceContext;
  authenticator?: MailAuthenticator;
  reconnectBaseMs?: number;
};

function senderDomain(sender: string | undefined): string {
  return sender?.split("@").at(-1)?.toLowerCase() ?? "unknown";
}

function messageDate(message: FetchMessageObject): Date {
  const date = message.internalDate;
  return date instanceof Date ? date : typeof date === "string" ? new Date(date) : new Date();
}

export class ImapAccountWatcher {
  private client: ImapFlow | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private activeSweep: Promise<void> | undefined;
  private activeConnection: Promise<void> | undefined;
  private stopping = false;
  private failures = 0;
  private authFailures = 0;
  private reconnectPending = false;
  private sweepPending = false;

  constructor(private readonly options: ImapWatcherOptions) {}

  start(): void {
    if (this.options.account.allowedSenders.length === 0) {
      this.options.context.logger.warn(
        `imap: account=${this.options.accountId} disabled; configure allowedSenders before watching`,
      );
      return;
    }
    this.startConnection();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const client = this.client;
    this.client = undefined;
    client?.close();
    await Promise.allSettled([this.activeConnection, this.activeSweep]);
  }

  private startConnection(): void {
    if (this.stopping || this.activeConnection) {
      return;
    }
    const pending = this.connect().catch((error: unknown) => this.handleConnectionFailure(error));
    this.activeConnection = pending.finally(() => {
      this.activeConnection = undefined;
      if (this.reconnectPending && !this.stopping) {
        this.scheduleReconnect();
      }
    });
  }

  private async connect(): Promise<void> {
    // Finish the previous connection's admission before reinitializing its cursor.
    await this.activeSweep;
    if (this.stopping) {
      return;
    }
    const { account } = this.options;
    const client = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: { user: account.user, pass: account.password },
      logger: false,
      maxIdleTime: 4 * 60_000,
      socketTimeout: 3 * 60_000,
      missingIdleCommand: "NOOP",
      maxLiteralSize: MAX_SOURCE_BYTES + 8_192,
      maxResponseSize: MAX_SOURCE_BYTES + 32_768,
    });
    this.client = client;
    client.on("error", (error: Error) => {
      if (!this.stopping && this.client === client) {
        this.options.context.logger.warn(
          `imap: account=${this.options.accountId} connection error=${formatErrorMessage(error)}`,
        );
      }
    });
    client.once("close", () => {
      if (!this.stopping && this.client === client) {
        this.client = undefined;
        this.scheduleReconnect();
      }
    });
    await client.connect();
    if (this.stopping || this.client !== client) {
      client.close();
      return;
    }
    const mailbox = await client.mailboxOpen(account.mailbox, { readOnly: true });
    const initialized = await initializeImapCursor(
      this.options.state,
      this.options.accountId,
      mailbox.uidValidity.toString(),
      mailbox.uidNext,
    );
    if (this.stopping || this.client !== client) {
      return;
    }
    if (initialized.kind !== "resume") {
      this.options.context.logger.info(
        `imap: account=${this.options.accountId} cursor=${initialized.kind} uidValidity=${initialized.cursor.uidValidity} uid=${initialized.cursor.lastSeenUid}`,
      );
    }
    const supportsIdle = client.capabilities.has("IDLE");
    const push = account.watch.mode !== "interval" && supportsIdle;
    if (account.watch.mode === "idle" && !supportsIdle) {
      this.options.context.logger.warn(
        `imap: account=${this.options.accountId} server has no IDLE capability; using polling`,
      );
    }
    this.authFailures = 0;
    this.failures = 0;
    this.options.context.serviceHealth?.clearFailure();
    this.options.context.logger.info(
      `imap: account=${this.options.accountId} mode=${push ? "push" : "poll"} mailbox=${account.mailbox}`,
    );
    if (push) {
      client.on("exists", () => {
        this.requestSweep();
      });
    }
    // IDLE reports mailbox changes, not retry readiness. Reconcile on the same
    // cadence in both modes so a quiet inbox cannot strand a rejected admission.
    this.pollTimer = setInterval(() => this.requestSweep(), account.watch.pollSeconds * 1_000);
    this.pollTimer.unref();
    // Reconnect always sweeps persisted state, closing the notification gap during disconnect.
    if (initialized.kind === "resume") {
      this.requestSweep();
    }
  }

  private handleConnectionFailure(error: unknown): void {
    if (this.stopping) {
      return;
    }
    const authenticationFailed =
      typeof error === "object" &&
      error !== null &&
      "authenticationFailed" in error &&
      error.authenticationFailed === true;
    if (authenticationFailed && ++this.authFailures >= MAX_ATTEMPTS) {
      const message = `imap: account=${this.options.accountId} needs reauthentication after ${MAX_ATTEMPTS} authentication failures; update its password and reload configuration`;
      this.options.context.logger.error(message);
      this.options.context.serviceHealth?.reportFailure(new Error(message));
      this.client?.close();
      this.client = undefined;
      return;
    }
    this.options.context.serviceHealth?.reportFailure(error);
    this.options.context.logger.warn(
      `imap: account=${this.options.accountId} connection failed=${formatErrorMessage(error)}`,
    );
    this.client?.close();
    this.client = undefined;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer || this.authFailures >= MAX_ATTEMPTS) {
      return;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.activeConnection) {
      this.reconnectPending = true;
      return;
    }
    this.reconnectPending = false;
    const base = this.options.reconnectBaseMs ?? 1_000;
    const delay = Math.min(base * 2 ** this.failures++, MAX_RECONNECT_DELAY_MS);
    const jitter = Math.floor(Math.random() * Math.max(1, delay / 4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.startConnection();
    }, delay + jitter);
    this.reconnectTimer.unref();
  }

  private requestSweep(): void {
    const client = this.client;
    if (this.stopping || !client) {
      return;
    }
    if (this.activeSweep) {
      // A wakeup during an active sweep must queue a follow-up sweep: the running
      // sweep snapshotted its UID range, so dropping the wakeup would strand the
      // new message until the next unrelated event or reconnect.
      this.sweepPending = true;
      return;
    }
    this.activeSweep = this.sweep(client)
      .catch((error: unknown) => {
        if (!this.stopping) {
          this.options.context.logger.warn(
            `imap: account=${this.options.accountId} sweep failed=${formatErrorMessage(error)}`,
          );
        }
      })
      .finally(() => {
        this.activeSweep = undefined;
        if (this.sweepPending && !this.stopping) {
          this.sweepPending = false;
          this.requestSweep();
        }
      });
  }

  private async sweep(client: ImapFlow): Promise<void> {
    const cursor = await this.options.state.cursors.lookup(this.options.accountId);
    if (!cursor || this.stopping || this.client !== client) {
      return;
    }
    const messages: FetchMessageObject[] = [];
    for await (const message of client.fetch(
      `${cursor.lastSeenUid + 1}:*`,
      { uid: true, internalDate: true, size: true, source: { maxLength: MAX_SOURCE_BYTES } },
      { uid: true },
    )) {
      // IMAP N:* returns the mailbox's final message even when its UID is below N.
      if (message.uid > cursor.lastSeenUid) {
        messages.push(message);
      }
    }
    for (const message of messages.toSorted((left, right) => left.uid - right.uid)) {
      if (
        this.stopping ||
        this.client !== client ||
        !(await this.processMessage(message, cursor.uidValidity))
      ) {
        break;
      }
      await advanceImapCursor(
        this.options.state,
        this.options.accountId,
        cursor.uidValidity,
        message.uid,
      );
    }
    this.options.context.logger.debug?.(
      `imap: account=${this.options.accountId} lastSweep=${new Date().toISOString()} messages=${messages.length}`,
    );
  }

  private async processMessage(message: FetchMessageObject, uidValidity: string): Promise<boolean> {
    const { accountId, account, state } = this.options;
    const key = `${accountId}:${uidValidity}:${message.uid}`;
    if (!message.source) {
      await this.recordSkip(message.uid, undefined, "message-source-missing");
      return true;
    }
    const mail = await simpleParser(message.source, { skipImageLinks: true });
    const verdict = await evaluateImapSender({
      mail,
      raw: message.source,
      internalDate: messageDate(message),
      account,
      ...(this.options.authenticator ? { authenticator: this.options.authenticator } : {}),
    });
    if (!verdict.accepted) {
      if (
        verdict.transient &&
        (await recordImapAttempt(state, key, verdict.reason)) < MAX_ATTEMPTS
      ) {
        this.options.context.logger.warn(
          `imap: account=${accountId} uid=${message.uid} domain=${senderDomain(verdict.sender)} gate=${verdict.reason} retry=true`,
        );
        return false;
      }
      await state.claims.registerIfAbsent(key, {
        accountId,
        uid: message.uid,
        recordedAt: Date.now(),
      });
      await this.recordSkip(message.uid, verdict.sender, verdict.reason);
      return true;
    }
    const messageRing = mail.messageId ? await state.messageIds.lookup(accountId) : undefined;
    if (mail.messageId && messageRing?.messageIds.includes(mail.messageId)) {
      await this.recordSkip(message.uid, verdict.sender, "duplicate-message-id");
      return true;
    }
    if (
      !(await state.claims.registerIfAbsent(key, {
        accountId,
        uid: message.uid,
        recordedAt: Date.now(),
      }))
    ) {
      await this.recordSkip(message.uid, verdict.sender, "duplicate-uid");
      return true;
    }
    const sessionKey = `hook:imap:${key}`;
    let result: Awaited<
      ReturnType<ImapWatcherOptions["runtime"]["hooks"]["dispatchHookAgentTurn"]>
    >;
    try {
      result = await this.options.runtime.hooks.dispatchHookAgentTurn({
        name: `IMAP ${accountId}`,
        agentId: account.agentId,
        sessionKey,
        message: renderImapPrompt(mail, account, (message.size ?? 0) > MAX_SOURCE_BYTES),
        externalContentSource: "email",
        deliver: account.deliver,
        idempotencyKey: sessionKey,
        ...(account.model ? { model: account.model } : {}),
        ...(account.thinking ? { thinking: account.thinking } : {}),
        ...(account.timeoutSeconds ? { timeoutSeconds: account.timeoutSeconds } : {}),
      });
    } catch (error) {
      // Gateway preflight can throw before admission. Release its claim through
      // the same bounded retry path; post-admission failures are reported separately.
      result = { ok: false, reason: formatErrorMessage(error) };
    }
    if (result.ok) {
      if (mail.messageId) {
        await rememberImapMessage(state, accountId, mail.messageId);
      }
      this.options.context.logger.info(
        `imap: account=${accountId} uid=${message.uid} domain=${senderDomain(verdict.sender)} strength=${verdict.strength} run=${result.runId}`,
      );
      return true;
    }
    await state.claims.delete(key);
    if ((await recordImapAttempt(state, key, "dispatch-rejected")) < MAX_ATTEMPTS) {
      this.options.context.logger.warn(
        `imap: account=${accountId} uid=${message.uid} dispatch rejected=${result.reason}`,
      );
      return false;
    }
    await state.claims.registerIfAbsent(key, {
      accountId,
      uid: message.uid,
      recordedAt: Date.now(),
    });
    await this.recordSkip(message.uid, verdict.sender, "dispatch-rejected");
    return true;
  }

  private async recordSkip(uid: number, sender: string | undefined, reason: string): Promise<void> {
    await countImapSkip(this.options.state, this.options.accountId, reason);
    this.options.context.logger.warn(
      `imap: account=${this.options.accountId} uid=${uid} domain=${senderDomain(sender)} gate=${reason}`,
    );
  }
}
