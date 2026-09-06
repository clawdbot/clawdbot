/** Private, one-shot updater handoff. The parent must hold live authority. */
import { randomUUID } from "node:crypto";
import type { GatewayServiceStagedFiles } from "../../daemon/service-stage.js";

export async function waitForGatewayServiceLoad(staged: GatewayServiceStagedFiles): Promise<void> {
  if (!process.send || !process.connected) {
    throw new Error("Deferred service load requires the updater IPC channel.");
  }
  const id = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onDisconnect = () => finish(new Error("Updater disconnected before service load."));
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object" || !("id" in message) || message.id !== id) {
        finish(new Error("Invalid updater service-load response."));
        return;
      }
      if ("type" in message && message.type === "openclaw-service-load") {
        finish();
      } else {
        finish(new Error("Updater did not seal the service after-image."));
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Updater service-load handoff timed out.")),
      60_000,
    );
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.send!({ type: "openclaw-service-staged", id, staged }, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}
