import { describe, expect, it } from "vitest";

import { installGatewayTestHooks, getFreePort } from "./test-helpers.server.js";
import { startGatewayServer } from "./server.js";
import { testState } from "./test-helpers.mocks.js";

installGatewayTestHooks({ scope: "suite" });

describe("POST /tools/invoke", () => {
  it("invokes a tool and returns {ok:true,result}", async () => {
    testState.gatewayAuth = { mode: "none" } as any;

    // Allow the sessions_list tool for main agent.
    testState.agentsConfig = {
      list: [
        {
          id: "main",
          tools: {
            allow: ["sessions_list"],
          },
        },
      ],
    } as any;

    const port = await getFreePort();
    const server = await startGatewayServer(port, {
      bind: "loopback",
    });

    const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "sessions_list", action: "json", args: {}, sessionKey: "main" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("result");

    await server.close();
  });

  it("rejects unauthorized when auth mode is token and header is missing", async () => {
    testState.gatewayAuth = { mode: "token", token: "t" } as any;
    testState.agentsConfig = {
      list: [
        {
          id: "main",
          tools: {
            allow: ["sessions_list"],
          },
        },
      ],
    } as any;

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "sessions_list", action: "json", args: {}, sessionKey: "main" }),
    });

    expect(res.status).toBe(401);

    await server.close();
  });

  it("returns 404 when tool is not allowlisted", async () => {
    testState.gatewayAuth = { mode: "none" } as any;
    testState.agentsConfig = {
      list: [
        {
          id: "main",
          tools: {
            deny: ["sessions_list"],
          },
        },
      ],
    } as any;

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "sessions_list", action: "json", args: {}, sessionKey: "main" }),
    });

    expect(res.status).toBe(404);

    await server.close();
  });
});
