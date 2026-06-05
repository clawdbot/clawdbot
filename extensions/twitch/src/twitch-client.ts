// Twitch plugin module implements twitch client behavior.
import { RefreshingAuthProvider, StaticAuthProvider } from "@twurple/auth";
import { ChatClient, LogLevel } from "@twurple/chat";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTwitchToken } from "./token.js";
import type { ChannelLogSink, TwitchAccountConfig, TwitchChatMessage } from "./types.js";
import { normalizeToken } from "./utils/twitch.js";

const TWITCH_CHAT_AUTH_INTENTS = ["chat"];

/**
 * Manages Twitch chat client connections
 */
export class TwitchClientManager {
  private clients = new Map<string, ChatClient>();
  private pendingClients = new Map<string, ChatClient>();
  private connectionPromises = new Map<string, Promise<ChatClient>>();
  private messageHandlers = new Map<string, (message: TwitchChatMessage) => void>();
  private messageHandlerTokens = new Map<string, symbol>();

  constructor(private logger: ChannelLogSink) {}

  /**
   * Create an auth provider for the account.
   */
  private async createAuthProvider(
    account: TwitchAccountConfig,
    normalizedToken: string,
  ): Promise<StaticAuthProvider | RefreshingAuthProvider> {
    if (!account.clientId) {
      throw new Error("Missing Twitch client ID");
    }

    if (account.clientSecret) {
      const authProvider = new RefreshingAuthProvider({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
      });

      try {
        const userId = await authProvider.addUserForToken(
          {
            accessToken: normalizedToken,
            refreshToken: account.refreshToken ?? null,
            expiresIn: account.expiresIn ?? null,
            obtainmentTimestamp: account.obtainmentTimestamp ?? Date.now(),
          },
          TWITCH_CHAT_AUTH_INTENTS,
        );
        this.logger.info(`Added user ${userId} to RefreshingAuthProvider for ${account.username}`);
      } catch (err) {
        throw new Error(
          `Failed to add user to RefreshingAuthProvider: ${formatErrorMessage(err)}`,
          {
            cause: err,
          },
        );
      }

      authProvider.onRefresh((userId, token) => {
        this.logger.info(
          `Access token refreshed for user ${userId} (expires in ${token.expiresIn ? `${token.expiresIn}s` : "unknown"})`,
        );
      });

      authProvider.onRefreshFailure((userId, error) => {
        this.logger.error(`Failed to refresh access token for user ${userId}: ${error.message}`);
      });

      const refreshStatus = account.refreshToken
        ? "automatic token refresh enabled"
        : "token refresh disabled (no refresh token)";
      this.logger.info(`Using RefreshingAuthProvider for ${account.username} (${refreshStatus})`);

      return authProvider;
    }

    this.logger.info(`Using StaticAuthProvider for ${account.username} (no clientSecret provided)`);
    return new StaticAuthProvider(account.clientId, normalizedToken);
  }

  /**
   * Get or create a chat client for an account
   */
  async getClient(
    account: TwitchAccountConfig,
    cfg?: OpenClawConfig,
    accountId?: string,
  ): Promise<ChatClient> {
    const key = this.getAccountKey(account);

    const existing = this.clients.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.connectionPromises.get(key);
    if (pending) {
      return pending;
    }

    const connection = this.createConnectedClient(key, account, cfg, accountId);
    this.connectionPromises.set(key, connection);
    try {
      return await connection;
    } finally {
      if (this.connectionPromises.get(key) === connection) {
        this.connectionPromises.delete(key);
      }
    }
  }

  private async createConnectedClient(
    key: string,
    account: TwitchAccountConfig,
    cfg?: OpenClawConfig,
    accountId?: string,
  ): Promise<ChatClient> {
    const tokenResolution = resolveTwitchToken(cfg, {
      accountId,
    });

    if (!tokenResolution.token) {
      this.logger.error(
        `Missing Twitch token for account ${account.username} (set channels.twitch.accounts.${account.username}.token or OPENCLAW_TWITCH_ACCESS_TOKEN for default)`,
      );
      throw new Error("Missing Twitch token");
    }

    this.logger.debug?.(`Using ${tokenResolution.source} token source for ${account.username}`);

    if (!account.clientId) {
      this.logger.error(`Missing Twitch client ID for account ${account.username}`);
      throw new Error("Missing Twitch client ID");
    }

    const normalizedToken = normalizeToken(tokenResolution.token);

    const authProvider = await this.createAuthProvider(account, normalizedToken);

    const client = new ChatClient({
      authProvider,
      channels: [account.channel],
      rejoinChannelsOnReconnect: true,
      requestMembershipEvents: true,
      logger: {
        minLevel: LogLevel.WARNING,
        custom: {
          log: (level, message) => {
            switch (level) {
              case LogLevel.CRITICAL:
                this.logger.error(message);
                break;
              case LogLevel.ERROR:
                this.logger.error(message);
                break;
              case LogLevel.WARNING:
                this.logger.warn(message);
                break;
              case LogLevel.INFO:
                this.logger.info(message);
                break;
              case LogLevel.DEBUG:
                this.logger.debug?.(message);
                break;
              case LogLevel.TRACE:
                this.logger.debug?.(message);
                break;
            }
          },
        },
      },
    });

    this.setupClientHandlers(client, account);

    this.pendingClients.set(key, client);
    try {
      await this.connectClient(client, account);
      if (this.pendingClients.get(key) !== client) {
        client.quit();
        throw new Error(`Twitch connection cancelled for ${account.username}`);
      }
      this.pendingClients.delete(key);
    } catch (error) {
      if (this.pendingClients.get(key) === client) {
        this.pendingClients.delete(key);
      }
      throw error;
    }

    this.clients.set(key, client);
    this.logger.info(`Connected to Twitch as ${account.username}`);

    return client;
  }

  private async connectClient(client: ChatClient, account: TwitchAccountConfig): Promise<void> {
    const connectTimeoutMs = 15000;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let authRetryPending = false;
      const listeners: Array<{ unbind: () => void }> = [];
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        for (const listener of listeners) {
          listener.unbind();
        }
        if (error) {
          try {
            client.quit();
          } catch {
            // Best effort: connection setup already failed.
          }
          reject(error);
          return;
        }
        resolve();
      };
      listeners.push(
        client.onAuthenticationSuccess(() => finish()),
        client.onAuthenticationFailure((text) => {
          authRetryPending = true;
          this.logger.warn(
            `Twitch authentication failed for ${account.username}; waiting for retry, disconnect, or timeout: ${text}`,
          );
        }),
        client.onDisconnect((manual, reason) => {
          if (authRetryPending && !manual) {
            this.logger.debug?.(
              `Twitch disconnected during auth retry for ${account.username}: ${formatErrorMessage(reason)}`,
            );
            return;
          }
          finish(
            reason ??
              new Error(
                manual
                  ? `Twitch connection cancelled for ${account.username}`
                  : `Twitch disconnected before ready for ${account.username}`,
              ),
          );
        }),
      );
      const timeout: NodeJS.Timeout | undefined = setTimeout(
        () => finish(new Error(`Timed out connecting to Twitch as ${account.username}`)),
        connectTimeoutMs,
      );
      timeout.unref?.();
      try {
        client.connect();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Set up message and event handlers for a client
   */
  private setupClientHandlers(client: ChatClient, account: TwitchAccountConfig): void {
    const key = this.getAccountKey(account);

    // Handle incoming messages
    client.onMessage((channelName, _user, messageText, msg) => {
      const handler = this.messageHandlers.get(key);
      if (handler) {
        const normalizedChannel = channelName.startsWith("#") ? channelName.slice(1) : channelName;
        const from = `twitch:${msg.userInfo.userName}`;
        const preview = messageText.slice(0, 100).replace(/\n/g, "\\n");
        this.logger.debug?.(
          `twitch inbound: channel=${normalizedChannel} from=${from} len=${messageText.length} preview="${preview}"`,
        );

        handler({
          username: msg.userInfo.userName,
          displayName: msg.userInfo.displayName,
          userId: msg.userInfo.userId,
          message: messageText,
          channel: normalizedChannel,
          id: msg.id,
          timestamp: new Date(),
          isMod: msg.userInfo.isMod,
          isOwner: msg.userInfo.isBroadcaster,
          isVip: msg.userInfo.isVip,
          isSub: msg.userInfo.isSubscriber,
          chatType: "group",
        });
      }
    });

    this.logger.info(`Set up handlers for ${key}`);
  }

  /**
   * Set a message handler for an account
   * @returns A function that removes the handler when called
   */
  onMessage(
    account: TwitchAccountConfig,
    handler: (message: TwitchChatMessage) => void,
  ): () => void {
    const key = this.getAccountKey(account);
    const token = Symbol(key);
    this.messageHandlers.set(key, handler);
    this.messageHandlerTokens.set(key, token);
    return () => {
      // Only remove the exact registration this cleanup closure owns. A later
      // onMessage() may reuse the same callback function for the same account.
      if (this.messageHandlerTokens.get(key) === token) {
        this.messageHandlers.delete(key);
        this.messageHandlerTokens.delete(key);
      }
    };
  }

  private clearMessageHandler(key: string): void {
    this.messageHandlers.delete(key);
    this.messageHandlerTokens.delete(key);
  }

  /**
   * Disconnect a client
   */
  async disconnect(account: TwitchAccountConfig): Promise<void> {
    const key = this.getAccountKey(account);
    const client = this.clients.get(key);
    const pendingClient = this.pendingClients.get(key);

    if (pendingClient) {
      pendingClient.quit();
      this.pendingClients.delete(key);
      this.connectionPromises.delete(key);
      this.clearMessageHandler(key);
    }

    if (client) {
      client.quit();
      this.clients.delete(key);
      this.clearMessageHandler(key);
      this.logger.info(`Disconnected ${key}`);
    }
  }

  /**
   * Disconnect all clients
   */
  async disconnectAll(): Promise<void> {
    this.pendingClients.forEach((client) => client.quit());
    this.clients.forEach((client) => client.quit());
    this.pendingClients.clear();
    this.connectionPromises.clear();
    this.clients.clear();
    this.messageHandlers.clear();
    this.messageHandlerTokens.clear();
    this.logger.info(" Disconnected all clients");
  }

  /**
   * Send a message to a channel
   */
  async sendMessage(
    account: TwitchAccountConfig,
    channel: string,
    message: string,
    cfg?: OpenClawConfig,
    accountId?: string,
  ): Promise<{ ok: boolean; error?: string; messageId?: string }> {
    try {
      const client = await this.getClient(account, cfg, accountId);

      // Generate a message ID (Twurple's say() doesn't return the message ID, so we generate one)
      const messageId = crypto.randomUUID();

      // Send message (Twurple handles rate limiting)
      await client.say(channel, message);

      return { ok: true, messageId };
    } catch (error) {
      this.logger.error(`Failed to send message: ${formatErrorMessage(error)}`);
      return {
        ok: false,
        error: formatErrorMessage(error),
      };
    }
  }

  /**
   * Generate a unique key for an account
   */
  public getAccountKey(account: TwitchAccountConfig): string {
    return `${account.username}:${account.channel}`;
  }

  /**
   * Clear all clients and handlers (for testing)
   */
  clearForTest(): void {
    this.clients.clear();
    this.pendingClients.clear();
    this.connectionPromises.clear();
    this.messageHandlers.clear();
  }
}
