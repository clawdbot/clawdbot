const WHATSAPP_QA_LIVE_DEFAULT_SCENARIO_IDS = [
  "whatsapp-canary",
  "whatsapp-mention-gating",
  "whatsapp-top-level-reply-shape",
  "whatsapp-reply-to-message",
  "whatsapp-group-reply-to-message",
  "whatsapp-status-reactions",
  "whatsapp-group-allowlist-block",
  "whatsapp-help-command",
] as const;

const WHATSAPP_QA_MOCK_DEFAULT_SCENARIO_IDS = [
  "whatsapp-canary",
  "whatsapp-mention-gating",
  "whatsapp-group-pending-history-context",
  "whatsapp-broadcast-group-fanout",
  "whatsapp-group-activation-always",
  "whatsapp-group-reply-to-bot-triggers",
  "whatsapp-top-level-reply-shape",
  "whatsapp-reply-to-message",
  "whatsapp-group-reply-to-message",
  "whatsapp-reply-to-mode-batched",
  "whatsapp-agent-message-action-react",
  "whatsapp-agent-message-action-upload-file",
  "whatsapp-group-agent-message-action-react",
  "whatsapp-group-agent-message-action-upload-file",
  "whatsapp-inbound-reaction-no-trigger",
  "whatsapp-reply-context-isolation",
  "whatsapp-inbound-image-caption",
  "whatsapp-audio-preflight",
  "whatsapp-outbound-media-matrix",
  "whatsapp-outbound-document-preserves-filename",
  "whatsapp-outbound-poll",
  "whatsapp-group-outbound-media",
  "whatsapp-group-outbound-audio",
  "whatsapp-group-outbound-poll",
  "whatsapp-message-actions",
  "whatsapp-inbound-structured-messages",
  "whatsapp-group-audio-gating",
  "whatsapp-reply-delivery-shape",
  "whatsapp-stream-final-message-accounting",
  "whatsapp-status-reactions",
  "whatsapp-status-reaction-lifecycle",
  "whatsapp-group-allowlist-block",
  "whatsapp-help-command",
  "whatsapp-commands-command",
  "whatsapp-tools-compact-command",
  "whatsapp-whoami-command",
  "whatsapp-context-command",
  "whatsapp-tool-only-usage-footer",
  "whatsapp-native-new-command",
] as const;

export function resolveWhatsAppQaScenarioIds(params: {
  providerMode: string;
  scenarioIds?: readonly string[];
}) {
  if (params.scenarioIds?.length) {
    return [...params.scenarioIds];
  }
  return params.providerMode === "mock-openai"
    ? [...WHATSAPP_QA_MOCK_DEFAULT_SCENARIO_IDS]
    : [...WHATSAPP_QA_LIVE_DEFAULT_SCENARIO_IDS];
}
