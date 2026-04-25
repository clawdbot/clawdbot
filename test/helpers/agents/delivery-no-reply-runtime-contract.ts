export const DELIVERY_NO_REPLY_RUNTIME_CONTRACT = {
  sessionId: "session-delivery-contract",
  sessionKey: "agent:main:delivery-contract",
  runId: "run-delivery-contract",
  prompt: "deliver the follow-up contract turn",
  originChannel: "discord",
  originTo: "channel:C1",
  dispatcherText: "visible dispatcher fallback",
  visibleText: "visible follow-up",
  silentText: "NO_REPLY",
  jsonSilentText: '{"action":"NO_REPLY"}',
} as const;
