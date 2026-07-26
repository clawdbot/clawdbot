import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOpenClawContinuationTools: vi.fn(() => []),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({ session: { mainKey: "main", scope: "per-sender" } }),
    resolveGatewayPort: () => 18789,
  };
});

vi.mock("../plugins/tools.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/tools.js")>("../plugins/tools.js");
  return {
    ...actual,
    getPluginToolMeta: () => undefined,
  };
});

vi.mock("./openclaw-tools.continuation.js", () => ({
  createOpenClawContinuationTools: mocks.createOpenClawContinuationTools,
}));

import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools continuation option forwarding", () => {
  it("forwards writable sandbox capability to delegate artifact tools", () => {
    createOpenClawTools({
      agentSessionKey: "main",
      disableMessageTool: true,
      disablePluginTools: true,
      sandboxWritable: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
    });

    expect(mocks.createOpenClawContinuationTools).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxWritable: true }),
    );
  });
});
