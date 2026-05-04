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
    expect(summary).toMatchObject({
      status: "pass",
      tokenSource: "file",
      message: {
        id: "1500000000000000001",
        posted: true,
        reactionAdded: true,
      },
    });
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
    expect(fetchWithSsrFGuard).not.toHaveBeenCalledWith(
      expect.objectContaining({
        init: expect.objectContaining({ method: "POST" }),
      }),
    );
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
    expect(JSON.parse(summaryText)).toMatchObject({
      metadataRedaction: true,
      bot: { id: "<redacted>", username: "<redacted>" },
      guild: { id: "<redacted>", name: "<redacted>" },
      channel: { id: "<redacted>", name: "<redacted>" },
      message: { id: "<redacted>" },
    });
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
    expect(fetchWithSsrFGuard).not.toHaveBeenCalledWith(
      expect.objectContaining({
        init: expect.objectContaining({ method: "POST" }),
      }),
    );
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
