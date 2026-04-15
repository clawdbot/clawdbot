import { describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import { mapFailoverReasonToProbeStatus } from "./list.probe.js";

describe("mapFailoverReasonToProbeStatus", () => {
  it("does not import the embedded runner on module load", async () => {
    vi.doMock("../../agents/pi-embedded.js", () => {
      throw new Error("pi-embedded should stay lazy for probe imports");
    });
    try {
      await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
    } finally {
      vi.doUnmock("../../agents/pi-embedded.js");
    }
  });

  it("maps auth_permanent to auth", () => {
    expect(mapFailoverReasonToProbeStatus("auth_permanent")).toBe("auth");
  });

  it("keeps existing failover reason mappings", () => {
    expect(mapFailoverReasonToProbeStatus("auth")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("rate_limit")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("overloaded")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("billing")).toBe("billing");
    expect(mapFailoverReasonToProbeStatus("timeout")).toBe("timeout");
    expect(mapFailoverReasonToProbeStatus("model_not_found")).toBe("format");
    expect(mapFailoverReasonToProbeStatus("format")).toBe("format");
  });

  it("falls back to unknown for unrecognized values", () => {
    expect(mapFailoverReasonToProbeStatus(undefined)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus(null)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus("something_else")).toBe("unknown");
  });
});
