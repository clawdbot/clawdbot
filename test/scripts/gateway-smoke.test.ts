import { describe, expect, it } from "vitest";
import { runGatewaySmoke } from "../../scripts/dev/gateway-smoke.js";

describe("gateway-smoke", () => {
  it("closes the websocket client when connect fails", async () => {
    const stderr: string[] = [];
    const methods: string[] = [];
    let closed = 0;

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      {
        createClient: () =>
          ({
            close: () => {
              closed += 1;
            },
            request: async (method: string) => {
              methods.push(method);
              return { error: "bad token", id: "connect", ok: false, type: "res" };
            },
            waitOpen: async () => {},
          }) as never,
        stderr: (message) => {
          stderr.push(message);
        },
        stdout: () => {},
      },
    );

    expect(code).toBe(2);
    expect(closed).toBe(1);
    expect(methods).toEqual(["connect"]);
    expect(stderr).toEqual(["connect failed: bad token"]);
  });
});
