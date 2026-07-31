import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { GatewayClient } from "./types.js";
import { uiCommandHandlers } from "./ui-command.js";

function client(connId: string, id: string, caps: string[] = []): GatewayClient {
  return {
    connId,
    connect: {
      client: { id, version: "test", platform: "web", mode: "ui" },
      caps,
    },
  } as GatewayClient;
}

async function call(params: unknown, clients: GatewayClient[]) {
  const respond = vi.fn();
  const broadcastToConnIds = vi.fn();
  await expectDefined(
    uiCommandHandlers["ui.command"],
    "ui.command",
  )({
    params,
    respond,
    context: {
      broadcastToConnIds,
      getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
        new Set(
          clients
            .filter((entry) => filter?.(entry) !== false)
            .flatMap((entry) => (entry.connId ? [entry.connId] : [])),
        ),
    },
  } as never);
  return { respond, broadcastToConnIds };
}

describe("ui.command gateway method", () => {
  it("rejects invalid params", async () => {
    const result = await call({ command: { kind: "sidebar", visible: "yes" } }, []);

    expect(result.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(result.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("reports when no capable Control UI client is connected", async () => {
    const result = await call({ command: { kind: "sidebar", visible: true } }, [
      client("legacy-ui", GATEWAY_CLIENT_IDS.CONTROL_UI),
      client("capable-cli", GATEWAY_CLIENT_IDS.CLI, [GATEWAY_CLIENT_CAPS.UI_COMMANDS]),
    ]);

    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "no ui client" }),
    );
    expect(result.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("delivers only to capable Control UI connections", async () => {
    const params = {
      command: { kind: "split", direction: "right", sessionKey: "agent:main:other" },
      sessionKey: "agent:main:main",
    };
    const result = await call(params, [
      client("ui-one", GATEWAY_CLIENT_IDS.CONTROL_UI, [GATEWAY_CLIENT_CAPS.UI_COMMANDS]),
      client("legacy-ui", GATEWAY_CLIENT_IDS.CONTROL_UI),
      client("ui-two", GATEWAY_CLIENT_IDS.CONTROL_UI, [GATEWAY_CLIENT_CAPS.UI_COMMANDS]),
      client("cli", GATEWAY_CLIENT_IDS.CLI, [GATEWAY_CLIENT_CAPS.UI_COMMANDS]),
    ]);

    expect(result.broadcastToConnIds).toHaveBeenCalledWith(
      "ui.command",
      params,
      new Set(["ui-one", "ui-two"]),
    );
    expect(result.respond).toHaveBeenCalledWith(true, { ok: true });
  });
});
