/** Stable feature names advertised in Gateway hello responses. */
export const GATEWAY_SERVER_CAPS = {
  BOARD_WIDGET_PUT_CANVAS_DOC: "board-widget-put-canvas-doc",
  CHAT_SEND_ROUTING_CONTRACT: "chat-send-routing-contract",
  GATEWAY_RESTART_TARGET_SAFE: "gateway-restart-target-safe-v1",
  NODE_WORKER_BUNDLE_RETENTION: "node-worker-bundle-retention-v1",
  NODE_WORKER_BUNDLE_STATUS: "node-worker-bundle-status-v1",
  NODE_WORKER_ENVIRONMENT_SESSION: "node-worker-environment-session-v1",
  NODE_WORKER_PORTAL_STREAM: "node-worker-portal-stream-v1",
  SESSION_UNREAD_ACK_CONTRACT: "session-unread-ack-contract",
  SYSTEM_AGENT_WIZARD_CANCEL: "openclaw-chat-wizard-cancel",
  SYSTEM_AGENT_SETUP_MODEL_REF: "openclaw-setup-model-ref",
  TASK_SUGGESTIONS_ACCEPT_MODES: "taskSuggestions.acceptModes",
} as const;
