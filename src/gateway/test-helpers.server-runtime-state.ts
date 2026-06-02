import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";

type GatewayRuntimeStateParams = Parameters<typeof createGatewayRuntimeState>[0];

export async function createGatewayRuntimeStateForTest(
  pluginRegistry: GatewayRuntimeStateParams["pluginRegistry"] = createEmptyPluginRegistry(),
) {
  return await createGatewayRuntimeState({
    cfg: {},
    bindHost: "127.0.0.1",
    port: 0,
    controlUiEnabled: false,
    controlUiBasePath: "/",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    resolvedAuth: {} as never,
    getResolvedAuth: () => ({}) as never,
    hooksConfig: () => null,
    getHookClientIpConfig: () => ({}) as never,
    pluginRegistry,
    deps: {} as never,
    log: { info: () => {}, warn: () => {} },
    logHooks: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    logPlugins: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
  });
}
