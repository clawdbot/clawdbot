// Gateway connection/startup module mocks.
// Provides shared Vitest mocks for connection and startup helper tests.
import { vi, type Mock } from "vitest";

type TestMock<TArgs extends unknown[] = unknown[], TResult = unknown> = Mock<
  (...args: TArgs) => TResult
>;

export const loadConfigMock: TestMock = vi.fn();
export const resolveGatewayPortMock: TestMock = vi.fn();
export const resolveStateDirMock: TestMock<[NodeJS.ProcessEnv], string> = vi.fn(
  (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw",
);
export const resolveConfigPathMock: TestMock<[NodeJS.ProcessEnv, string], string> = vi.fn(
  (env: NodeJS.ProcessEnv, stateDir: string) =>
    env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`,
);
export const pickPrimaryTailnetIPv4Mock: TestMock = vi.fn();
export const pickPrimaryLanIPv4Mock: TestMock = vi.fn();
export const isLoopbackHostMock: TestMock<[string], boolean> = vi.fn((host: string) =>
  /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(?:\.\d{1,3}){3})$/i.test(
    host.trim().replace(/\.+$/, ""),
  ),
);
export const isSecureWebSocketUrlMock: TestMock<
  [string, { allowPrivateWs?: boolean } | undefined],
  boolean
> = vi.fn((url: string, opts?: { allowPrivateWs?: boolean }) => {
  const parsed = new URL(url);
  if (parsed.protocol === "wss:") {
    return true;
  }
  if (parsed.protocol !== "ws:") {
    return false;
  }
  return opts?.allowPrivateWs === true || isLoopbackHostMock(parsed.hostname);
});

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: pickPrimaryTailnetIPv4Mock,
}));
