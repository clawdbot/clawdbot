import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it } from "vitest";
import "../../test-support/browser-security.mock.js";
import {
  installAgentContractHooks,
  startServerAndBase,
} from "../server.agent-contract.test-harness.js";
import {
  getPwMocks,
  setBrowserControlServerProfiles,
  setBrowserControlServerSsrFPolicy,
  setBrowserControlServerTabUrl,
} from "../server.control-server.test-harness.js";
import { getBrowserTestFetch } from "../test-support/fetch.js";

beforeAll(async () => {
  await import("../../server.js");
});

describe("browser page text route", () => {
  installAgentContractHooks();
  const pwMocks = getPwMocks();
  const pageText = expectDefined(pwMocks.getPageTextViaPlaywright, "page text mock");
  const networkRequests = expectDefined(pwMocks.getNetworkRequestsViaPlaywright, "requests mock");

  it("returns page text, truncation, and the resolved tab through the control service", async () => {
    pageText.mockResolvedValueOnce({ text: "Selected text", truncated: true });
    const base = await startServerAndBase();
    const response = await getBrowserTestFetch()(
      `${base}/text?targetId=abcd1234&selector=article&maxChars=13`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      targetId: "abcd1234",
      url: "https://example.com",
      text: "Selected text",
      truncated: true,
    });
    expect(pageText).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "abcd1234",
        selector: "article",
        maxChars: 13,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each(["0", "-1", "1.5", "1e3", "Infinity"])(
    "rejects invalid maxChars=%s before extraction",
    async (maxChars) => {
      const base = await startServerAndBase();
      const response = await getBrowserTestFetch()(`${base}/text?maxChars=${maxChars}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "maxChars must be a positive integer." });
      expect(pageText).not.toHaveBeenCalled();
    },
  );

  it("rejects disallowed current tab URLs before reading page text", async () => {
    setBrowserControlServerSsrFPolicy({ allowPrivateNetwork: false });
    setBrowserControlServerTabUrl("http://127.0.0.1:8080/admin");
    const base = await startServerAndBase();
    const response = await getBrowserTestFetch()(`${base}/text?targetId=abcd1234`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "browser navigation blocked by policy" });
    expect(pageText).not.toHaveBeenCalled();
  });

  it.each(["text", "requests"])(
    "rejects existing-session %s with a supported alternative",
    async (route) => {
      setBrowserControlServerProfiles(
        { user: { driver: "existing-session", color: "#FF4500" } },
        "user",
      );
      const base = await startServerAndBase();
      const response = await getBrowserTestFetch()(`${base}/${route}?profile=user`);
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("snapshot") });
      expect(pageText).not.toHaveBeenCalled();
      expect(networkRequests).not.toHaveBeenCalled();
    },
  );
});
