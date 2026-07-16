import type { SignalEventHandlerDeps, SignalReactionMessage } from "./event-handler.types.js";

export function createBaseSignalEventHandlerDeps(
  overrides: Partial<SignalEventHandlerDeps> = {},
): SignalEventHandlerDeps {
  return {
    runtime: { log: () => {}, error: () => {} } as any,
    cfg: {},
    baseUrl: "http://localhost",
    accountId: "default",
    historyLimit: 5,
    groupHistories: new Map(),
    textLimit: 4000,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupAllowFrom: ["*"],
    groupPolicy: "open",
    reactionMode: "off",
    reactionAllowlist: [],
    mediaMaxBytes: 1024,
    ignoreAttachments: true,
    sendReadReceipts: false,
    readReceiptsViaDaemon: false,
    fetchAttachment: async () => null,
    deliverReplies: async () => {},
    resolveSignalReactionTargets: () => [],
    isSignalReactionMessage: (
      _reaction: SignalReactionMessage | null | undefined,
    ): _reaction is SignalReactionMessage => false,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: () => "reaction",
    ...overrides,
  };
}

export function createSignalReceiveEvent(envelopeOverrides: Record<string, unknown> = {}) {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Alice",
        timestamp: 1700000000000,
        ...envelopeOverrides,
      },
    }),
  };
}
