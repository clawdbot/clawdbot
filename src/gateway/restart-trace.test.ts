import { describe, expect, it } from "vitest";
import { createGatewayRestartTraceHandoffEnv } from "./restart-trace.js";

describe("gateway restart trace handoff", () => {
  it("keeps timing for slow but valid drains", () => {
    const startedAt = Date.now() - 305_000;
    const lastAt = startedAt + 300_000;

    expect(
      createGatewayRestartTraceHandoffEnv({
        startedAt,
        lastAt,
      }),
    ).toStrictEqual({
      OPENCLAW_GATEWAY_RESTART_TRACE_STARTED_AT_MS: String(startedAt),
      OPENCLAW_GATEWAY_RESTART_TRACE_LAST_AT_MS: String(lastAt),
    });
  });
});
