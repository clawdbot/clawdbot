import { StaticAuthProvider } from "@twurple/auth";
import { ChatClient } from "@twurple/chat";
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { TwitchAccountConfig } from "./types.js";
import { normalizeToken } from "./utils/twitch.js";

/**
 * Result of probing a Twitch account
 */
export type ProbeTwitchResult = BaseProbeResult<string> & {
  username?: string;
  elapsedMs: number;
  connected?: boolean;
  channel?: string;
};

/**
 * Probe a Twitch account to verify the connection is working
 *
 * This tests the Twitch OAuth token by attempting to connect
 * to the chat server and verify the bot's username.
 */
export async function probeTwitch(
  account: TwitchAccountConfig,
  timeoutMs: number,
): Promise<ProbeTwitchResult> {
  const started = Date.now();

  if (!account.accessToken || !account.username) {
    return {
      ok: false,
      error: "missing credentials (accessToken, username)",
      username: account.username,
      elapsedMs: Date.now() - started,
    };
  }

  const rawToken = normalizeToken(account.accessToken.trim());

  let client: ChatClient | undefined;

  try {
    const authProvider = new StaticAuthProvider(account.clientId ?? "", rawToken);

    client = new ChatClient({
      authProvider,
    });

    // Create a promise that resolves when connected
    const connectionPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let connectListener: ReturnType<ChatClient["onConnect"]> | undefined;
      let disconnectListener: ReturnType<ChatClient["onDisconnect"]> | undefined;
      let authFailListener: ReturnType<ChatClient["onAuthenticationFailure"]> | undefined;

      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        connectListener?.unbind();
        disconnectListener?.unbind();
        authFailListener?.unbind();
      };

      // Success: connection established
      connectListener = client?.onConnect(() => {
        cleanup();
        resolve();
      });

      // Failure: disconnected (e.g., auth failed)
      disconnectListener = client?.onDisconnect((_manually, reason) => {
        cleanup();
        reject(reason || new Error("Disconnected"));
      });

      // Failure: authentication failed
      authFailListener = client?.onAuthenticationFailure(() => {
        cleanup();
        reject(new Error("Authentication failed"));
      });
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    client.connect();
    try {
      await Promise.race([connectionPromise, timeout]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    client.quit();
    client = undefined;

    return {
      ok: true,
      connected: true,
      username: account.username,
      channel: account.channel,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      error: formatErrorMessage(error),
      username: account.username,
      channel: account.channel,
      elapsedMs: Date.now() - started,
    };
  } finally {
    if (client) {
      try {
        client.quit();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
