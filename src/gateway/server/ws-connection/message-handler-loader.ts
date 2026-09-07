import type { RawData } from "ws";
import { formatError } from "../../server-utils.js";
import {
  classifyGatewayStaleInstall,
  GATEWAY_STALE_INSTALL_CLOSE_REASON,
} from "../../stale-install.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

export function attachGatewayWsMessageHandlerOnDemand(params: GatewayWsMessageHandlerParams): void {
  const queued: RawData[] = [];
  const queueMessage = (data: RawData) => {
    if (queued.length >= 16) {
      params.setCloseCause("message-handler-loading-overflow", { queuedFrames: queued.length });
      params.close(1008, "gateway message handler loading");
      return;
    }
    queued.push(data);
  };
  params.socket.on("message", queueMessage);
  void params.connectionWork
    .track(async () => {
      const { attachGatewayWsMessageHandler } = await import("./message-handler.js");
      params.socket.off("message", queueMessage);
      if (params.isClosed() || params.connectionWork.isClosing) {
        return;
      }
      attachGatewayWsMessageHandler(params);
      for (const data of queued) {
        params.socket.emit("message", data);
      }
    })
    .catch((error: unknown) => {
      params.socket.off("message", queueMessage);
      const formattedError = formatError(error);
      const staleInstall = classifyGatewayStaleInstall(error);
      if (staleInstall) {
        params.setCloseCause("message-handler-load-failed", {
          error: formattedError,
          staleInstall: true,
          restartCommand: staleInstall.restartCommand,
        });
        params.logWsControl.error(
          `failed to load ws message handler because the OpenClaw installation changed while the Gateway was running conn=${params.connId}; run: ${staleInstall.restartCommand}; error: ${formattedError}`,
        );
        params.close(1011, GATEWAY_STALE_INSTALL_CLOSE_REASON);
        return;
      }
      params.setCloseCause("message-handler-load-failed", { error: formattedError });
      params.logWsControl.error(
        `failed to load ws message handler conn=${params.connId}: ${formattedError}`,
      );
      params.close(1011, "gateway message handler unavailable");
    });
}
