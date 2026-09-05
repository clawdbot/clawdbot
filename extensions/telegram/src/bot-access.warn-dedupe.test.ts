// Telegram tests cover invalid allowFrom warning dedupe bounds.
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  const createSubsystemLogger = () => {
    const logger = { warn: warnMock, child: () => logger };
    return logger as unknown as ReturnType<typeof actual.createSubsystemLogger>;
  };
  return { ...actual, createSubsystemLogger };
});

const WARN_CACHE_MAX = 256;
let normalizeAllowFrom: typeof import("./bot-access.js").normalizeAllowFrom;

function normalizeOutsideTestGuard(list: Array<string | number>) {
  return withEnv({ VITEST: undefined, NODE_ENV: "development" }, () => normalizeAllowFrom(list));
}

beforeEach(async () => {
  vi.resetModules();
  warnMock.mockReset();
  ({ normalizeAllowFrom } = await import("./bot-access.js"));
});

describe("normalizeAllowFrom invalid-entry warn dedupe", () => {
  it("warns once per invalid entry across repeated calls", () => {
    normalizeOutsideTestGuard(["@someone", "12345"]);
    normalizeOutsideTestGuard(["@someone"]);
    normalizeOutsideTestGuard(["@someone", "@other"]);

    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest warning while keeping recent duplicates suppressed", () => {
    for (let i = 0; i <= WARN_CACHE_MAX; i++) {
      normalizeOutsideTestGuard([`@user${i}`]);
    }
    expect(warnMock).toHaveBeenCalledTimes(WARN_CACHE_MAX + 1);

    normalizeOutsideTestGuard([`@user${WARN_CACHE_MAX}`]);
    expect(warnMock).toHaveBeenCalledTimes(WARN_CACHE_MAX + 1);

    normalizeOutsideTestGuard(["@user0"]);
    expect(warnMock).toHaveBeenCalledTimes(WARN_CACHE_MAX + 2);
  });

  it("does not change normalization or warn under the test guard", () => {
    expect(normalizeAllowFrom(["*", " tg:12345 ", "@someone"])).toEqual({
      entries: ["12345"],
      hasWildcard: true,
      hasEntries: true,
      invalidEntries: ["@someone"],
    });
    expect(warnMock).not.toHaveBeenCalled();
  });
});
