import { vi } from "vitest";

vi.mock("../sdk-security-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../sdk-security-runtime.js")>(
    "../sdk-security-runtime.js",
  );
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
