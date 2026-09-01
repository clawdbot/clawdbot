import { randomUUID } from "node:crypto";
import { resolveGatewayPort } from "../../../config/paths.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { withGatewayServerExtraHandlers } from "../../../gateway/server-extra-handlers.js";
import { startGatewayServer } from "../../../gateway/server.js";
import { readReturnCovenantJsonFile } from "./control-file.js";
import { createReturnCovenantGatewayConfigSnapshot } from "./gateway-config.js";
import {
  readReturnCovenantProcessStartFingerprint,
  RETURN_COVENANT_GATEWAY_READY_PREFIX,
  type ReturnCovenantGatewayBinding,
} from "./gateway-generation.js";
import { createReturnCovenantGatewayService } from "./gateway-rpc.js";

export async function runReturnCovenantFixtureGateway(): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!configPath || !token) {
    throw new Error("return-covenant fixture gateway requires config and token authority");
  }
  const rawConfig = await readReturnCovenantJsonFile(configPath);
  const { config, snapshot } = createReturnCovenantGatewayConfigSnapshot({
    path: configPath,
    raw: rawConfig,
  });
  setRuntimeConfigSnapshot(config, config);
  const port = resolveGatewayPort(config, process.env);
  const binding: ReturnCovenantGatewayBinding = {
    bootId: randomUUID(),
    endpoint: `http://127.0.0.1:${port}`,
    pid: process.pid,
    startFingerprint: await readReturnCovenantProcessStartFingerprint(process.pid),
  };
  const service = createReturnCovenantGatewayService({
    binding,
    config,
    env: process.env,
  });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let requestStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const handleSignal = () => {
    service.beginClose();
    requestStop?.();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  try {
    server = await startGatewayServer(
      port,
      withGatewayServerExtraHandlers(
        {
          bind: "loopback",
          bootId: binding.bootId,
          auth: { mode: "token", token },
          controlUiEnabled: false,
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          sidecarStartup: "defer",
          startupConfigSnapshotRead: { snapshot },
        },
        service.handlers,
      ),
    );
    await server.startupSettled;
    process.stdout.write(`${RETURN_COVENANT_GATEWAY_READY_PREFIX}${JSON.stringify(binding)}\n`);
    await stopped;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    await service.close();
    await server?.close({ reason: "return-covenant fixture cleanup" });
    resetConfigRuntimeState();
  }
}
