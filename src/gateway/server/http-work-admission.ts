// Gateway HTTP boundary helpers coordinate request and upgrade work with host suspension.
import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { waitForHttpRequestRejection } from "../../infra/http-request-lifecycle.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { rejectWebSocketUpgrade } from "../../shared/websocket-upgrade-reject.js";

type GatewayBoundaryHandler = () => Promise<boolean> | boolean;

async function runWithGatewayBoundaryWorkAdmission(
  origin: string,
  reject: () => void,
  run: GatewayBoundaryHandler,
): Promise<boolean> {
  const admission = tryBeginGatewayRootWorkAdmission(origin);
  if (!admission) {
    reject();
    return true;
  }
  try {
    return await admission.run(async () => await run());
  } finally {
    admission.release();
  }
}

/** Runs one HTTP user-work route under the same root fence as Gateway RPCs. */
export async function runWithGatewayHttpWorkAdmission(
  res: ServerResponse,
  run: GatewayBoundaryHandler,
): Promise<boolean> {
  return await runWithGatewayBoundaryWorkAdmission(
    "http:request",
    () => {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", "1");
      res.end(
        JSON.stringify({
          error: {
            message: "Gateway is temporarily unavailable while suspending or restarting",
            type: "service_unavailable",
            code: "gateway_unavailable",
          },
        }),
      );
    },
    async () => {
      try {
        return await run();
      } finally {
        await waitForHttpRequestRejection(res.req);
      }
    },
  );
}

export function rejectGatewayUpgradeServiceUnavailable(
  socket: Pick<Duplex, "end" | "destroy">,
  body: string,
): void {
  rejectWebSocketUpgrade(socket, {
    status: 503,
    body: { contentType: "text/plain; charset=utf-8", text: body },
  });
}

/** Holds upgrade admission until one plugin handler owns or declines the socket. */
export async function runWithGatewayUpgradeWorkAdmission(
  socket: Duplex,
  run: GatewayBoundaryHandler,
): Promise<boolean> {
  return await runWithGatewayBoundaryWorkAdmission(
    "http:upgrade",
    () => {
      rejectGatewayUpgradeServiceUnavailable(socket, "Gateway websocket admission closed");
    },
    run,
  );
}
