import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMemorySecretInputString } from "./secret-input.js";

const PATH = "memory.search.remote.apiKey";
const ENV_ID = "OPENCLAW_TEST_MEMORY_SECRET_INPUT";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveMemorySecretInputString", () => {
  it("rejects structured refs instead of resolving them from ambient env", () => {
    vi.stubEnv(ENV_ID, "ambient-secret");

    expect(() =>
      resolveMemorySecretInputString({
        value: { source: "env", provider: "default", id: ENV_ID },
        path: PATH,
      }),
    ).toThrow(
      expect.objectContaining({
        name: "UnresolvedSecretInputError",
        path: PATH,
        ref: { source: "env", provider: "default", id: ENV_ID },
      }),
    );
  });

  it.each([`$${ENV_ID}`, `\${${ENV_ID}}`, `secretref-env:${ENV_ID}`])(
    "preserves an already-resolved literal value %s",
    (value) => {
      vi.stubEnv(ENV_ID, "ambient-secret");

      expect(resolveMemorySecretInputString({ value, path: PATH })).toBe(value);
    },
  );
});
