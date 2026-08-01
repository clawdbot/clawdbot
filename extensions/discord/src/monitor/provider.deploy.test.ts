// Discord tests cover slash-command deploy REST logging behavior.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, type Mock, vi } from "vitest";
import type { Client } from "../internal/discord.js";
import { formatDiscordDeployErrorDetails } from "./provider.deploy-errors.js";
import { runDiscordCommandDeployInBackground } from "./provider.deploy.js";

type RestFn = (path: string, data?: unknown, query?: unknown) => Promise<unknown>;
type RestMock = {
  get: Mock<RestFn>;
  post: Mock<RestFn>;
  put: Mock<RestFn>;
  patch: Mock<RestFn>;
  delete: Mock<RestFn>;
};

function createRestMock(): RestMock {
  return {
    get: vi.fn<RestFn>(async () => undefined),
    post: vi.fn<RestFn>(async () => undefined),
    put: vi.fn<RestFn>(async () => undefined),
    patch: vi.fn<RestFn>(async () => undefined),
    delete: vi.fn<RestFn>(async () => undefined),
  };
}

function runDeploy(params: {
  rest: RestMock;
  deployCommands: (rest: RestMock) => Promise<void>;
  shouldLogVerbose?: boolean;
}) {
  const log = vi.fn<(message: string) => void>();
  const error = vi.fn<(message: string) => void>();
  const client = {
    rest: params.rest,
    deployCommands: vi.fn(async () => params.deployCommands(params.rest)),
  };
  runDiscordCommandDeployInBackground({
    client: client as unknown as Client,
    runtime: { log, error } as unknown as RuntimeEnv,
    enabled: true,
    accountId: "default",
    startupStartedAt: Date.now(),
    shouldLogVerbose: () => params.shouldLogVerbose ?? false,
    isVerbose: () => false,
  });
  return { log, error, client };
}

function joinedCalls(mock: Mock<(message: string) => void>): string {
  return mock.mock.calls.map((call) => call[0]).join("\n");
}

describe("discord slash-command deploy REST logging", () => {
  it("passes non-command REST traffic through without deploy labels", async () => {
    const rest = createRestMock();
    rest.get.mockImplementation(async (path: string) => {
      if (path.includes("/voice-states/")) {
        throw Object.assign(new Error("Unknown Voice State"), { status: 404 });
      }
      return undefined;
    });
    let deployFinished = false;
    const { log, error } = runDeploy({
      rest,
      shouldLogVerbose: true,
      deployCommands: async (wrapped) => {
        await wrapped.get("/applications/app-1/commands");
        // Concurrent non-deploy traffic (voice-state probe) during the deploy
        // window must keep its caller-owned error handling.
        await expect(wrapped.get("/guilds/1/voice-states/2")).rejects.toThrow(
          "Unknown Voice State",
        );
        deployFinished = true;
      },
    });

    await vi.waitFor(() => expect(deployFinished).toBe(true));
    const logged = joinedCalls(log);
    expect(logged).toContain("native-slash-command-deploy-rest:get:start");
    expect(logged).toContain("path=/applications/app-1/commands");
    expect(logged).not.toContain("voice-states");
    expect(logged).not.toContain("slash command deploy failed");
    expect(joinedCalls(error)).not.toContain("voice-states");
  });

  it("logs one warning per deploy failure at default verbosity", async () => {
    const rest = createRestMock();
    const deployError = Object.assign(new Error("Missing Access"), {
      status: 403,
      discordCode: 50001,
      rawBody: { message: "Missing Access", code: 50001 },
    });
    rest.post.mockRejectedValue(deployError);
    const { log, error, client } = runDeploy({
      rest,
      shouldLogVerbose: false,
      deployCommands: async (wrapped) => {
        await wrapped.post("/applications/app-1/commands", {
          body: [{ name: "skill" }],
        } as never);
      },
    });

    await vi.waitFor(() => expect(client.deployCommands).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    const warnings = log.mock.calls
      .map((call) => call[0])
      .filter((message) => message.includes("slash command deploy failed"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("(message send/receive unaffected)");
    // Per-request rest:error lines are verbose-only diagnostics.
    expect(error).not.toHaveBeenCalled();
  });
});

describe("formatDiscordDeployErrorDetails", () => {
  it("omits bodies that only repeat the message and code", () => {
    expect(
      formatDiscordDeployErrorDetails({
        status: 400,
        discordCode: 30032,
        rawBody: { message: "Maximum number of application commands reached (100).", code: 30032 },
      }),
    ).toBe(" (status=400, code=30032)");
  });

  it("keeps bodies that carry extra fields", () => {
    const details = formatDiscordDeployErrorDetails({
      status: 400,
      discordCode: 50035,
      rawBody: { message: "Invalid Form Body", code: 50035, errors: { "0": { name: {} } } },
    });
    expect(details).toContain("body=");
  });
});
