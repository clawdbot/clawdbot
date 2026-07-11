// Browser tests cover the /profiles/import domain-filter validation.
import { describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const importSystemProfile = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const));

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
}));

vi.mock("../profiles-service.js", () => ({
  createBrowserProfilesService: vi.fn(() => ({ importSystemProfile })),
}));

const { registerBrowserBasicRoutes } = await import("./basic.js");

function importHandler() {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, {} as never);
  const handler = postHandlers.get("/profiles/import");
  if (!handler) {
    throw new Error("expected /profiles/import handler");
  }
  return handler;
}

async function callImport(body: unknown, signal?: AbortSignal) {
  const handler = importHandler();
  const response = createBrowserRouteResponse();
  await handler({ body, signal } as never, response.res);
  return response;
}

describe("POST /profiles/import domain filter validation", () => {
  it.each([
    ["a non-array string", { domains: "google.com" }, "domains must be an array of domain strings"],
    ["an empty array", { domains: [] }, "domains must include at least one non-empty domain"],
    [
      "an array of blanks",
      { domains: ["   ", ""] },
      "domains must include at least one non-empty domain",
    ],
  ])("fails closed for %s", async (_label, body, message) => {
    const response = await callImport(body);
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: message });
  });

  it("forwards an explicit default-profile request", async () => {
    const response = await callImport({
      browser: "chrome",
      systemProfile: "Default",
      into: "imported",
      makeDefault: true,
    });

    expect(response.statusCode).toBe(200);
    expect(importSystemProfile).toHaveBeenCalledWith(
      {
        browser: "chrome",
        systemProfile: "Default",
        into: "imported",
        domains: undefined,
        makeDefault: true,
      },
      { signal: undefined },
    );
  });

  it("forwards the request abort signal into the import transaction", async () => {
    const abort = new AbortController();
    await callImport({ into: "imported" }, abort.signal);

    expect(importSystemProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ into: "imported" }),
      { signal: abort.signal },
    );
  });
});
