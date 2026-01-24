import { google } from "googleapis";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

export type GoogleChatProbe = {
  ok: boolean;
  error?: string;
};

export async function probeGoogleChat(
  account: ResolvedGoogleChatAccount,
  timeoutMs?: number,
): Promise<GoogleChatProbe> {
  try {
    if (!account.credentialsPath) {
      return { ok: false, error: "No credentials path configured" };
    }

    if (!account.projectId) {
      return { ok: false, error: "No project ID configured" };
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: account.credentialsPath,
      scopes: ["https://www.googleapis.com/auth/chat.bot"],
    });

    const client = google.chat({
      version: "v1",
      auth,
    });

    // Simple probe: try to list spaces (will return empty if bot not added anywhere)
    // This validates credentials and API access
    await Promise.race([
      client.spaces.list({ pageSize: 1 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Probe timeout")), timeoutMs ?? 5000),
      ),
    ]);

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
