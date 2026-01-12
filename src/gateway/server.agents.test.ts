import { describe, expect, test } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway server agents", () => {
  test("lists configured agents via agents.list RPC", async () => {
    testState.agentsConfig = {
      list: [
        { id: "work", name: "Work", default: true },
        { id: "home", name: "Home" },
      ],
    };

    const { ws } = await startServerWithClient();
    const hello = await connectOk(ws);
    expect(
      (hello as unknown as { features?: { methods?: string[] } }).features
        ?.methods,
    ).toEqual(expect.arrayContaining(["agents.list"]));

    const res = await rpcReq<{
      defaultId: string;
      mainKey: string;
      scope: string;
      agents: Array<{ id: string; name?: string }>;
    }>(ws, "agents.list", {});

    expect(res.ok).toBe(true);
    expect(res.payload?.defaultId).toBe("work");
    expect(res.payload?.mainKey).toBe("main");
    expect(res.payload?.scope).toBe("per-sender");
    expect(res.payload?.agents.map((agent) => agent.id)).toEqual([
      "work",
      "home",
      "main",
    ]);
    const work = res.payload?.agents.find((agent) => agent.id === "work");
    const home = res.payload?.agents.find((agent) => agent.id === "home");
    expect(work?.name).toBe("Work");
    expect(home?.name).toBe("Home");
  });
});
