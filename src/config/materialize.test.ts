// Verifies snapshot/load materialization parity for prepared-runtime config matching.
import { describe, expect, it } from "vitest";
import { materializeRuntimeConfig } from "./materialize.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("materializeRuntimeConfig", () => {
  it("materializes snapshot and load identically when defaults must be injected", () => {
    // A compaction block without a mode is the shape that forces default injection.
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {},
        },
      },
    };

    const snapshot = materializeRuntimeConfig(config, "snapshot");
    const load = materializeRuntimeConfig(config, "load");

    expect(snapshot.agents?.defaults?.compaction?.mode).toBeDefined();
    expect(snapshot).toEqual(load);
  });

  it("keeps an explicit compaction mode unchanged in both modes", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: { mode: "safeguard" },
        },
      },
    };

    expect(materializeRuntimeConfig(config, "snapshot").agents?.defaults?.compaction?.mode).toBe(
      "safeguard",
    );
    expect(materializeRuntimeConfig(config, "load").agents?.defaults?.compaction?.mode).toBe(
      "safeguard",
    );
  });
});
