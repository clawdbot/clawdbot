// Browser tests cover fault-tolerant batch cookie injection.
import { beforeEach, describe, expect, it, vi } from "vitest";

let addCookies: ReturnType<typeof vi.fn>;
let page: Record<string, unknown>;

const getPageForTargetId = vi.fn(async () => page);
const ensurePageState = vi.fn(() => ({}));

vi.mock("./pw-session.js", () => ({
  ensurePageState,
  getPageForTargetId,
}));

const { cookiesSetManyViaPlaywright } = await import("./pw-tools-core.storage.js");

function cookie(name: string) {
  return { name, value: "v", domain: ".example.com", path: "/" };
}

beforeEach(() => {
  addCookies = vi.fn(async (cookies: Array<{ name: string }>) => {
    if (cookies.some((c) => c.name === "bad")) {
      throw new Error("rejected cookie");
    }
  });
  page = { context: () => ({ addCookies }) };
  getPageForTargetId.mockClear();
});

describe("cookiesSetManyViaPlaywright", () => {
  it("adds a clean set in a single batch", async () => {
    const cookies = [cookie("a"), cookie("b"), cookie("c")];
    const result = await cookiesSetManyViaPlaywright({ cdpUrl: "http://x", cookies });
    expect(result).toEqual({ added: 3 });
    expect(addCookies).toHaveBeenCalledTimes(1);
  });

  it("falls back to per-cookie and counts a rejected cookie without aborting", async () => {
    const cookies = [cookie("a"), cookie("bad"), cookie("c")];
    const result = await cookiesSetManyViaPlaywright({ cdpUrl: "http://x", cookies });
    // Batch fails, then each cookie is retried individually; only "bad" is dropped.
    expect(result).toEqual({ added: 2 });
    expect(addCookies).toHaveBeenCalledTimes(1 + 3);
  });

  it("commits more than one batch for large cookie sets", async () => {
    const cookies = Array.from({ length: 750 }, (_, i) => cookie(`c${i}`));
    const result = await cookiesSetManyViaPlaywright({ cdpUrl: "http://x", cookies });
    expect(result).toEqual({ added: 750 });
    expect(addCookies).toHaveBeenCalledTimes(2);
  });
});
