import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  DEFAULT_COMMAND_SPECS,
  parseSlashCommandPayload,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveCommandText,
  resolveSlashCommandConfig,
} from "./slash-commands.js";

describe("slash-commands", () => {
  async function registerSingleStatusCommand(
    requestImpl: (path: string, init?: { method?: string }) => Promise<unknown>,
  ) {
    const client: MattermostClient = {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "bot-token",
      request: async <T>(path: string, init?: RequestInit) => (await requestImpl(path, init)) as T,
      fetchImpl: vi.fn<typeof fetch>(),
    };
    return registerSlashCommands({
      client,
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "http://gateway/callback",
      commands: [
        {
          trigger: "oc_status",
          description: "status",
          autoComplete: true,
        },
      ],
    });
  }

  it("parses application/x-www-form-urlencoded payloads", () => {
    const payload = parseSlashCommandPayload(
      "token=t1&team_id=team&channel_id=ch1&user_id=u1&command=%2Foc_status&text=now",
      "application/x-www-form-urlencoded",
    );
    expect(payload).toMatchObject({
      token: "t1",
      team_id: "team",
      channel_id: "ch1",
      user_id: "u1",
      command: "/oc_status",
      text: "now",
    });
  });

  it("parses application/json payloads", () => {
    const payload = parseSlashCommandPayload(
      JSON.stringify({
        token: "t2",
        team_id: "team",
        channel_id: "ch2",
        user_id: "u2",
        command: "/oc_model",
        text: "gpt-5",
      }),
      "application/json; charset=utf-8",
    );
    expect(payload).toMatchObject({
      token: "t2",
      command: "/oc_model",
      text: "gpt-5",
    });
  });

  it("returns null for malformed payloads missing required fields", () => {
    const payload = parseSlashCommandPayload(
      JSON.stringify({ token: "t3", command: "/oc_help" }),
      "application/json",
    );
    expect(payload).toBeNull();
  });

  it("resolves command text with trigger map fallback", () => {
    const triggerMap = new Map<string, string>([["oc_status", "status"]]);
    expect(resolveCommandText("oc_status", "   ", triggerMap)).toBe("/status");
    expect(resolveCommandText("oc_status", " now ", triggerMap)).toBe("/status now");
    expect(resolveCommandText("oc_models", " openai ", undefined)).toBe("/models openai");
    expect(resolveCommandText("oc_help", "", undefined)).toBe("/help");
  });

  it("registers both public model slash commands", () => {
    expect(
      DEFAULT_COMMAND_SPECS.filter(
        (spec) => spec.trigger === "oc_model" || spec.trigger === "oc_models",
      ).map((spec) => spec.trigger),
    ).toEqual(["oc_model", "oc_models"]);
  });

  it("normalizes callback path in slash config", () => {
    const config = resolveSlashCommandConfig({ callbackPath: "api/channels/mattermost/command" });
    expect(config.callbackPath).toBe("/api/channels/mattermost/command");
  });

  it("falls back to localhost callback URL for wildcard bind hosts", () => {
    const config = resolveSlashCommandConfig({ callbackPath: "/api/channels/mattermost/command" });
    const callbackUrl = resolveCallbackUrl({
      config,
      gatewayPort: 18789,
      gatewayHost: "0.0.0.0",
    });
    expect(callbackUrl).toBe("http://localhost:18789/api/channels/mattermost/command");
  });

  it("reuses existing command when trigger already points to callback URL", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-1",
            token: "tok-1",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(1);
    expect(result[0]?.managed).toBe(false);
    expect(result[0]?.id).toBe("cmd-1");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("skips foreign command trigger collisions instead of mutating non-owned commands", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-foreign-1",
            token: "tok-foreign-1",
            team_id: "team-1",
            creator_id: "another-bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://foreign/callback",
            auto_complete: true,
          },
        ];
      }
      if (init?.method === "POST" || init?.method === "PUT" || init?.method === "DELETE") {
        throw new Error("should not mutate foreign commands");
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
