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

installGatewayTestHooks();

const resolveMainKey = () => resolveMainSessionKeyFromConfig();

describe("gateway server hooks", () => {
  test("hooks wake requires auth", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Ping" }),
    });
    expect(res.status).toBe(401);
    await server.close();
  });

  test("hooks wake enqueues system event", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: JSON.stringify({ text: "Ping", mode: "next-heartbeat" }),
    });
    expect(res.status).toBe(200);
    const events = await waitForSystemEvent();
    expect(events.some((e) => e.includes("Ping"))).toBe(true);
    drainSystemEvents(resolveMainKey());
    await server.close();
  });

  test("hooks agent posts summary to main", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    cronIsolatedRun.mockResolvedValueOnce({
      status: "ok",
      summary: "done",
    });
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: JSON.stringify({ message: "Do it", name: "Email" }),
    });
    expect(res.status).toBe(202);
    const events = await waitForSystemEvent();
    expect(events.some((e) => e.includes("Hook Email: done"))).toBe(true);
    drainSystemEvents(resolveMainKey());
    await server.close();
  });

  test("hooks agent forwards model override", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    cronIsolatedRun.mockClear();
    cronIsolatedRun.mockResolvedValueOnce({
      status: "ok",
      summary: "done",
    });
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
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
    expect(res.status).toBe(202);
    await waitForSystemEvent();
    const call = cronIsolatedRun.mock.calls[0]?.[0] as {
      job?: { payload?: { model?: string } };
    };
    expect(call?.job?.payload?.model).toBe("openai/gpt-4.1-mini");
    drainSystemEvents(resolveMainKey());
    await server.close();
  });

  test("hooks wake accepts query token", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(
      `http://127.0.0.1:${port}/hooks/wake?token=hook-secret`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Query auth" }),
      },
    );
    expect(res.status).toBe(200);
    const events = await waitForSystemEvent();
    expect(events.some((e) => e.includes("Query auth"))).toBe(true);
    drainSystemEvents(resolveMainKey());
    await server.close();
  });

  test("hooks agent rejects invalid channel", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: JSON.stringify({ message: "Nope", channel: "sms" }),
    });
    expect(res.status).toBe(400);
    expect(peekSystemEvents(resolveMainKey()).length).toBe(0);
    await server.close();
  });

  test("hooks wake accepts x-clawdbot-token header", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clawdbot-token": "hook-secret",
      },
      body: JSON.stringify({ text: "Header auth" }),
    });
    expect(res.status).toBe(200);
    const events = await waitForSystemEvent();
    expect(events.some((e) => e.includes("Header auth"))).toBe(true);
    drainSystemEvents(resolveMainKey());
    await server.close();
  });

  test("hooks rejects non-post", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "GET",
      headers: { Authorization: "Bearer hook-secret" },
    });
    expect(res.status).toBe(405);
    await server.close();
  });

  test("hooks wake requires text", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: JSON.stringify({ text: " " }),
    });
    expect(res.status).toBe(400);
    await server.close();
  });

  test("hooks agent requires message", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: JSON.stringify({ message: " " }),
    });
    expect(res.status).toBe(400);
    await server.close();
  });

  test("hooks rejects invalid json", async () => {
    testState.hooksConfig = { enabled: true, token: "hook-secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const res = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hook-secret",
      },
      body: "{",
    });
    expect(res.status).toBe(400);
    await server.close();
  });
});
