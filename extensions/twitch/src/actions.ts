/**
 * Twitch message actions adapter.
 *
 * Handles tool-based actions for Twitch, such as sending messages.
 */

import type { ChannelMessageActionAdapter } from "./types.js";

/**
 * Read a string parameter from action arguments.
 *
 * @param args - Action arguments
 * @param key - Parameter key
 * @param options - Options for reading the parameter
 * @returns The parameter value or undefined if not found
 */
function readStringParam(
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean; trim?: boolean } = {},
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (options.required) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    return undefined;
  }

  // Convert value to string safely
  if (typeof value === "string") {
    return options.trim !== false ? value.trim() : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    const str = String(value);
    return options.trim !== false ? str.trim() : str;
  }

  throw new Error(`Parameter ${key} must be a string, number, or boolean`);
}

/** Supported Twitch actions */
const TWITCH_ACTIONS = new Set(["send" as const]);
type TwitchAction = typeof TWITCH_ACTIONS extends Set<infer U> ? U : never;

/**
 * Twitch message actions adapter.
 */
export const twitchMessageActions: ChannelMessageActionAdapter = {
  /**
   * List available actions for this channel.
   */
  describeMessageTool: () => ({ actions: [...TWITCH_ACTIONS] }),

  /**
   * Check if an action is supported.
   */
  supportsAction: ({ action }) => TWITCH_ACTIONS.has(action as TwitchAction),

  /**
   * Extract tool send parameters from action arguments.
   *
   * Parses and validates the "to" and "message" parameters for sending.
   *
   * @param params - Arguments from the tool call
   * @returns Parsed send parameters or null if invalid
   *
   * @example
   * const result = twitchMessageActions.extractToolSend!({
   *   args: { to: "#mychannel", message: "Hello!" }
   * });
   * // Returns: { to: "#mychannel", message: "Hello!" }
   */
  extractToolSend: ({ args }) => {
    try {
      const to = readStringParam(args, "to", { required: true });
      const message = readStringParam(args, "message", { required: true });

      if (!to || !message) {
        return null;
      }

      return { to, message };
    } catch {
      return null;
    }
  },

  // Core owns send execution so receipts, queue settlement, and mirrors agree.
};
