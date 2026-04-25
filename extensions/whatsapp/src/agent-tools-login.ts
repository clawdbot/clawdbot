import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-contract";
import { Type } from "typebox";
import { startWebLoginWithQr, waitForWebLogin } from "../login-qr-api.js";

const QR_DATA_URL_MAX_LENGTH = 16_384;

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function createWhatsAppLoginTool(): ChannelAgentTool {
  return {
    label: "WhatsApp Login",
    name: "whatsapp_login",
    ownerOnly: true,
    description: "Generate a WhatsApp QR code for linking, or wait for the scan to complete.",
    // NOTE: Using Type.Unsafe for action enum instead of Type.Union([Type.Literal(...)]
    // because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
    parameters: Type.Object({
      action: Type.Unsafe<"start" | "wait">({
        type: "string",
        enum: ["start", "wait"],
      }),
      timeoutMs: Type.Optional(Type.Number()),
      force: Type.Optional(Type.Boolean()),
      accountId: Type.Optional(Type.String()),
      currentQrDataUrl: Type.Optional(
        Type.String({
          maxLength: QR_DATA_URL_MAX_LENGTH,
          pattern: "^data:image/png;base64,",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const renderQrReply = (params: {
        message: string;
        qrDataUrl: string;
        connected?: boolean;
      }) => {
        const text = [
          params.message,
          "",
          "Open WhatsApp → Linked Devices and scan:",
          "",
          `![whatsapp-qr](${params.qrDataUrl})`,
        ].join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: {
            connected: params.connected ?? false,
            qr: true,
          },
        };
      };

      const action = (args as { action?: string })?.action ?? "start";
      const accountId = readOptionalString((args as { accountId?: unknown }).accountId);
      if (action === "wait") {
        const result = await waitForWebLogin({
          accountId,
          timeoutMs:
            typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
              ? (args as { timeoutMs?: number }).timeoutMs
              : undefined,
          currentQrDataUrl: readOptionalString(
            (args as { currentQrDataUrl?: unknown }).currentQrDataUrl,
          ),
        });
        if (result.qrDataUrl) {
          return renderQrReply({
            message: result.message,
            qrDataUrl: result.qrDataUrl,
            connected: result.connected,
          });
        }
        return {
          content: [{ type: "text", text: result.message }],
          details: { connected: result.connected },
        };
      }

      const result = await startWebLoginWithQr({
        accountId,
        timeoutMs:
          typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (args as { timeoutMs?: number }).timeoutMs
            : undefined,
        force:
          typeof (args as { force?: unknown }).force === "boolean"
            ? (args as { force?: boolean }).force
            : false,
      });

      if (!result.qrDataUrl) {
        return {
          content: [
            {
              type: "text",
              text: result.message,
            },
          ],
          details: { qr: false },
        };
      }

      return renderQrReply({
        message: result.message,
        qrDataUrl: result.qrDataUrl,
        connected: result.connected,
      });
    },
  };
}
