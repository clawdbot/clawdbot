import { describe, expect, it, vi } from "vitest";
import { emitModelTransportDebug } from "./model-transport-debug.js";

describe("emitModelTransportDebug", () => {
  it("does not treat code-mode diagnostics as model transport diagnostics", () => {
    const log = { info: vi.fn(), debug: vi.fn() };
    vi.stubEnv("OPENCLAW_DEBUG_CODE_MODE", "1");

    emitModelTransportDebug(log, "transport request started");

    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("transport request started");
    vi.unstubAllEnvs();
  });
});
