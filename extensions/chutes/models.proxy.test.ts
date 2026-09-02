// Chutes proxy tests cover the live model discovery transport policy.
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { CHUTES_BASE_URL, discoverChutesModels } from "./models.js";

const ORIGINAL_VITEST = process.env.VITEST;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv(key: "VITEST" | "NODE_ENV", value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv("VITEST", ORIGINAL_VITEST);
  restoreEnv("NODE_ENV", ORIGINAL_NODE_ENV);
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

describe("Chutes model discovery proxy policy", () => {
  it("allows the guarded official catalog request to use an eligible HTTP proxy", async () => {
    process.env.VITEST = "false";
    process.env.NODE_ENV = "development";
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("unavailable", { status: 503 }),
      release,
      finalUrl: `${CHUTES_BASE_URL}/models`,
    });

    await discoverChutesModels("test-token");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        url: `${CHUTES_BASE_URL}/models`,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
