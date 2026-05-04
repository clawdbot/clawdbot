import type { HookHandler } from "../../hooks.js";

function readOptionalNumber(context: Record<string, unknown>, key: string): number | undefined {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const handler: HookHandler = async (event) => {
  try {
    const context = event.context;

    if (event.type === "session" && event.action === "compact:before") {
      const messageCount = readOptionalNumber(context, "messageCount");
      const messageSuffix =
        messageCount !== undefined && messageCount >= 0 ? ` (${messageCount} messages)` : "";
      event.messages.push(
        `🧹 Compacting context${messageSuffix} so I can continue without losing history…`,
      );
      return;
    }

    if (event.type === "session" && event.action === "compact:after") {
      const tokensBefore = readOptionalNumber(context, "tokensBefore");
      const tokensAfter = readOptionalNumber(context, "tokensAfter");
      const tokenDelta =
        tokensBefore !== undefined && tokensAfter !== undefined
          ? ` (${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens)`
          : "";
      event.messages.push(`✅ Context compacted${tokenDelta}. Continuing from where I left off.`);
    }
  } catch (error) {
    console.warn(
      `[compaction-notifier] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export default handler;
