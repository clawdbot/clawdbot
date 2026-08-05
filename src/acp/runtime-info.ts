/** Machine-readable contract used by ACP hosts before launching OpenClaw. */
export const ACP_RUNTIME_INFO = {
  schemaVersion: 1,
  protocol: "acp",
  transport: "stdio",
  execution: "in-process",
  gatewayRequired: false,
} as const;
