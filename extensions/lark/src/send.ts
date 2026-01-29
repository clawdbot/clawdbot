import type { ChannelOutbound, ClawdbotConfig } from "clawdbot/plugin-sdk";
import { getTenantAccessToken, resolveLarkCredentials } from "./token.js";
import type { LarkConfig } from "./types.js";

type LarkApiResponse = {
  code: number;
  msg: string;
  data?: {
    message_id?: string;
  };
};

function detectReceiveIdType(to: string): string {
  if (to.startsWith("oc_")) return "chat_id";
  if (to.startsWith("ou_")) return "open_id";
  if (to.startsWith("on_")) return "union_id";
  if (to.includes("@")) return "email";
  return "open_id";
}

export const larkOutbound: ChannelOutbound = {
  sendText: async ({ cfg, to, text }) => {
    const larkCfg = (cfg as ClawdbotConfig).channels?.lark as LarkConfig | undefined;
    const creds = resolveLarkCredentials(larkCfg);
    if (!creds) {
      throw new Error("Lark credentials not configured (appId and appSecret required)");
    }

    if (!to?.trim()) {
      throw new Error("Lark target (to) is required");
    }

    const token = await getTenantAccessToken(creds);
    const receiveIdType = detectReceiveIdType(to);
    const url = `${creds.baseUrl.replace(/\/$/, "")}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: to,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Lark API error: ${res.status} ${body}`);
    }

    const data: unknown = await res.json();
    if (!data || typeof data !== "object") {
      throw new Error("Lark API returned invalid response");
    }

    const response = data as LarkApiResponse;
    if (response.code !== 0) {
      throw new Error(`Lark send error (code ${response.code}): ${response.msg}`);
    }

    return {
      id: response.data?.message_id ?? "",
      ts: Date.now(),
    };
  },
};
