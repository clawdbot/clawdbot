// Node proxy agent tests cover shared Node HTTP(S) proxy agent construction.
import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { createNodeProxyAgent, resolveEnvNodeProxyUrlForTarget } from "./node-proxy-agent.js";

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

describe("resolveEnvNodeProxyUrlForTarget", () => {
  it("rereads proxy and bypass settings for each request", () => {
    const target = new URL("https://api.example.test/v1");
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://proxy.example:8080" };

    expect(resolveEnvNodeProxyUrlForTarget(target, env)?.href).toBe("http://proxy.example:8080/");
    env.NO_PROXY = "example.test";
    expect(resolveEnvNodeProxyUrlForTarget(target, env)).toBeUndefined();
    env.no_proxy = "";
    expect(resolveEnvNodeProxyUrlForTarget(target, env)?.href).toBe("http://proxy.example:8080/");
    env.https_proxy = "";
    expect(resolveEnvNodeProxyUrlForTarget(target, env)).toBeUndefined();
  });

  it("snapshots a URL target before reading bypass settings", () => {
    const target = new URL("wss://original.example/ws");
    const env = {
      HTTPS_PROXY: "http://proxy.example:8080",
      get no_proxy() {
        target.hostname = "changed.example";
        return "original.example:443";
      },
    };

    expect(resolveEnvNodeProxyUrlForTarget(target, env)).toBeUndefined();
    expect(resolveEnvNodeProxyUrlForTarget(target, env)?.href).toBe("http://proxy.example:8080/");
    expect(target.protocol).toBe("wss:");
  });
});

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
