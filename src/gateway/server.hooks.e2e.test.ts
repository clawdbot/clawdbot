import { describe, expect, test } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import {
  cronIsolatedRun,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  testState,
  waitForSystemEvent,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const resolveMainKey = () => resolveMainSessionKeyFromConfig();

describe("gateway server hooks", () => {
  test("handles auth, wake, and agent flows", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    try {
      const resNoAuth = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Ping" }),
      });
      expect(resNoAuth.status).toBe(401);

      const resWake = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({ text: "Ping", mode: "next-heartbeat" }),
      });
      expect(resWake.status).toBe(200);
      const wakeEvents = await waitForSystemEvent();
      expect(wakeEvents.some((e) => e.includes("Ping"))).toBe(true);
      drainSystemEvents(resolveMainKey());

      cronIsolatedRun.mockReset();
      cronIsolatedRun.mockResolvedValueOnce({
        status: "ok",
        summary: "done",
      });
      const resAgent = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({ message: "Do it", name: "Email" }),
      });
      expect(resAgent.status).toBe(202);
      const agentEvents = await waitForSystemEvent();
      expect(agentEvents.some((e) => e.includes("Hook Email: done"))).toBe(true);
      drainSystemEvents(resolveMainKey());

      cronIsolatedRun.mockReset();
      cronIsolatedRun.mockResolvedValueOnce({
        status: "ok",
        summary: "done",
      });
      const resAgentModel = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({
          message: "Do it",
          name: "Email",
          model: "openai/gpt-4.1-mini",
        }),
      });
      expect(resAgentModel.status).toBe(202);
      await waitForSystemEvent();
      const call = cronIsolatedRun.mock.calls[0]?.[0] as {
        job?: { payload?: { model?: string } };
      };
      expect(call?.job?.payload?.model).toBe("openai/gpt-4.1-mini");
      drainSystemEvents(resolveMainKey());

      const resQuery = await fetch(`http://127.0.0.1:${port}/hooks/wake?token=hook-secret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Query auth" }),
      });
      expect(resQuery.status).toBe(200);
      const queryEvents = await waitForSystemEvent();
      expect(queryEvents.some((e) => e.includes("Query auth"))).toBe(true);
      drainSystemEvents(resolveMainKey());

      const resBadChannel = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({ message: "Nope", channel: "sms" }),
      });
      expect(resBadChannel.status).toBe(400);
      expect(peekSystemEvents(resolveMainKey()).length).toBe(0);

      const resHeader = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-moltbot-token": "hook-secret",
        },
        body: JSON.stringify({ text: "Header auth" }),
      });
      expect(resHeader.status).toBe(200);
      const headerEvents = await waitForSystemEvent();
      expect(headerEvents.some((e) => e.includes("Header auth"))).toBe(true);
      drainSystemEvents(resolveMainKey());

      const resGet = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
        method: "GET",
        headers: { Authorization: "Bearer hook-secret" },
      });
      expect(resGet.status).toBe(405);

      const resBlankText = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({ text: " " }),
      });
      expect(resBlankText.status).toBe(400);

      const resBlankMessage = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({ message: " " }),
      });
      expect(resBlankMessage.status).toBe(400);

      const resBadJson = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: "{",
      });
      expect(resBadJson.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
