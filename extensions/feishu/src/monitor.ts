import * as lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import { createFeishuClient, sendFeishuMessage } from "./client.js";
import type { FeishuAccount, FeishuMessageEvent } from "./types.js";
import { getFeishuRuntime } from "./runtime.js";

export type FeishuRuntimeEnv = {
    log?: (message: string) => void;
    error?: (message: string) => void;
};

export async function startFeishuMonitor(params: {
    account: FeishuAccount;
    config: ClawdbotConfig;
    runtime: FeishuRuntimeEnv;
    statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}) {
    const { account, config, runtime, statusSink } = params;

    // Feishu WS Client
    const client = new lark.WSClient({
        appId: account.config.appId || "",
        appSecret: account.config.appSecret || "",
        loggerLevel: 2, // Info
        logger: {
            // Adaptation for Logger
            debug: () => { },
            info: (msg) => runtime.log?.(`[feishu-sdk] ${msg}`),
            warn: (msg) => runtime.log?.(`[feishu-sdk] WARN: ${msg}`),
            error: (msg) => runtime.error?.(`[feishu-sdk] ERROR: ${msg}`),
        }
    });

    // Event Dispatcher
    const eventDispatcher = new lark.EventDispatcher({
        encryptKey: account.config.encryptKey || "",
        verificationToken: account.config.verificationToken || "",
    })

    eventDispatcher.register({
        "im.message.receive_v1": async (data) => {
            try {
                // Feishu SDK EventDispatcher unpacks the payload. 
                // 'data' IS the event object (containing message, sender, etc.)
                const event = data as FeishuMessageEvent;
                const message = event.message;
                const sender = event.sender;

                if (!message || !sender) {
                    runtime.log?.(`[feishu] Received incomplete message event`);
                    return;
                }

                const chatId = message.chat_id;
                const messageId = message.message_id;
                const senderId = sender.sender_id.user_id || sender.sender_id.open_id || sender.sender_id.union_id;

                runtime.log?.(`[feishu] Received message ${messageId} from ${chatId}`);

                let text = "";
                let rawBody = "";

                // Handle message type compatibility (SDK vs API raw)
                const msgType = message.message_type || (message as any).msg_type;

                if (msgType === "text") {
                    try {
                        const content = JSON.parse(message.content);
                        text = content.text;
                        rawBody = content.text;
                    } catch {
                        text = "[Invalid JSON Content]";
                        rawBody = message.content;
                    }
                } else {
                    rawBody = `[${msgType}]`;
                    text = rawBody;
                }

                const core = getFeishuRuntime();
                if (!core) {
                    runtime.error?.("[feishu] Core runtime not available during message processing");
                    return;
                }

                const fromLabel = `feishu:${senderId}`;

                const ctxPayload = core.channel.reply.finalizeInboundContext({
                    Body: text,
                    RawBody: rawBody,
                    CommandBody: text,
                    From: fromLabel,
                    To: `feishu:${chatId}`,
                    SessionKey: `feishu:${chatId}`,
                    AccountId: account.accountId,
                    ChatType: message.chat_type === "group" ? "channel" : "direct",
                    ConversationLabel: message.chat_type === "group" ? `Group ${chatId}` : `User ${senderId}`,
                    SenderId: senderId,
                    SenderName: "FeishuUser",
                    Provider: "feishu",
                    Surface: "feishu",
                    MessageSid: messageId,
                    MessageSidFull: messageId,
                    OriginatingChannel: "feishu",
                    OriginatingTo: `feishu:${chatId}`,
                });

                await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
                    ctx: ctxPayload,
                    cfg: config,
                    dispatcherOptions: {
                        deliver: async (payload) => {
                            if (payload.text) {
                                await sendFeishuMessage({
                                    account,
                                    receiveId: chatId,
                                    msgType: "text",
                                    content: JSON.stringify({ text: payload.text }),
                                });
                            }
                        },
                        onError: (err) => {
                            runtime.error?.(`[feishu] Reply failed: ${err}`);
                        }
                    }
                });

                statusSink?.({ lastInboundAt: Date.now() });

            } catch (err) {
                runtime.error?.(`[feishu] Process message failed: ${err}`);
            }
        },
        "im.message.message_read_v1": async (data) => {
            // Optional: Handle read receipts or just log for debug
            // runtime.log?.(`[feishu] Message read event received: ${JSON.stringify(data)}`);
        }
    });

    try {
        await client.start({ eventDispatcher });
        runtime.log?.(`[feishu] WebSocket client started for account ${account.accountId}`);
        return {
            stop: async () => {
                try {
                    // WSClient may have close/stop method - attempt graceful shutdown
                    if (typeof (client as any).close === "function") {
                        await (client as any).close();
                    } else if (typeof (client as any).stop === "function") {
                        await (client as any).stop();
                    }
                    runtime.log?.(`[feishu] WebSocket client stopped for account ${account.accountId}`);
                } catch (err) {
                    runtime.error?.(`[feishu] Error stopping WebSocket client: ${err}`);
                }
            }
        };
    } catch (err) {
        runtime.error?.(`[feishu] Failed to start WebSocket client: ${err}`);
        throw err;
    }
}
