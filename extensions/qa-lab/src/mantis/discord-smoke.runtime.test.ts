// Qa Lab tests cover discord smoke plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuard } = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard,
}));

import { runMantisDiscordSmoke } from "./discord-smoke.runtime.js";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyResponse(status = 204) {
  return new Response(null, { status });
}

function fetchGuardCallsWithMethod(method: string) {
  return fetchWithSsrFGuard.mock.calls.filter(([request]) => {
    const init =
      typeof request === "object" && request !== null
        ? (request as { init?: RequestInit }).init
        : undefined;
    return init?.method === method;
  });
}

describe("mantis discord smoke runtime", () => {
  let repoRoot: string;
  let tokenFile: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-discord-smoke-"));
    tokenFile = path.join(repoRoot, "mantis-token");
    await fs.writeFile(tokenFile, "test-token", "utf8");
    fetchWithSsrFGuard.mockReset();
    const reactionPaths = new Set([
      "/api/v10/channels/1456744319972282449/messages/1500000000000000001/reactions/%F0%9F%91%80/@me",
      "/api/v10/channels/1456744319972282449/messages/1500000000000000001/reactions/👀/@me",
    ]);
    fetchWithSsrFGuard.mockImplementation(
      async ({ url, init }: { url: string; init?: RequestInit }) => {
        const pathname = new URL(url).pathname;
        const method = init?.method ?? "GET";
        if (pathname === "/api/v10/users/@me") {
          return {
            response: jsonResponse({ id: "1489650053747314748", username: "Mantis" }),
            release: vi.fn(),
          };
        }
        if (pathname === "/api/v10/guilds/1456350064065904867") {
          return {
            response: jsonResponse({ id: "1456350064065904867", name: "Friends" }),
            release: vi.fn(),
          };
        }
        if (pathname === "/api/v10/guilds/1456350064065904867/channels") {
          return { response: jsonResponse([{ id: "1456744319972282449" }]), release: vi.fn() };
        }
        if (pathname === "/api/v10/channels/1456744319972282449" && method === "GET") {
          return {
            response: jsonResponse({
              guild_id: "1456350064065904867",
              id: "1456744319972282449",
              name: "maintainers",
              type: 0,
            }),
            release: vi.fn(),
          };
        }
        if (pathname === "/api/v10/channels/1456744319972282449/messages" && method === "POST") {
          return {
            response: jsonResponse({
              id: "1500000000000000001",
              channel_id: "1456744319972282449",
            }),
            release: vi.fn(),
          };
        }
        if (reactionPaths.has(pathname) && method === "PUT") {
          return { response: emptyResponse(), release: vi.fn() };
        }
        return {
          response: jsonResponse({ message: `unexpected ${method} ${pathname}` }, 404),
          release: vi.fn(),
        };
      },
    );
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("writes pass artifacts without leaking the bot token", async () => {
    const result = await runMantisDiscordSmoke({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mantis/test",
      tokenFile,
      env: {
        OPENCLAW_QA_DISCORD_GUILD_ID: "1456350064065904867",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "1456744319972282449",
      },
      now: () => new Date("2026-05-03T12:00:00.000Z"),
    });

    expect(result.status).toBe("pass");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      status: string;
      tokenSource: string;
      message: { id: string; posted: boolean; reactionAdded: boolean };
    };
    expect(summary.status).toBe("pass");
    expect(summary.tokenSource).toBe("file");
    expect(summary.message.id).toBe("1500000000000000001");
    expect(summary.message.posted).toBe(true);
    expect(summary.message.reactionAdded).toBe(true);
    expect(await fs.readFile(result.summaryPath, "utf8")).not.toContain("test-token");
    expect(await fs.readFile(result.reportPath, "utf8")).not.toContain("test-token");
  });

  it("supports visibility-only smoke runs", async () => {
    const result = await runMantisDiscordSmoke({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mantis/visibility",
      tokenFile,
      skipPost: true,
      env: {
        OPENCLAW_QA_DISCORD_GUILD_ID: "1456350064065904867",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "1456744319972282449",
      },
    });

    expect(result.status).toBe("pass");
    expect(fetchGuardCallsWithMethod("POST")).toHaveLength(0);
  });

  it("redacts Discord target metadata in public artifacts", async () => {
    const result = await runMantisDiscordSmoke({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mantis/redacted",
      tokenFile,
      redactPublicMetadata: true,
      env: {
        OPENCLAW_QA_DISCORD_GUILD_ID: "1456350064065904867",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "1456744319972282449",
      },
    });

    expect(result.status).toBe("pass");
    const summaryText = await fs.readFile(result.summaryPath, "utf8");
    const reportText = await fs.readFile(result.reportPath, "utf8");
    expect(reportText).toContain("# Mantis Discord Smoke");
    expect(reportText).toContain("- Bot: <redacted> (<redacted>)");
    expect(reportText).toContain("- Guild: <redacted> (<redacted>)");
    expect(reportText).toContain("- Channel: #<redacted> (<redacted>)");
    for (const text of [summaryText, reportText]) {
      expect(text).toContain("<redacted>");
      expect(text).not.toContain("1489650053747314748");
      expect(text).not.toContain("1456350064065904867");
      expect(text).not.toContain("Friends");
      expect(text).not.toContain("1456744319972282449");
      expect(text).not.toContain("maintainers");
      expect(text).not.toContain("1500000000000000001");
    }
    expect(summaryText).not.toContain("Mantis");
    const summary = JSON.parse(summaryText) as {
      bot?: { id: string; username?: string };
      channel?: { id: string; name?: string; type?: number };
      guild?: { id: string; name?: string };
      message?: { id: string };
      metadataRedaction: boolean;
    };
    expect(summary.metadataRedaction).toBe(true);
    expect(summary.bot).toEqual({ id: "<redacted>", username: "<redacted>" });
    expect(summary.guild).toEqual({ id: "<redacted>", name: "<redacted>" });
    expect(summary.channel).toEqual({ id: "<redacted>", name: "<redacted>", type: 0 });
    expect(summary.message?.id).toBe("<redacted>");
  });

  it("fails before calling Discord when required ids are missing", async () => {
    const result = await runMantisDiscordSmoke({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mantis/missing",
      tokenFile,
      env: {},
    });

    expect(result.status).toBe("fail");
    const errorText = await fs.readFile(path.join(result.outputDir, "error.txt"), "utf8");
    expect(errorText).toContain("Missing OPENCLAW_QA_DISCORD_GUILD_ID");
  });

  it("fails when the channel is not in the configured guild", async () => {
    fetchWithSsrFGuard.mockImplementation(
      async ({ url, init }: { url: string; init?: RequestInit }) => {
        const pathname = new URL(url).pathname;
        const method = init?.method ?? "GET";
        if (pathname === "/api/v10/users/@me") {
          return {
            response: jsonResponse({ id: "1489650053747314748", username: "Mantis" }),
            release: vi.fn(),
          };
        }
        if (pathname === "/api/v10/guilds/1456350064065904867") {
          return {
            response: jsonResponse({ id: "1456350064065904867", name: "Friends" }),
            release: vi.fn(),
          };
        }
        if (pathname === "/api/v10/guilds/1456350064065904867/channels") {
          return { response: jsonResponse([{ id: "1999999999999999999" }]), release: vi.fn() };
        }
        if (pathname === "/api/v10/channels/1456744319972282449" && method === "GET") {
          return {
            response: jsonResponse({
              guild_id: "1999999999999999999",
              id: "1456744319972282449",
              name: "wrong-guild-channel",
              type: 0,
            }),
            release: vi.fn(),
          };
        }
        return {
          response: jsonResponse({ message: `unexpected ${method} ${pathname}` }, 404),
          release: vi.fn(),
        };
      },
    );

    const result = await runMantisDiscordSmoke({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mantis/wrong-guild",
      tokenFile,
      env: {
        OPENCLAW_QA_DISCORD_GUILD_ID: "1456350064065904867",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "1456744319972282449",
      },
    });

    expect(result.status).toBe("fail");
    const errorText = await fs.readFile(path.join(result.outputDir, "error.txt"), "utf8");
    expect(errorText).toContain("is not in guild");
    expect(fetchGuardCallsWithMethod("POST")).toHaveLength(0);
  });

  it("fails closed when a Discord API response exceeds the byte cap", async () => {
    const oversizedBody = "x".repeat(16 * 1024 * 1024 + 1);
    const release = vi.fn();
    fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v10/users/@me") {
        return {
          response: new Response(oversizedBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
          release,
        };
      }
      return {
        response: jsonResponse({ message: `unexpected ${pathname}` }, 404),
        release: vi.fn(),
      };
    });

    const result = await runMantisDiscordSmoke({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mantis/oversized",
      tokenFile,
      env: {
        OPENCLAW_QA_DISCORD_GUILD_ID: "1456350064065904867",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "1456744319972282449",
      },
    });

    expect(result.status).toBe("fail");
    const errorText = await fs.readFile(path.join(result.outputDir, "error.txt"), "utf8");
    expect(errorText).toContain("/users/@me response exceeds");
    expect(errorText).toContain(`${16 * 1024 * 1024} bytes`);
    // The byte cap trips on the first call, so the post step never runs.
    expect(fetchGuardCallsWithMethod("POST")).toHaveLength(0);
    // The connection is still released on the fail-closed path.
    expect(release).toHaveBeenCalled();
  });

  it("parses a large-but-under-cap Discord response unchanged", async () => {
    // A bot username padded out to ~1 MiB of valid JSON: streamed across many
    // chunks but comfortably under the 16 MiB cap, so the smoke must still pass
    // and never truncate the legitimate payload.
    const paddedUsername = `Mantis${"_".repeat(1024 * 1024)}`;
    const baseImpl = fetchWithSsrFGuard.getMockImplementation();
    fetchWithSsrFGuard.mockImplementation(async (request: { url: string; init?: RequestInit }) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/v10/users/@me") {
        return {
          response: jsonResponse({ id: "1489650053747314748", username: paddedUsername }),
          release: vi.fn(),
        };
      }
      return baseImpl!(request);
    });

    const result = await runMantisDiscordSmoke({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mantis/under-cap",
      tokenFile,
      env: {
        OPENCLAW_QA_DISCORD_GUILD_ID: "1456350064065904867",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "1456744319972282449",
      },
    });

    expect(result.status).toBe("pass");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      bot?: { username?: string };
      status: string;
    };
    expect(summary.status).toBe("pass");
    // The full (un-truncated) padded username round-trips through the bounded read.
    expect(summary.bot?.username).toBe(paddedUsername);
    expect(fetchGuardCallsWithMethod("POST")).toHaveLength(1);
  });

  it("fails with a parse error when a Discord 200 body is not JSON (bounded read preserves malformed handling)", async () => {
    const release = vi.fn();
    fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v10/users/@me") {
        return {
          response: new Response("<!doctype html><html>not json</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
          release,
        };
      }
      return {
        response: jsonResponse({ message: `unexpected ${pathname}` }, 404),
        release: vi.fn(),
      };
    });

    const result = await runMantisDiscordSmoke({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mantis/malformed",
      tokenFile,
      env: {
        OPENCLAW_QA_DISCORD_GUILD_ID: "1456350064065904867",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "1456744319972282449",
      },
    });

    expect(result.status).toBe("fail");
    // A non-JSON 200 still surfaces as a clean fail (JSON.parse throws on the
    // under-cap body), and no post is attempted.
    expect(fetchGuardCallsWithMethod("POST")).toHaveLength(0);
    expect(release).toHaveBeenCalled();
  });

  it("redacts response guild ids in mismatch failure artifacts", async () => {
    fetchWithSsrFGuard.mockImplementation(
      async ({ url, init }: { url: string; init?: RequestInit }) => {
        const pathname = new URL(url).pathname;
        const method = init?.method ?? "GET";
        if (pathname === "/api/v10/users/@me") {
          return {
            response: jsonResponse({ id: "1489650053747314748", username: "Mantis" }),
            release: vi.fn(),
          };
        }
        if (pathname === "/api/v10/guilds/1456350064065904867") {
          return {
            response: jsonResponse({ id: "1456350064065904867", name: "Friends" }),
            release: vi.fn(),
          };
        }
        if (pathname === "/api/v10/guilds/1456350064065904867/channels") {
          return { response: jsonResponse([{ id: "1456744319972282449" }]), release: vi.fn() };
        }
        if (pathname === "/api/v10/channels/1456744319972282449" && method === "GET") {
          return {
            response: jsonResponse({
              guild_id: "1999999999999999999",
              id: "1456744319972282449",
              name: "wrong-guild-channel",
              type: 0,
            }),
            release: vi.fn(),
          };
        }
        return {
          response: jsonResponse({ message: `unexpected ${method} ${pathname}` }, 404),
          release: vi.fn(),
        };
      },
    );

    const result = await runMantisDiscordSmoke({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mantis/wrong-guild-redacted",
      tokenFile,
      redactPublicMetadata: true,
      env: {
        OPENCLAW_QA_DISCORD_GUILD_ID: "1456350064065904867",
        OPENCLAW_QA_DISCORD_CHANNEL_ID: "1456744319972282449",
      },
    });

    expect(result.status).toBe("fail");
    const errorText = await fs.readFile(path.join(result.outputDir, "error.txt"), "utf8");
    expect(errorText).toContain("<redacted>");
    expect(errorText).not.toContain("1999999999999999999");
    expect(errorText).not.toContain("1456350064065904867");
    expect(errorText).not.toContain("1456744319972282449");
  });
});
