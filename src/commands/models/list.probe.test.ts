import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";

let probeModule: typeof import("./list.probe.js");

describe("mapFailoverReasonToProbeStatus", () => {
  beforeAll(async () => {
    vi.doMock("../../agents/pi-embedded.js", () => {
      throw new Error("pi-embedded should stay lazy for probe imports");
    });
    try {
      probeModule = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
    } finally {
      vi.doUnmock("../../agents/pi-embedded.js");
    }
  });

  it("does not import the embedded runner on module load", () => {
    expect(probeModule.mapFailoverReasonToProbeStatus).toBeTypeOf("function");
  });

  it("maps failover reasons to probe statuses", () => {
    const { mapFailoverReasonToProbeStatus } = probeModule;
    expect(mapFailoverReasonToProbeStatus("auth_permanent")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("auth")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("rate_limit")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("overloaded")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("billing")).toBe("billing");
    expect(mapFailoverReasonToProbeStatus("timeout")).toBe("timeout");
    expect(mapFailoverReasonToProbeStatus("model_not_found")).toBe("format");
    expect(mapFailoverReasonToProbeStatus("format")).toBe("format");

    expect(mapFailoverReasonToProbeStatus(undefined)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus(null)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus("something_else")).toBe("unknown");
  });
});
