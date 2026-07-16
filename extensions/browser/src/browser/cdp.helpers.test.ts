import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

import { assertCdpEndpointAllowed, fetchJson, fetchOk } from "./cdp.helpers.js";

describe("cdp helpers", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("releases guarded CDP fetches after the response body is consumed", async () => {
    const release = vi.fn(async () => {});
    const json = vi.fn(async () => {
      expect(release).not.toHaveBeenCalled();
      return { ok: true };
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
        json,
      },
      release,
    });

    await expect(
      fetchJson("http://127.0.0.1:9222/json/version", 250, undefined, {
        dangerouslyAllowPrivateNetwork: false,
        allowedHostnames: ["127.0.0.1"],
      }),
    ).resolves.toEqual({ ok: true });

    expect(json).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("allows loopback CDP endpoints in strict SSRF mode", async () => {
    await expect(
      assertCdpEndpointAllowed("http://127.0.0.1:9222/json/version", {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces hostname allowlist for loopback CDP endpoints", async () => {
    await expect(
      assertCdpEndpointAllowed("http://127.0.0.1:9222/json/version", {
        dangerouslyAllowPrivateNetwork: false,
        hostnameAllowlist: ["*.corp.example"],
      }),
    ).rejects.toThrow("browser endpoint blocked by policy");
  });

  it("releases guarded CDP fetches for bodyless requests", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
      },
      release,
    });

    await expect(
      fetchOk("http://127.0.0.1:9222/json/close/TARGET_1", 250, undefined, {
        dangerouslyAllowPrivateNetwork: false,
        allowedHostnames: ["127.0.0.1"],
      }),
    ).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses an exact loopback allowlist for guarded loopback CDP fetches", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
      },
      release,
    });

    await expect(
      fetchOk("http://127.0.0.1:9222/json/version", 250, undefined, {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBeUndefined();

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:9222/json/version",
        policy: {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        },
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves hostname allowlist while allowing exact loopback CDP fetches", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
      },
      release,
    });

    await expect(
      fetchOk("http://127.0.0.1:9222/json/version", 250, undefined, {
        dangerouslyAllowPrivateNetwork: false,
        hostnameAllowlist: ["*.corp.example"],
      }),
    ).resolves.toBeUndefined();

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:9222/json/version",
        policy: {
          dangerouslyAllowPrivateNetwork: false,
          hostnameAllowlist: ["*.corp.example"],
          allowedHostnames: ["127.0.0.1"],
        },
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
