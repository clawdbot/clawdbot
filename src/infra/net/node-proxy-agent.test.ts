// Node proxy agent tests cover shared Node HTTP(S) proxy agent construction.
import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { createNodeProxyAgent } from "./node-proxy-agent.js";

const PROXY_ENV_KEYS = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
] as const;

function withProxyEnv<T>(
  env: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>>,
  fn: () => T,
): T {
  const clearedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, undefined])) as Record<
    (typeof PROXY_ENV_KEYS)[number],
    undefined
  >;
  return withEnv({ ...clearedEnv, ...env }, fn);
}

describe("createNodeProxyAgent", () => {
  it("preserves caller Node agent options on env proxy agents", () => {
    withProxyEnv({ HTTPS_PROXY: "http://proxy.example:8080" }, () => {
      const agent = createNodeProxyAgent({
        mode: "env",
        targetUrl: "https://collector.example.test/v1/traces",
        agentOptions: {
          keepAlive: true,
          ca: "collector-ca",
          cert: "collector-cert",
          key: "collector-key",
        },
      });

      const agentState = agent as
        | {
            options?: {
              keepAlive?: boolean;
              ca?: string;
              cert?: string;
              key?: string;
            };
            keepAlive?: boolean;
          }
        | undefined;
      expect(agentState?.options).toMatchObject({
        keepAlive: true,
        ca: "collector-ca",
        cert: "collector-cert",
        key: "collector-key",
      });
      expect(agentState?.keepAlive).toBe(true);
    });
  });
});
