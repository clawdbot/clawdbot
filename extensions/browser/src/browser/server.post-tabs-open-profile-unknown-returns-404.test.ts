import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBrowserControlServerTestContext,
  getBrowserControlServerBaseUrl,
  installBrowserControlServerHooks,
  makeResponse,
  resetBrowserControlServerTestContext,
  setBrowserControlServerReachable,
  startBrowserControlServerFromConfig,
} from "./server.control-server.test-harness.js";
import { getBrowserTestFetch } from "./test-fetch.js";

describe("browser control server", () => {
  installBrowserControlServerHooks();

  it("POST /tabs/open?profile=unknown returns 404", async () => {
    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();
    const realFetch = getBrowserTestFetch();

    const result = await realFetch(`${base}/tabs/open?profile=unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(result.status).toBe(404);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  it("POST /tabs/open returns 400 for invalid URLs", async () => {
    setBrowserControlServerReachable(true);
    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();
    const realFetch = getBrowserTestFetch();

    const result = await realFetch(`${base}/tabs/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not a url" }),
    });
    expect(result.status).toBe(400);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("Invalid URL:");
  });
});

describe("profile CRUD endpoints", () => {
  beforeEach(async () => {
    await resetBrowserControlServerTestContext();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = url;
        if (u.includes("/json/list")) {
          return makeResponse([]);
        }
        return makeResponse({}, { ok: false, status: 500, text: "unexpected" });
      }),
    );
  });

  afterEach(async () => {
    await cleanupBrowserControlServerTestContext();
  });

  it("validates profile create/delete endpoints", async () => {
    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();
    const realFetch = getBrowserTestFetch();

    const createMissingName = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(createMissingName.status).toBe(400);
    const createMissingNameBody = (await createMissingName.json()) as { error: string };
    expect(createMissingNameBody.error).toContain("name is required");

    const createInvalidName = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Invalid Name!" }),
    });
    expect(createInvalidName.status).toBe(400);
    const createInvalidNameBody = (await createInvalidName.json()) as { error: string };
    expect(createInvalidNameBody.error).toContain("invalid profile name");

    const createDuplicate = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openclaw" }),
    });
    expect(createDuplicate.status).toBe(409);
    const createDuplicateBody = (await createDuplicate.json()) as { error: string };
    expect(createDuplicateBody.error).toContain("already exists");

    const createRemote = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "remote", cdpUrl: "http://10.0.0.42:9222" }),
    });
    expect(createRemote.status).toBe(200);
    const createRemoteBody = (await createRemote.json()) as {
      profile?: string;
      cdpUrl?: string;
      isRemote?: boolean;
    };
    expect(createRemoteBody.profile).toBe("remote");
    expect(createRemoteBody.cdpUrl).toBe("http://10.0.0.42:9222");
    expect(createRemoteBody.isRemote).toBe(true);

    const createBadRemote = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "badremote", cdpUrl: "ftp://bad" }),
    });
    expect(createBadRemote.status).toBe(400);
    const createBadRemoteBody = (await createBadRemote.json()) as { error: string };
    expect(createBadRemoteBody.error).toContain("cdpUrl");

    const createClawd = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "legacyclawd", driver: "clawd" }),
    });
    expect(createClawd.status).toBe(200);
    const createClawdBody = (await createClawd.json()) as {
      profile?: string;
      transport?: string;
      cdpPort?: number | null;
      userDataDir?: string | null;
    };
    expect(createClawdBody.profile).toBe("legacyclawd");
    expect(createClawdBody.transport).toBe("cdp");
    expect(createClawdBody.cdpPort).toBeTypeOf("number");
    expect(createClawdBody.userDataDir).toBeNull();

    const explicitUserDataDir = "/tmp/openclaw-brave-profile";
    await fs.promises.mkdir(explicitUserDataDir, { recursive: true });
    const createExistingSession = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "brave-live",
        driver: "existing-session",
        userDataDir: explicitUserDataDir,
      }),
    });
    expect(createExistingSession.status).toBe(200);
    const createExistingSessionBody = (await createExistingSession.json()) as {
      profile?: string;
      transport?: string;
      userDataDir?: string | null;
    };
    expect(createExistingSessionBody.profile).toBe("brave-live");
    expect(createExistingSessionBody.transport).toBe("chrome-mcp");
    expect(createExistingSessionBody.userDataDir).toBe(explicitUserDataDir);

    const createBadExistingSession = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad-live",
        userDataDir: explicitUserDataDir,
      }),
    });
    expect(createBadExistingSession.status).toBe(400);
    const createBadExistingSessionBody = (await createBadExistingSession.json()) as {
      error: string;
    };
    expect(createBadExistingSessionBody.error).toContain("driver=existing-session is required");

    const createLegacyDriver = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "legacy", driver: "extension" }),
    });
    expect(createLegacyDriver.status).toBe(400);
    const createLegacyDriverBody = (await createLegacyDriver.json()) as { error: string };
    expect(createLegacyDriverBody.error).toContain('unsupported profile driver "extension"');

    const deleteMissing = await realFetch(`${base}/profiles/nonexistent`, {
      method: "DELETE",
    });
    expect(deleteMissing.status).toBe(404);
    const deleteMissingBody = (await deleteMissing.json()) as { error: string };
    expect(deleteMissingBody.error).toContain("not found");

    const deleteDefault = await realFetch(`${base}/profiles/openclaw`, {
      method: "DELETE",
    });
    expect(deleteDefault.status).toBe(400);
    const deleteDefaultBody = (await deleteDefault.json()) as { error: string };
    expect(deleteDefaultBody.error).toContain("cannot delete the default profile");

    const deleteInvalid = await realFetch(`${base}/profiles/Invalid-Name!`, {
      method: "DELETE",
    });
    expect(deleteInvalid.status).toBe(400);
    const deleteInvalidBody = (await deleteInvalid.json()) as { error: string };
    expect(deleteInvalidBody.error).toContain("invalid profile name");
  });
});
