import { callGateway } from "../../gateway/call.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../utils/message-channel.js";
import { withProgress } from "../progress.js";

export async function probeGatewayStatus(opts: {
  url: string;
  token?: string;
  password?: string;
  timeoutMs: number;
  json?: boolean;
  configPath?: string;
}) {
  try {
    await withProgress(
      {
        label: "Checking gateway status...",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway({
          url: opts.url,
          token: opts.token,
          password: opts.password,
          method: "status",
          timeoutMs: opts.timeoutMs,
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          ...(opts.configPath ? { configPath: opts.configPath } : {}),
        }),
    );
    return { ok: true } as const;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } as const;
  }
}
