import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { runQaSuite } from "./suite-launch.runtime.js";

const RUN_DISCORD_CRABLINE_E2E = process.env.OPENCLAW_QA_DISCORD_CRABLINE_E2E === "1";
const SCENARIO_ID = "discord-crabline-roundtrip";
const EXPECTED_MARKER = "DISCORD-CRABLINE-ROUNDTRIP-OK";

type RecorderEvent = {
  accepted?: boolean;
  body?: Record<string, unknown>;
  method?: string;
  path?: string;
  type?: string;
};

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readRecorderEvents(recorderPath: string): Promise<RecorderEvent[]> {
  const raw = await fs.readFile(recorderPath, "utf8");
  if (raw.includes("discord.com") || raw.includes("discordapp.com")) {
    throw new Error("Discord Crabline recorder contains a public Discord service target.");
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecorderEvent);
}

describe("Discord Crabline real-plugin roundtrip", () => {
  it.runIf(RUN_DISCORD_CRABLINE_E2E)(
    "crosses the real Discord REST and Gateway boundaries and flushes cleanup evidence",
    async () => {
      const repoRoot = process.cwd();
      const outputDir = path.join(
        repoRoot,
        ".artifacts",
        "qa-e2e",
        `discord-crabline-roundtrip-${process.pid}-${Date.now()}`,
      );
      const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "discord" });

      const suite = await runQaSuite({
        channelDriver: "crabline",
        channelDriverSelection: selection,
        channelId: "discord",
        controlUiEnabled: false,
        outputDir,
        primaryModel: "mock-openai/gpt-5.6-luna",
        providerMode: "mock-openai",
        repoRoot,
        scenarioIds: [SCENARIO_ID],
      });

      expect(suite.executionKind).toBe("flow");
      expect(suite.result.scenarios).toEqual([
        expect.objectContaining({ name: expect.any(String), status: "pass" }),
      ]);

      const recorderPath = path.join(
        suite.result.outputDir,
        "artifacts",
        "crabline",
        "discord-provider-server.jsonl",
      );
      const events = await readRecorderEvents(recorderPath);
      const gatewayMetadata = events.find(
        (event) =>
          event.type === "api" &&
          event.method === "GET" &&
          event.path === "/api/v10/gateway/bot" &&
          event.accepted === true,
      );
      const gatewayIdentify = events.find(
        (event) =>
          event.type === "api" &&
          event.method === "WS" &&
          event.path === "/gateway" &&
          readObject(event.body)?.op === 2 &&
          event.accepted === true,
      );
      expect(gatewayMetadata).toBeDefined();
      expect(gatewayIdentify).toBeDefined();

      const inbound = events.find(
        (event) =>
          event.type === "admin" &&
          event.method === "POST" &&
          event.path === "/crabline/discord/inbound" &&
          event.accepted === true,
      );
      const inboundBody = readObject(inbound?.body);
      const inboundChannelId = readStringValue(inboundBody?.channelId) ?? "";
      const parentChannelId = readStringValue(inboundBody?.parentChannelId) ?? "";
      expect(inboundChannelId).toMatch(/^\d{17,20}$/u);
      expect(parentChannelId).toMatch(/^\d{17,20}$/u);
      expect(inboundChannelId).not.toBe(parentChannelId);
      expect(readStringValue(inboundBody?.content) ?? "").toMatch(/<@\d{17,20}>/u);

      const outbound = events.find(
        (event) =>
          event.type === "api" &&
          event.method === "POST" &&
          event.path === `/api/v10/channels/${inboundChannelId}/messages` &&
          (readStringValue(readObject(event.body)?.content) ?? "").includes(EXPECTED_MARKER) &&
          event.accepted === true,
      );
      const outboundBody = readObject(outbound?.body);
      const messageReference = readObject(outboundBody?.message_reference);
      expect(outbound).toBeDefined();
      expect(readStringValue(outboundBody?.content) ?? "").toContain(EXPECTED_MARKER);
      expect(readStringValue(outboundBody?.content) ?? "").not.toMatch(/<@\d{17,20}>/u);
      expect(messageReference).toMatchObject({
        message_id: expect.stringMatching(/^\d{17,20}$/u),
      });

      expect(
        events.some(
          (event) =>
            event.type === "api" &&
            event.accepted === true &&
            (event.method === "PUT" || event.method === "POST") &&
            /^\/api\/v10\/applications\/\d{17,20}\/commands$/u.test(event.path ?? ""),
        ),
      ).toBe(true);

      // Suite return occurs only after the child Gateway and its WebSocket are stopped, then the
      // Discord HTTP server and recorder are closed. Endpoint routing stays in the child env and
      // never becomes a durable suite artifact.
      await expect(fs.readFile(recorderPath, "utf8")).resolves.toContain(EXPECTED_MARKER);
    },
    180_000,
  );
});
