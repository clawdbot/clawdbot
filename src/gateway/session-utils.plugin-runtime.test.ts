import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";

const normalizeProviderModelIdWithPluginMock = vi.fn();
const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  configFingerprint: "gateway-session-utils-plugin-runtime-test-empty-plugin-metadata",
  plugins: [],
}));

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithPluginMock(params),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

describe("gateway session list plugin runtime normalization", () => {
  beforeEach(() => {
    vi.resetModules();
    normalizeProviderModelIdWithPluginMock.mockReset();
  });

  it("skips provider runtime normalization for lightweight list rows", async () => {
    const { listSessionsFromStoreAsync } = await import("./session-utils.js");
    const cfg = {
      agents: {
        defaults: { model: { primary: "custom-provider/custom-legacy-model" } },
      },
    } as OpenClawConfig;
    const store = Object.fromEntries(
      Array.from({ length: 3 }, (_value, index) => [
        `session-${index}`,
        { sessionId: `session-${index}`, updatedAt: 1_000 - index } satisfies SessionEntry,
      ]),
    );

    const listed = await listSessionsFromStoreAsync({
      cfg,
      storePath: "",
      store,
      opts: {},
    });

    expect(listed.sessions.map((session) => session.model)).toEqual([
      "custom-legacy-model",
      "custom-legacy-model",
      "custom-legacy-model",
    ]);
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it("keeps provider runtime normalization for detail rows", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(
      ({ provider, context }: { provider?: string; context?: { modelId?: string } }) => {
        if (provider === "custom-provider" && context?.modelId === "custom-legacy-model") {
          return "custom-modern-model";
        }
        return undefined;
      },
    );

    const { buildGatewaySessionRow } = await import("./session-utils.js");
    const cfg = {
      agents: {
        defaults: { model: { primary: "custom-provider/custom-legacy-model" } },
      },
    } as OpenClawConfig;

    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "main",
    });

    expect(row.model).toBe("custom-modern-model");
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalled();
  });
});
