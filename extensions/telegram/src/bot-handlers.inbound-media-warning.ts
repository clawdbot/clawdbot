import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";

export function createTelegramPartialAlbumWarning({
  runtime,
  send,
}: {
  runtime?: Pick<RuntimeEnv, "error">;
  send: () => Promise<unknown>;
}): () => Promise<void> {
  let warning: Promise<void> | undefined;
  return () =>
    (warning ??= withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: send,
    }).then(
      () => undefined,
      () => undefined,
    ));
}
