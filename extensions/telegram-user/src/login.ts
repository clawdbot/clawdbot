import qrcode from "qrcode-terminal";
import type { RuntimeEnv } from "clawdbot/plugin-sdk";

import { createTelegramUserClient } from "./client.js";
import { ensureTelegramUserSessionDir } from "./session.js";

export async function loginTelegramUser(params: {
  apiId: number;
  apiHash: string;
  storagePath: string;
  runtime: RuntimeEnv;
}) {
  const { apiId, apiHash, storagePath, runtime } = params;
  ensureTelegramUserSessionDir({ sessionPath: storagePath });
  const client = createTelegramUserClient({ apiId, apiHash, storagePath });
  let lastUrl = "";

  const password = process.env.TELEGRAM_USER_PASSWORD?.trim() || undefined;

  try {
    const user = await client.start({
      qrCodeHandler: (url, expires) => {
        if (url === lastUrl) return;
        lastUrl = url;
        runtime.log(`Scan this QR in Telegram (expires ${expires.toLocaleTimeString()}):`);
        qrcode.generate(url, { small: true });
      },
      ...(password ? { password } : {}),
      invalidCodeCallback: async (type) => {
        if (type === "password") {
          runtime.error?.(
            "Telegram 2FA password rejected. Set TELEGRAM_USER_PASSWORD and rerun.",
          );
        }
      },
    });
    runtime.log(`Telegram user logged in as ${user.displayName}.`);
  } finally {
    await client.destroy();
  }
}
