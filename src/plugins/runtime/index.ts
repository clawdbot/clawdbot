import { createRequire } from "node:module";

import { chunkMarkdownText, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { buildMentionRegexes, matchesMentionPatterns } from "../../auto-reply/reply/mentions.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../../agents/identity.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { resolveStateDir } from "../../config/paths.js";
import { shouldLogVerbose } from "../../globals.js";
import { getChildLogger } from "../../logging.js";
import { normalizeLogLevel } from "../../logging/levels.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";

import type { PluginRuntime } from "./types.js";

let cachedVersion: string | null = null;

function resolveVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
    return cachedVersion;
  } catch {
    cachedVersion = "unknown";
    return cachedVersion;
  }
}

export function createPluginRuntime(): PluginRuntime {
  return {
    version: resolveVersion(),
    channel: {
      text: {
        chunkMarkdownText,
        resolveTextChunkLimit,
        hasControlCommand,
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
        createReplyDispatcherWithTyping,
        resolveEffectiveMessagesConfig,
        resolveHumanDelayConfig,
      },
      routing: {
        resolveAgentRoute,
      },
      pairing: {
        buildPairingReply,
        readAllowFromStore: readChannelAllowFromStore,
        upsertPairingRequest: upsertChannelPairingRequest,
      },
      media: {
        fetchRemoteMedia,
        saveMediaBuffer,
      },
      mentions: {
        buildMentionRegexes,
        matchesMentionPatterns,
      },
      groups: {
        resolveGroupPolicy: resolveChannelGroupPolicy,
        resolveRequireMention: resolveChannelGroupRequireMention,
      },
      debounce: {
        createInboundDebouncer,
        resolveInboundDebounceMs,
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers,
      },
    },
    logging: {
      shouldLogVerbose,
      getChildLogger: (bindings, opts) => {
        const logger = getChildLogger(bindings, {
          level: opts?.level ? normalizeLogLevel(opts.level) : undefined,
        });
        return {
          debug: (message) => logger.debug?.(message),
          info: (message) => logger.info(message),
          warn: (message) => logger.warn(message),
          error: (message) => logger.error(message),
        };
      },
    },
    state: {
      resolveStateDir,
    },
  };
}

export type { PluginRuntime } from "./types.js";
