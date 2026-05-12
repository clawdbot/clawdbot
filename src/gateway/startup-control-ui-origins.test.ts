import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

describe("maybeSeedControlUiAllowedOriginsAtStartup", () => {
  it("applies origins seeded from runtime bind and port without persisting config", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config: { gateway: {} },
      log,
      runtimeBind: "lan",
      runtimePort: 3000,
    });

    const expectedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];
    expect(result.seededAllowedOrigins).toBe(true);
    expect(result.config.gateway?.controlUi?.allowedOrigins).toEqual(expectedOrigins);
    expect(log.info).toHaveBeenCalledWith(
      'gateway: seeded gateway.controlUi.allowedOrigins ["http://localhost:3000","http://127.0.0.1:3000"] for bind=lan (required since v2026.2.26; see issue #29385). Applied for this runtime without writing config; add other origins to gateway.controlUi.allowedOrigins if needed.',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not rewrite config when origins already exist", async () => {
    const config: OpenClawConfig = {
      gateway: {
        controlUi: { allowedOrigins: ["https://control.example.com"] },
      },
    };
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config,
      log,
      runtimeBind: "lan",
      runtimePort: 3000,
    });

    expect(result).toEqual({ config, seededAllowedOrigins: false });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
