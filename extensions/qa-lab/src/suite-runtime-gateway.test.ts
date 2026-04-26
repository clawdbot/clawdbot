import { describe, expect, it } from "vitest";
import {
  getGatewayRetryAfterMs,
  isConfigApplyNoopForSnapshot,
  isConfigHashConflict,
  isConfigPatchNoopForSnapshot,
} from "./suite-runtime-gateway.js";

describe("qa suite gateway helpers", () => {
  it("reads retry-after from the primary gateway error before appended logs", () => {
    const error = new Error(
      "rate limit exceeded for config.patch; retry after 38s\nGateway logs:\nprevious config changed since last load",
    );

    expect(getGatewayRetryAfterMs(error)).toBe(38_000);
    expect(isConfigHashConflict(error)).toBe(false);
  });

  it("ignores stale retry-after text that only appears in appended gateway logs", () => {
    const error = new Error(
      "config changed since last load; re-run config.get and retry\nGateway logs:\nold rate limit exceeded for config.patch; retry after 38s",
    );

    expect(getGatewayRetryAfterMs(error)).toBe(null);
    expect(isConfigHashConflict(error)).toBe(true);
  });

  it("detects cleanup config patches that would not change the snapshot", () => {
    const config = {
      tools: {
        profile: "coding",
      },
      agents: {
        list: [{ id: "qa", model: { primary: "openai/gpt-5.5" } }],
      },
    };

    expect(
      isConfigPatchNoopForSnapshot(
        config,
        JSON.stringify({
          tools: {
            deny: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps changed merge patches eligible for the gateway", () => {
    expect(
      isConfigPatchNoopForSnapshot(
        {
          tools: {
            deny: ["image_generate"],
          },
        },
        JSON.stringify({
          tools: {
            deny: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("detects full config applies that only differ by gateway-written metadata", () => {
    const config = {
      gateway: {
        controlUi: {
          allowedOrigins: ["http://127.0.0.1:5173"],
        },
      },
      meta: {
        updatedAt: "2026-04-25T10:00:00.000Z",
      },
    };

    expect(
      isConfigApplyNoopForSnapshot(
        config,
        JSON.stringify({
          gateway: {
            controlUi: {
              allowedOrigins: ["http://127.0.0.1:5173"],
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps changed full config applies eligible for the gateway", () => {
    expect(
      isConfigApplyNoopForSnapshot(
        {
          gateway: {
            controlUi: {
              allowedOrigins: ["http://127.0.0.1:5173"],
            },
          },
          meta: {
            updatedAt: "2026-04-25T10:00:00.000Z",
          },
        },
        JSON.stringify({
          gateway: {
            controlUi: {
              allowedOrigins: ["http://127.0.0.1:5174"],
            },
          },
        }),
      ),
    ).toBe(false);
  });
});
