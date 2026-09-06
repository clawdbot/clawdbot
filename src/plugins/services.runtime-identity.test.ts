import { expect, it } from "vitest";
import { getGatewayProcessInstanceId } from "../gateway/process-instance.js";
import { resolveRuntimeServiceBuildId } from "../version.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { startPluginServices } from "./services.js";
import type { OpenClawPluginServiceContext } from "./types.js";

it("shares the canonical runtime identity only while the exporter lease is active", async () => {
  const contexts: OpenClawPluginServiceContext[] = [];
  const registry = createEmptyPluginRegistry();
  registry.services.push({
    pluginId: "diagnostics-prometheus",
    origin: "bundled",
    source: "test",
    service: {
      id: "diagnostics-prometheus",
      start: (ctx) => {
        contexts.push(ctx);
      },
    },
  });
  const handle = await startPluginServices({ registry, config: {} });
  const readIdentity = contexts[0]?.internalDiagnostics?.getRuntimeIdentity;
  try {
    const buildId = resolveRuntimeServiceBuildId();
    expect(readIdentity?.()).toEqual({
      processInstanceId: getGatewayProcessInstanceId(),
      ...(buildId ? { buildId } : {}),
    });
  } finally {
    await handle.stop();
  }
  expect(() => readIdentity?.()).toThrow("no longer active");
});
