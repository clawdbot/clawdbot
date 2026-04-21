import { vi } from "vitest";

vi.mock("openclaw/plugin-sdk/browser-security-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/browser-security-runtime")
  >("openclaw/plugin-sdk/browser-security-runtime");
  const lookupFn = async (_hostname: string, options?: { all?: boolean }) => {
    const result = { address: "93.184.216.34", family: 4 };
    return options?.all === true ? [result] : result;
  };
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: (hostname: string, params: object = {}) =>
      actual.resolvePinnedHostnameWithPolicy(hostname, { ...params, lookupFn: lookupFn as never }),
  };
});
