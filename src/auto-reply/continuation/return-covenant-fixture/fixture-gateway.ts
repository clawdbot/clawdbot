import { resolveGatewayPort } from "../../../config/paths.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { startGatewayServer } from "../../../gateway/server.js";
import { readReturnCovenantJsonFile } from "./control-file.js";
import { prepareReturnCovenantGatewayConfig } from "./gateway-config.js";

export async function runReturnCovenantFixtureGateway(): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!configPath || !token) {
    throw new Error("return-covenant fixture gateway requires config and token authority");
  }
  const rawConfig = await readReturnCovenantJsonFile(configPath);
  const config = prepareReturnCovenantGatewayConfig(rawConfig);
  setRuntimeConfigSnapshot(config, config);
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let requestStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const handleSignal = () => requestStop?.();
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  try {
    server = await startGatewayServer(resolveGatewayPort(config, process.env), {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      sidecarStartup: "defer",
    });
    await server.startupSettled;
    await stopped;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    await server?.close({ reason: "return-covenant fixture cleanup" });
    resetConfigRuntimeState();
  }
}
