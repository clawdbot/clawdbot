import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { vi } from "vitest";
import { _resetBlueBubblesInboundDedupForTest } from "../inbound-dedupe.js";
import {
  _resetBlueBubblesShortIdState,
  clearBlueBubblesWebhookSecurityStateForTest,
} from "../monitor.js";
import { setBlueBubblesRuntime } from "../runtime.js";

type BlueBubblesHistoryFetchResult = {
  entries: HistoryEntry[];
  resolved: boolean;
};

export type DispatchReplyParams = Parameters<
  PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
>[0];

export const EMPTY_DISPATCH_RESULT = {
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 0 },
} as const;

type BlueBubblesMonitorTestRuntimeMocks = {
  enqueueSystemEvent: PluginRuntime["system"]["enqueueSystemEvent"];
  chunkMarkdownText: PluginRuntime["channel"]["text"]["chunkMarkdownText"];
  chunkByNewline: PluginRuntime["channel"]["text"]["chunkByNewline"];
  chunkMarkdownTextWithMode: PluginRuntime["channel"]["text"]["chunkMarkdownTextWithMode"];
  chunkTextWithMode: PluginRuntime["channel"]["text"]["chunkTextWithMode"];
  resolveChunkMode: PluginRuntime["channel"]["text"]["resolveChunkMode"];
  hasControlCommand: PluginRuntime["channel"]["text"]["hasControlCommand"];
  dispatchReplyWithBufferedBlockDispatcher: PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"];
  formatAgentEnvelope: PluginRuntime["channel"]["reply"]["formatAgentEnvelope"];
  formatInboundEnvelope: PluginRuntime["channel"]["reply"]["formatInboundEnvelope"];
  resolveEnvelopeFormatOptions: PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"];
  resolveAgentRoute: PluginRuntime["channel"]["routing"]["resolveAgentRoute"];
  buildPairingReply: PluginRuntime["channel"]["pairing"]["buildPairingReply"];
  readAllowFromStore: PluginRuntime["channel"]["pairing"]["readAllowFromStore"];
  upsertPairingRequest: PluginRuntime["channel"]["pairing"]["upsertPairingRequest"];
  saveMediaBuffer: PluginRuntime["channel"]["media"]["saveMediaBuffer"];
  resolveStorePath: PluginRuntime["channel"]["session"]["resolveStorePath"];
  readSessionUpdatedAt: PluginRuntime["channel"]["session"]["readSessionUpdatedAt"];
  buildMentionRegexes: PluginRuntime["channel"]["mentions"]["buildMentionRegexes"];
  matchesMentionPatterns: PluginRuntime["channel"]["mentions"]["matchesMentionPatterns"];
  matchesMentionWithExplicit: PluginRuntime["channel"]["mentions"]["matchesMentionWithExplicit"];
  resolveGroupPolicy: PluginRuntime["channel"]["groups"]["resolveGroupPolicy"];
  resolveRequireMention: PluginRuntime["channel"]["groups"]["resolveRequireMention"];
  resolveCommandAuthorizedFromAuthorizers: PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"];
};

export function createBlueBubblesMonitorTestRuntime(
  mocks: BlueBubblesMonitorTestRuntimeMocks,
): PluginRuntime {
  // Keep this helper small and explicit: BlueBubbles tests should only pay for the
  // runtime slices monitor coverage actually consumes, while still tracking contract drift.
  return createPluginRuntimeMock({
    system: {
      enqueueSystemEvent: mocks.enqueueSystemEvent,
    },
    channel: {
      text: {
        chunkMarkdownText: mocks.chunkMarkdownText,
        chunkByNewline: mocks.chunkByNewline,
        chunkMarkdownTextWithMode: mocks.chunkMarkdownTextWithMode,
        chunkTextWithMode: mocks.chunkTextWithMode,
        resolveChunkMode: mocks.resolveChunkMode,
        hasControlCommand: mocks.hasControlCommand,
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: mocks.dispatchReplyWithBufferedBlockDispatcher,
        formatAgentEnvelope: mocks.formatAgentEnvelope,
        formatInboundEnvelope: mocks.formatInboundEnvelope,
        resolveEnvelopeFormatOptions: mocks.resolveEnvelopeFormatOptions,
      },
      routing: {
        resolveAgentRoute: mocks.resolveAgentRoute,
      },
      pairing: {
        buildPairingReply: mocks.buildPairingReply,
        readAllowFromStore: mocks.readAllowFromStore,
        upsertPairingRequest: mocks.upsertPairingRequest,
      },
      media: {
        saveMediaBuffer: mocks.saveMediaBuffer,
      },
      session: {
        resolveStorePath: mocks.resolveStorePath,
        readSessionUpdatedAt: mocks.readSessionUpdatedAt,
      },
      mentions: {
        buildMentionRegexes: mocks.buildMentionRegexes,
        matchesMentionPatterns: mocks.matchesMentionPatterns,
        matchesMentionWithExplicit: mocks.matchesMentionWithExplicit,
      },
      groups: {
        resolveGroupPolicy: mocks.resolveGroupPolicy,
        resolveRequireMention: mocks.resolveRequireMention,
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: mocks.resolveCommandAuthorizedFromAuthorizers,
      },
    },
  });
}

export function resetBlueBubblesMonitorTestState(params: {
  createRuntime: () => PluginRuntime;
  fetchHistoryMock: { mockResolvedValue: (value: BlueBubblesHistoryFetchResult) => unknown };
  readAllowFromStoreMock: { mockResolvedValue: (value: string[]) => unknown };
  upsertPairingRequestMock: {
    mockResolvedValue: (value: { code: string; created: boolean }) => unknown;
  };
  resolveRequireMentionMock: { mockReturnValue: (value: boolean) => unknown };
  hasControlCommandMock: { mockReturnValue: (value: boolean) => unknown };
  resolveCommandAuthorizedFromAuthorizersMock: { mockReturnValue: (value: boolean) => unknown };
  buildMentionRegexesMock: { mockReturnValue: (value: RegExp[]) => unknown };
  extraReset?: () => void;
}) {
  vi.clearAllMocks();
  _resetBlueBubblesShortIdState();
  _resetBlueBubblesInboundDedupForTest();
  clearBlueBubblesWebhookSecurityStateForTest();
  params.extraReset?.();
  params.fetchHistoryMock.mockResolvedValue({ entries: [], resolved: true });
  params.readAllowFromStoreMock.mockResolvedValue([]);
  params.upsertPairingRequestMock.mockResolvedValue({ code: "TESTCODE", created: true });
  params.resolveRequireMentionMock.mockReturnValue(false);
  params.hasControlCommandMock.mockReturnValue(false);
  params.resolveCommandAuthorizedFromAuthorizersMock.mockReturnValue(false);
  params.buildMentionRegexesMock.mockReturnValue([/\bbert\b/i]);
  setBlueBubblesRuntime(params.createRuntime());
}
