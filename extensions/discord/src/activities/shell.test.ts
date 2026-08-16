// Discord Activity shell tests execute the generated browser script against controlled fetches.
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { DISCORD_ACTIVITY_SHELL_JS } from "./shell.js";

const TOKEN_REQUEST_TIMEOUT_MS = 35_000;
const WIDGET_REQUEST_TIMEOUT_MS = 20_000;

class TestElement {
  className = "";
  textContent = "";
  readonly children: TestElement[] = [];

  set innerHTML(value: string) {
    if (value === "") {
      this.children.length = 0;
    }
  }

  append(...children: TestElement[]) {
    this.children.push(...children);
  }
}

function readStatusHeading(app: TestElement): string | undefined {
  return app.children[0]?.children[0]?.textContent;
}

type HungRequest = {
  request: "token" | "widget";
  phase: "fetch" | "body";
};

async function executeShellWithHungRequest(hung: HungRequest) {
  const app = new TestElement();
  const document = {
    querySelector: (selector: string) => (selector === "#app" ? app : null),
    createElement: () => new TestElement(),
  };
  const window = {
    location: {
      hostname: "123456.discordsays.com",
      origin: "https://123456.discordsays.com",
    },
  };
  class DiscordSDK {
    customId = "widget-1";
    instanceId = "instance-1";
    commands = {
      authorize: async () => ({ code: "discord-code" }),
      authenticate: async () => ({}),
    };

    async ready() {}
  }

  let timeoutCallback: (() => void) | undefined;
  const clearTimeoutMock = vi.fn(() => {
    timeoutCallback = undefined;
  });
  const setTimeoutMock = vi.fn((callback: () => void) => {
    timeoutCallback = callback;
    return 1;
  });
  const stallUntilAbort = (signal: AbortSignal | null | undefined, message: string) =>
    new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error(message)), { once: true });
    });
  let fetchCall = 0;
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
    fetchCall += 1;
    if (hung.request === "widget" && fetchCall === 1) {
      return Response.json({ access_token: "access", session_token: "session" });
    }
    const signal = init?.signal;
    if (hung.phase === "fetch") {
      return await stallUntilAbort(signal, "request aborted");
    }
    const response = Response.json({});
    response.json = async () => await stallUntilAbort(signal, "body aborted");
    return response;
  });

  const source = DISCORD_ACTIVITY_SHELL_JS.replace(
    'import { DiscordSDK } from "./vendor/embedded-app-sdk.mjs";\n\n',
    "",
  );
  runInNewContext(source, {
    AbortController,
    // Discord mobile/web clients may not expose the Baseline 2024 static helper.
    AbortSignal: {},
    DiscordSDK,
    Response,
    URL,
    URLSearchParams,
    clearTimeout: clearTimeoutMock,
    document,
    fetch: fetchMock,
    setTimeout: setTimeoutMock,
    window,
  });

  const expectedRequestCount = hung.request === "token" ? 1 : 2;
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(expectedRequestCount));
  expect(timeoutCallback).toBeTypeOf("function");
  timeoutCallback?.();
  await vi.waitFor(() => expect(readStatusHeading(app)).toBe("Gateway offline"));
  return { clearTimeoutMock, fetchMock, setTimeoutMock };
}

describe("Discord Activity shell request deadlines", () => {
  it.each([
    { request: "token", phase: "fetch", timeoutMs: TOKEN_REQUEST_TIMEOUT_MS },
    { request: "token", phase: "body", timeoutMs: TOKEN_REQUEST_TIMEOUT_MS },
    { request: "widget", phase: "fetch", timeoutMs: WIDGET_REQUEST_TIMEOUT_MS },
    { request: "widget", phase: "body", timeoutMs: WIDGET_REQUEST_TIMEOUT_MS },
  ] as const)("bounds a hung $request $phase", async ({ request, phase, timeoutMs }) => {
    const { clearTimeoutMock, fetchMock, setTimeoutMock } = await executeShellWithHungRequest({
      request,
      phase,
    });
    const expectedRequestCount = request === "token" ? 1 : 2;

    expect(fetchMock).toHaveBeenCalledTimes(expectedRequestCount);
    expect(setTimeoutMock).toHaveBeenCalledTimes(expectedRequestCount);
    expect(setTimeoutMock).toHaveBeenLastCalledWith(expect.any(Function), timeoutMs);
    expect(clearTimeoutMock).toHaveBeenCalledTimes(expectedRequestCount);
  });
});
