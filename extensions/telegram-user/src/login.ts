import qrcode from "qrcode-terminal";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isCancel, select } from "@clack/prompts";
import type { RuntimeEnv } from "clawdbot/plugin-sdk";

import { createTelegramUserClient } from "./client.js";
import { ensureTelegramUserSessionDir } from "./session.js";

async function promptText(message: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question(message);
    return value.trim();
  } finally {
    rl.close();
  }
}

async function promptLoginMode(): Promise<"qr" | "phone"> {
  if (!input.isTTY || !output.isTTY) return "qr";
  const response = await select({
    message: "Telegram login method",
    options: [
      { value: "qr", label: "QR code (scan with Telegram)" },
      { value: "phone", label: "Phone code (SMS/Telegram)" },
    ],
    initialValue: "qr",
  });
  if (isCancel(response)) return "qr";
  return response;
}

export async function loginTelegramUser(params: {
  apiId: number;
  apiHash: string;
  storagePath: string;
  runtime: RuntimeEnv;
}) {
  const { apiId, apiHash, storagePath, runtime } = params;
  ensureTelegramUserSessionDir({ sessionPath: storagePath });
  const client = await createTelegramUserClient({ apiId, apiHash, storagePath });
  let lastUrl = "";

  const passwordEnv = process.env.TELEGRAM_USER_PASSWORD?.trim() || undefined;
  let phoneEnv = process.env.TELEGRAM_USER_PHONE?.trim() || undefined;
  const codeEnv = process.env.TELEGRAM_USER_CODE?.trim() || undefined;

  try {
    if (!phoneEnv) {
      const mode = await promptLoginMode();
      if (mode === "phone") {
        phoneEnv = await promptText("Telegram phone number (E.164): ");
      }
    }
    const user = await client.start(
      phoneEnv
        ? {
            phone: phoneEnv,
            code: codeEnv ? codeEnv : async () => await promptText("Telegram code: "),
            password: passwordEnv ? passwordEnv : async () => await promptText("2FA password: "),
            codeSentCallback: (code) => {
              runtime.log(
                `Telegram code sent via ${code.type}. Check your device and enter it here.`,
              );
            },
            invalidCodeCallback: async (type) => {
              if (type === "password" && passwordEnv) {
                runtime.error?.(
                  "Telegram 2FA password rejected. Update TELEGRAM_USER_PASSWORD and rerun.",
                );
              }
              if (type === "code" && codeEnv) {
                runtime.error?.(
                  "Telegram code rejected. Update TELEGRAM_USER_CODE and rerun.",
                );
              }
            },
          }
        : {
            qrCodeHandler: (url, expires) => {
              if (url === lastUrl) return;
              lastUrl = url;
              runtime.log(`Scan this QR in Telegram (expires ${expires.toLocaleTimeString()}):`);
              qrcode.generate(url, { small: true });
            },
            ...(passwordEnv ? { password: passwordEnv } : {}),
            invalidCodeCallback: async (type) => {
              if (type === "password") {
                runtime.error?.(
                  "Telegram 2FA password rejected. Set TELEGRAM_USER_PASSWORD and rerun.",
                );
              }
            },
          },
    );
    runtime.log(`Telegram user logged in as ${user.displayName}.`);
  } finally {
    await client.destroy();
  }
}
