import { detectBinary } from "../commands/onboard-helpers.js";
import { loadConfig } from "../config/config.js";
import { createIMessageRpcClient } from "./client.js";

export type IMessageProbe = {
  ok: boolean;
  error?: string | null;
};

export async function probeIMessage(timeoutMs = 2000): Promise<IMessageProbe> {
  const cfg = loadConfig();
  const cliPath = cfg.channels?.imessage?.cliPath?.trim() || "imsg";
  const dbPath = cfg.channels?.imessage?.dbPath?.trim();
  const detected = await detectBinary(cliPath);
  if (!detected) {
    return { ok: false, error: `imsg not found (${cliPath})` };
  }

  const client = await createIMessageRpcClient({
    cliPath,
    dbPath,
  });
  try {
    await client.request("chats.list", { limit: 1 }, { timeoutMs });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    await client.stop();
  }
}
