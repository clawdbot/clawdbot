// Server runtime-state test helper builds minimal gateway runtime state with a
// configurable plugin registry.
import { randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { createGatewayHttpTransport } from "./server-runtime-state.js";

/**
 * Runtime-state fixture factory for gateway server tests.
 */
type GatewayRuntimeStateParams = Omit<Parameters<typeof createGatewayHttpTransport>[0], "clients">;

/** Creates a minimal gateway runtime state with optional plugin registry fixture. */
export async function createGatewayRuntimeStateForTest(
  pluginRegistry: GatewayRuntimeStateParams["pluginRegistry"] = createEmptyPluginRegistry(),
  overrides: Partial<GatewayRuntimeStateParams> = {},
) {
  const params = {
    cfg: {},
    bindHost: "127.0.0.1",
    port: 0,
    controlUiEnabled: false,
    controlUiBasePath: "/",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    resolvedAuth: {} as never,
    getResolvedAuth: () => ({}) as never,
    isTerminalEnabled: () => false,
    hooksConfig: () => null,
    getHookClientIpConfig: () => ({}) as never,
    pluginRegistry,
    deps: {} as never,
    log: { info: () => {}, warn: () => {} },
    logHooks: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    logPlugins: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    ...overrides,
  };
  const connectionState = createGatewayConnectionState({ ...params, bootId: randomUUID() });
  onTestFinished(() => connectionState.mentionInbox.dispose());
  const httpTransport = await createGatewayHttpTransport({
    ...params,
    clients: connectionState.clients,
  });
  return { ...httpTransport, ...connectionState };
}
