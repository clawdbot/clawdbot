import { expect, it, vi } from "vitest";
import { buildDynamicTools } from "./dynamic-tool-build.js";

it("does not invoke host tool authority before a tool-capable turn", async () => {
  const agentHarnessCodingToolsFactory = vi.fn(async () => []);

  await expect(
    buildDynamicTools({
      agentHarnessCodingToolsFactory,
      attributionAttempt: {} as never,
      params: { disableTools: true } as never,
    } as never),
  ).resolves.toEqual([]);
  expect(agentHarnessCodingToolsFactory).not.toHaveBeenCalled();

  await expect(
    buildDynamicTools({
      agentHarnessCodingToolsFactory,
      attributionAttempt: {} as never,
      params: {
        disableTools: false,
        model: { compat: { supportsTools: false } },
      } as never,
    } as never),
  ).resolves.toEqual([]);
  expect(agentHarnessCodingToolsFactory).not.toHaveBeenCalled();
});
