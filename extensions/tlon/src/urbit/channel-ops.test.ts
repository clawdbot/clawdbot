import { beforeEach, describe, expect, it, vi } from "vitest";
import { scryUrbitPath } from "./channel-ops.js";
import { urbitFetch } from "./fetch.js";

vi.mock("./fetch.js", () => ({
  urbitFetch: vi.fn(),
}));

describe("Urbit channel operations", () => {
  beforeEach(() => {
    vi.mocked(urbitFetch).mockReset();
  });

  it("wraps malformed scry response JSON", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(urbitFetch).mockResolvedValue({
      response: new Response("{not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      finalUrl: "https://example.com/~/scry/chat/inbox.json",
      release,
    });

    await expect(
      scryUrbitPath(
        {
          baseUrl: "https://example.com",
          cookie: "urbauth-~zod=123",
        },
        { path: "/chat/inbox.json", auditContext: "test" },
      ),
    ).rejects.toThrow("Urbit scry response was malformed JSON for path /chat/inbox.json");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
