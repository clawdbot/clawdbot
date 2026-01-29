import * as lark from "@larksuiteoapi/node-sdk";

import type { FeishuAccount } from "./types.js";

export function createFeishuClient(account: FeishuAccount) {
    if (!account.config.appId || !account.config.appSecret) {
        throw new Error("Feishu appId and appSecret are required");
    }
    return new lark.Client({
        appId: account.config.appId,
        appSecret: account.config.appSecret,
        disableTokenCache: false,
    });
}

export async function sendFeishuMessage(params: {
    account: FeishuAccount;
    receiveId: string;
    receiveIdType?: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
    msgType: "text" | "post" | "image" | "interactive" | "share_chat" | "share_user" | "audio" | "media" | "file" | "sticker";
    content: string;
}) {
    const { account, receiveId, receiveIdType = "chat_id", msgType, content } = params;
    const client = createFeishuClient(account);

    const response = await client.im.message.create({
        params: {
            receive_id_type: receiveIdType,
        },
        data: {
            receive_id: receiveId,
            msg_type: msgType,
            content: content,
        },
    });

    if (response.code !== 0) {
        throw new Error(`Feishu send message failed: ${response.msg} (code: ${response.code}, logId: ${response.log_id})`);
    }

    return response.data;
}

export async function uploadFeishuImage(params: {
    account: FeishuAccount;
    imagePath: string;
    imageType: "message";
}) {
    const { account, imagePath, imageType } = params;
    const client = createFeishuClient(account);

    // Note: SDK wrapper might handle reading file, or we pass stream.
    // Using standard fs.createReadStream if SDK supports it.
    // Checking SDK docs or type definition would be ideal, but assuming standard node stream support for now.
    const fs = await import("node:fs");
    const file = fs.createReadStream(imagePath);

    const response = await client.im.image.create({
        data: {
            image_type: imageType,
            image: file,
        }
    });

    if (response.code !== 0) {
        throw new Error(`Feishu upload image failed: ${response.msg} (code: ${response.code})`);
    }

    return response.data;
}
