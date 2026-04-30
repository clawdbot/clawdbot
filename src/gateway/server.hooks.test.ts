import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import {
  drainSystemEvents,
  peekSystemEventEntries,
  peekSystemEvents,
} from "../infra/system-events.js";
import { DEDUPE_TTL_MS } from "./server-constants.js";
import {
  cronIsolatedRun,
  installGatewayTestHooks,
  testState,
  withGatewayServer,
  waitForSystemEvent,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const resolveMainKey = () => resolveMainSessionKeyFromConfig();
const HOOK_TOKEN = "hook-secret";
const HOOKS_MAIN_SESSION_KEY = "agent:hooks:main";

afterEach(() => {
  vi.restoreAllMocks();
});

function buildHookJsonHeaders(options?: {
  token?: string | null;
  headers?: Record<string, string>;
}): Record<string, string> {
  const token = options?.token === undefined ? HOOK_TOKEN : options.token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options?.headers,
  };
}

async function postHook(
  port: number,
  path: string,
  body: Record<string, unknown> | string,
  options?: {
    token?: string | null;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: buildHookJsonHeaders(options),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function setMainAndHooksAgents(): void {
  testState.agentsConfig = {
    list: [{ id: "main", default: true }, { id: "hooks" }],
  };
}

function mockIsolatedRunOkOnce(): void {
  cronIsolatedRun.mockClear();
  cronIsolatedRun.mockResolvedValueOnce({
    status: "ok",
    summary: "done",
  });
}

function mockIsolatedRunOk(): void {
  cronIsolatedRun.mockClear();
  cronIsolatedRun.mockResolvedValue({
    status: "ok",
    summary: "done",
  });
}

async function waitForCronIsolatedRuns(count: number, timeoutMs = 2_000): Promise<void> {
  await expect
    .poll(() => cronIsolatedRun.mock.calls.length, { timeout: timeoutMs, interval: 10 })
    .toBe(count);
}

async function postAgentHookWithIdempotency(
  port: number,
  idempotencyKey: string,
  headers?: Record<string, string>,
) {
  const response = await postHook(
    port,
    "/hooks/agent",
    { message: "Do it", name: "Email" },
    { headers: { "Idempotency-Key": idempotencyKey, ...headers } },
  );
  expect(response.status).toBe(200);
  return response;
}

async function expectFirstHookDelivery(
  port: number,
  idempotencyKey: string,
  headers?: Record<string, string>,
) {
  const first = await postAgentHookWithIdempotency(port, idempotencyKey, headers);
  const firstBody = (await first.json()) as { runId?: string };
  expect(firstBody.runId).toBeTruthy();
  await waitForSystemEvent(5_000);
  drainSystemEvents(resolveMainKey());
  return firstBody;
}

async function expectHookAgentSessionRouting(params: {
  port: number;
  requestSessionKey: string;
  expectedSessionKey: string;
}) {
  mockIsolatedRunOkOnce();

  const resAgent = await postHook(params.port, "/hooks/agent", {
    message: "Do it",
    name: "Email",
    agentId: "hooks",
    sessionKey: params.requestSessionKey,
  });
  expect(resAgent.status).toBe(200);
  await waitForSystemEventTexts(HOOKS_MAIN_SESSION_KEY);

  const routedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
    | { sessionKey?: string; job?: { agentId?: string } }
    | undefined;
  expect(routedCall?.job?.agentId).toBe("hooks");
  expect(routedCall?.sessionKey).toBe(params.expectedSessionKey);
  drainSystemEvents(HOOKS_MAIN_SESSION_KEY);
}

async function waitForSystemEventTexts(sessionKey: string, timeoutMs = 2_000) {
  await expect
    .poll(() => peekSystemEventEntries(sessionKey).map((event) => event.text), {
      timeout: timeoutMs,
      interval: 10,
    })
    .not.toHaveLength(0);
  return peekSystemEventEntries(sessionKey).map((event) => event.text);
}

async function writeHookTransformModule(moduleName: string, source: string): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  expect(configPath).toBeTruthy();
  const transformsDir = path.join(path.dirname(configPath!), "hooks", "transforms");
  await fs.mkdir(transformsDir, { recursive: true });
  await fs.writeFile(path.join(transformsDir, moduleName), source, "utf-8");
}

describe("gateway server hooks", () => {
  test("handles auth, wake, and agent flows", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      const resNoAuth = await postHook(port, "/hooks/wake", { text: "Ping" }, { token: null });
      expect(resNoAuth.status).toBe(401);

      const resWake = await postHook(port, "/hooks/wake", { text: "Ping", mode: "next-heartbeat" });
      expect(resWake.status).toBe(200);
      const wakeEvents = await waitForSystemEvent();
      expect(wakeEvents.some((e) => e.includes("Ping"))).toBe(true);
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAgent = await postHook(port, "/hooks/agent", { message: "Do it", name: "Email" });
      expect(resAgent.status).toBe(200);
      const agentEvents = await waitForSystemEvent();
      expect(agentEvents.some((e) => e.includes("Hook Email: done"))).toBe(true);
      const firstCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { payload?: { externalContentSource?: string } };
      };
      expect(firstCall?.job?.payload?.externalContentSource).toBe("webhook");
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAgentModel = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        model: "openai/gpt-4.1-mini",
      });
      expect(resAgentModel.status).toBe(200);
      await waitForSystemEvent();
      const call = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { payload?: { model?: string } };
      };
      expect(call?.job?.payload?.model).toBe("openai/gpt-4.1-mini");
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAgentWithId = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "hooks",
      });
      expect(resAgentWithId.status).toBe(200);
      await waitForSystemEventTexts(HOOKS_MAIN_SESSION_KEY);
      const routedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(routedCall?.job?.agentId).toBe("hooks");
      drainSystemEvents(HOOKS_MAIN_SESSION_KEY);

      mockIsolatedRunOkOnce();
      const resAgentUnknown = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "missing-agent",
      });
      expect(resAgentUnknown.status).toBe(200);
      await waitForSystemEvent();
      const fallbackCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(fallbackCall?.job?.agentId).toBe("main");
      drainSystemEvents(resolveMainKey());

      const resQuery = await postHook(
        port,
        "/hooks/wake?token=hook-secret",
        { text: "Query auth" },
        { token: null },
      );
      expect(resQuery.status).toBe(400);

      const resBadChannel = await postHook(port, "/hooks/agent", {
        message: "Nope",
        channel: "sms",
      });
      expect(resBadChannel.status).toBe(400);
      expect(peekSystemEvents(resolveMainKey()).length).toBe(0);

      const resHeader = await postHook(
        port,
        "/hooks/wake",
        { text: "Header auth" },
        { token: null, headers: { "x-openclaw-token": HOOK_TOKEN } },
      );
      expect(resHeader.status).toBe(200);
      const headerEvents = await waitForSystemEvent();
      expect(headerEvents.some((e) => e.includes("Header auth"))).toBe(true);
      drainSystemEvents(resolveMainKey());

      const resGet = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
        method: "GET",
        headers: { Authorization: "Bearer hook-secret" },
      });
      expect(resGet.status).toBe(405);

      const resBlankText = await postHook(port, "/hooks/wake", { text: " " });
      expect(resBlankText.status).toBe(400);

      const resBlankMessage = await postHook(port, "/hooks/agent", { message: " " });
      expect(resBlankMessage.status).toBe(400);

      const resBadJson = await postHook(port, "/hooks/wake", "{");
      expect(resBadJson.status).toBe(400);
    });
  });

  test("preserves mapped hook provenance across async dispatch", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "gmail" },
          action: "agent",
          messageTemplate: "New email from {{messages[0].from}}",
          sessionKey: "main",
        },
      ],
    };
    setMainAndHooksAgents();

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOkOnce();
      const response = await postHook(port, "/hooks/gmail", {
        source: "gmail",
        messages: [{ id: "msg-1", from: "Ada", subject: "Hello", snippet: "Hi", body: "Body" }],
      });
      expect(response.status).toBe(200);
      await expect
        .poll(() => cronIsolatedRun.mock.calls.length, { timeout: 2_000, interval: 10 })
        .toBe(1);

      const call = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        sessionKey?: string;
        job?: { payload?: { externalContentSource?: string } };
      };
      expect(call?.sessionKey).toBe("main");
      expect(call?.job?.payload?.externalContentSource).toBe("gmail");
      drainSystemEvents(resolveMainKey());
    });
  });

  test("routes explicit-agent hook completion events to the target agent main session", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    setMainAndHooksAgents();

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOkOnce();
      const resAgent = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "hooks",
      });
      expect(resAgent.status).toBe(200);

      const targetEvents = await waitForSystemEventTexts(HOOKS_MAIN_SESSION_KEY);
      expect(targetEvents.some((event) => event.includes("Hook Email: done"))).toBe(true);
      expect(peekSystemEventEntries(resolveMainKey())).toEqual([]);
      drainSystemEvents(HOOKS_MAIN_SESSION_KEY);
    });
  });

  test("hook announcement policy keeps no-deliver success silent without hiding failures", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "mapped-silent" },
          action: "agent",
          messageTemplate: "Mapped: {{payload.subject}}",
          deliver: false,
        },
      ],
    };
    setMainAndHooksAgents();

    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValueOnce({
        status: "ok",
        summary: "done",
        delivered: false,
      });
      const directSilent = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        deliver: false,
      });
      expect(directSilent.status).toBe(200);
      await waitForCronIsolatedRuns(1);
      expect(peekSystemEventEntries(resolveMainKey())).toEqual([]);

      cronIsolatedRun.mockResolvedValueOnce({
        status: "ok",
        summary: "mapped done",
        delivered: false,
      });
      const mappedSilent = await postHook(port, "/hooks/mapped-silent", { subject: "Email" });
      expect(mappedSilent.status).toBe(200);
      await waitForCronIsolatedRuns(2);
      expect(peekSystemEventEntries(resolveMainKey())).toEqual([]);

      cronIsolatedRun.mockResolvedValueOnce({
        status: "error",
        summary: "boom",
        delivered: false,
      });
      const directFailure = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        deliver: false,
      });
      expect(directFailure.status).toBe(200);
      const failureEvents = await waitForSystemEventTexts(resolveMainKey());
      expect(failureEvents).toContain("Hook Email (error): boom");
      drainSystemEvents(resolveMainKey());
    });
  });

  test("hook announcement policy suppresses fallback after attempted delivery", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    setMainAndHooksAgents();

    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValueOnce({
        status: "ok",
        summary: "done",
        delivered: false,
        deliveryAttempted: true,
      });
      const response = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
      });
      expect(response.status).toBe(200);
      await waitForCronIsolatedRuns(1);
      expect(peekSystemEventEntries(resolveMainKey())).toEqual([]);
    });
  });

  test("queues direct and mapped wake payloads as untrusted system events", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "mapped-wake" },
          action: "wake",
          textTemplate: "Mapped wake: {{payload.subject}}",
        },
      ],
    };

    await withGatewayServer(async ({ port }) => {
      const direct = await postHook(port, "/hooks/wake", { text: "Direct wake" });
      expect(direct.status).toBe(200);
      await waitForSystemEvent(5_000);
      expect(peekSystemEventEntries(resolveMainKey())).toEqual([
        expect.objectContaining({
          text: "Direct wake",
          trusted: false,
        }),
      ]);
      drainSystemEvents(resolveMainKey());

      const mapped = await postHook(port, "/hooks/mapped-wake", { subject: "Email" });
      expect(mapped.status).toBe(200);
      await waitForSystemEvent(5_000);
      expect(peekSystemEventEntries(resolveMainKey())).toEqual([
        expect.objectContaining({
          text: "Mapped wake: Email",
          trusted: false,
        }),
      ]);
      drainSystemEvents(resolveMainKey());
    });
  });

  test("rejects request sessionKey unless hooks.allowRequestSessionKey is enabled", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const denied = await postHook(port, "/hooks/agent", {
        message: "Do it",
        sessionKey: "agent:main:dm:u99999",
      });
      expect(denied.status).toBe(400);
      const deniedBody = (await denied.json()) as { error?: string };
      expect(deniedBody.error).toContain("hooks.allowRequestSessionKey");
    });
  });

  test("respects hooks session policy for request + mapping session keys", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
      defaultSessionKey: "hook:ingress",
      mappings: [
        {
          match: { path: "mapped-ok" },
          action: "agent",
          messageTemplate: "Mapped: {{payload.subject}}",
          sessionKey: "hook:mapped:{{payload.id}}",
        },
        {
          match: { path: "mapped-bad" },
          action: "agent",
          messageTemplate: "Mapped: {{payload.subject}}",
          sessionKey: "agent:main:main",
        },
      ],
    };
    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });

      const defaultRoute = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({ message: "No key" }),
      });
      expect(defaultRoute.status).toBe(200);
      await waitForSystemEvent();
      const defaultCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string }
        | undefined;
      expect(defaultCall?.sessionKey).toBe("hook:ingress");
      drainSystemEvents(resolveMainKey());

      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });
      const mappedOk = await fetch(`http://127.0.0.1:${port}/hooks/mapped-ok`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({ subject: "hello", id: "42" }),
      });
      expect(mappedOk.status).toBe(200);
      await waitForSystemEvent();
      const mappedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string }
        | undefined;
      expect(mappedCall?.sessionKey).toBe("hook:mapped:42");
      drainSystemEvents(resolveMainKey());

      const requestBadPrefix = await postHook(port, "/hooks/agent", {
        message: "Bad key",
        sessionKey: "agent:main:main",
      });
      expect(requestBadPrefix.status).toBe(400);

      const mappedBadPrefix = await postHook(port, "/hooks/mapped-bad", { subject: "hello" });
      expect(mappedBadPrefix.status).toBe(400);
    });
  });

  test("enforces templated vs static mapping session keys on /hooks/<mapping>", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowedSessionKeyPrefixes: ["hook:", "hook:gmail:"],
      mappings: [
        {
          match: { path: "mapped-templated" },
          action: "agent",
          messageTemplate: "Mapped: {{payload.subject}}",
          sessionKey: "hook:gmail:{{payload.id}}",
        },
        {
          match: { path: "mapped-static" },
          action: "agent",
          messageTemplate: "Mapped: {{payload.subject}}",
          sessionKey: "hook:gmail:fixed",
        },
      ],
    };

    await withGatewayServer(async ({ port }) => {
      const templated = await postHook(port, "/hooks/mapped-templated", {
        subject: "hello",
        id: "42",
      });
      expect(templated.status).toBe(400);
      const templatedBody = (await templated.json()) as { error?: string };
      expect(templatedBody.error).toContain("hooks.allowRequestSessionKey");
      expect(cronIsolatedRun).not.toHaveBeenCalled();

      mockIsolatedRunOkOnce();
      const staticMapped = await postHook(port, "/hooks/mapped-static", {
        subject: "hello",
      });
      expect(staticMapped.status).toBe(200);
      await waitForSystemEvent();
      const staticCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string }
        | undefined;
      expect(staticCall?.sessionKey).toBe("hook:gmail:fixed");
      drainSystemEvents(resolveMainKey());
    });
  });

  test("treats malformed transform sessionKeySource as templated on /hooks/<mapping>", async () => {
    await writeHookTransformModule(
      "mapped-invalid-session-key-source.mjs",
      [
        "export default () => ({",
        '  kind: "agent",',
        '  message: "Mapped: from transform",',
        '  sessionKey: "hook:gmail:from-transform",',
        '  sessionKeySource: "bogus",',
        "});",
      ].join("\n"),
    );

    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowedSessionKeyPrefixes: ["hook:", "hook:gmail:"],
      mappings: [
        {
          match: { path: "mapped-invalid-session-key-source" },
          action: "agent",
          messageTemplate: "Mapped: {{payload.subject}}",
          transform: { module: "mapped-invalid-session-key-source.mjs" },
        },
      ],
    };

    await withGatewayServer(async ({ port }) => {
      const response = await postHook(port, "/hooks/mapped-invalid-session-key-source", {
        subject: "hello",
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain("hooks.allowRequestSessionKey");
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    });
  });

  test("preserves target-agent prefixes before isolated dispatch", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "agent:"],
    };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      await expectHookAgentSessionRouting({
        port,
        requestSessionKey: "agent:hooks:slack:channel:c123",
        expectedSessionKey: "agent:hooks:slack:channel:c123",
      });
    });
  });

  test("rebinds mismatched agent prefixes to the hook target before isolated dispatch", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "agent:"],
    };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      await expectHookAgentSessionRouting({
        port,
        requestSessionKey: "agent:main:slack:channel:c123",
        expectedSessionKey: "agent:hooks:slack:channel:c123",
      });
    });
  });

  test("rejects rebinding into a session namespace that is not allowlisted", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "agent:main:"],
    };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      const denied = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "hooks",
        sessionKey: "agent:main:slack:channel:c123",
      });
      expect(denied.status).toBe(400);
      const body = (await denied.json()) as { error?: string };
      expect(body.error).toContain("sessionKey must start with one of");
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    });
  });

  test("rejects mapped hook session rebinding into a disallowed target-agent prefix", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "agent:main:"],
      mappings: [
        {
          match: { path: "mapped-rebind-denied" },
          action: "agent",
          agentId: "hooks",
          messageTemplate: "Mapped: {{payload.subject}}",
          sessionKey: "agent:main:slack:channel:c123",
        },
      ],
    };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      const denied = await postHook(port, "/hooks/mapped-rebind-denied", { subject: "hello" });
      expect(denied.status).toBe(400);
      const body = (await denied.json()) as { error?: string };
      expect(body.error).toContain("sessionKey must start with one of");
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    });
  });

  test("dedupes repeated /hooks/agent deliveries by idempotency key", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();
      const firstBody = await expectFirstHookDelivery(port, "hook-idem-1");
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      const second = await postAgentHookWithIdempotency(port, "hook-idem-1");
      const secondBody = (await second.json()) as { runId?: string };
      expect(secondBody.runId).toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);
    });
  });

  test("dedupes hook retries even when trusted-proxy client IP changes", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    expect(configPath).toBeTruthy();
    await fs.writeFile(
      configPath!,
      JSON.stringify({ gateway: { trustedProxies: ["127.0.0.1"] } }, null, 2),
      "utf-8",
    );

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();
      const firstBody = await expectFirstHookDelivery(port, "hook-idem-forwarded", {
        "X-Forwarded-For": "198.51.100.10",
      });
      const second = await postAgentHookWithIdempotency(port, "hook-idem-forwarded", {
        "X-Forwarded-For": "203.0.113.25",
      });
      const secondBody = (await second.json()) as { runId?: string };
      expect(secondBody.runId).toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
    });
  });

  test("does not retain oversized idempotency keys for replay dedupe", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    const oversizedKey = "x".repeat(257);

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();
      await expectFirstHookDelivery(port, oversizedKey);
      await postAgentHookWithIdempotency(port, oversizedKey);
      await waitForSystemEvent();

      expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
    });
  });

  test("expires hook idempotency entries from first delivery time", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();

      const firstNowSpy = vi.spyOn(Date, "now");
      firstNowSpy.mockReturnValue(1_000_000);
      const first = await postAgentHookWithIdempotency(port, "fixed-window-idem");
      firstNowSpy.mockRestore();

      const firstBody = (await first.json()) as { runId?: string };
      expect(firstBody.runId).toBeTruthy();
      await waitForSystemEvent();
      drainSystemEvents(resolveMainKey());

      const secondNowSpy = vi.spyOn(Date, "now");
      secondNowSpy.mockReturnValue(1_000_000 + DEDUPE_TTL_MS - 1);
      const second = await postHook(
        port,
        "/hooks/agent",
        { message: "Do it", name: "Email" },
        { headers: { "Idempotency-Key": "fixed-window-idem" } },
      );
      secondNowSpy.mockRestore();
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { runId?: string };
      expect(secondBody.runId).toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      const thirdNowSpy = vi.spyOn(Date, "now");
      thirdNowSpy.mockReturnValue(1_000_000 + DEDUPE_TTL_MS + 1);
      const third = await postHook(
        port,
        "/hooks/agent",
        { message: "Do it", name: "Email" },
        { headers: { "Idempotency-Key": "fixed-window-idem" } },
      );
      thirdNowSpy.mockRestore();
      expect(third.status).toBe(200);
      const thirdBody = (await third.json()) as { runId?: string };
      expect(thirdBody.runId).toBeTruthy();
      expect(thirdBody.runId).not.toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
    });
  });

  test("enforces hooks.allowedAgentIds for explicit agent routing", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowedAgentIds: ["hooks"],
      mappings: [
        {
          match: { path: "mapped" },
          action: "agent",
          agentId: "main",
          messageTemplate: "Mapped: {{payload.subject}}",
        },
      ],
    };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOkOnce();
      const resNoAgent = await postHook(port, "/hooks/agent", { message: "No explicit agent" });
      expect(resNoAgent.status).toBe(200);
      await waitForSystemEvent();
      const noAgentCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(noAgentCall?.job?.agentId).toBeUndefined();
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAllowed = await postHook(port, "/hooks/agent", {
        message: "Allowed",
        agentId: "hooks",
      });
      expect(resAllowed.status).toBe(200);
      await waitForSystemEventTexts(HOOKS_MAIN_SESSION_KEY);
      const allowedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(allowedCall?.job?.agentId).toBe("hooks");
      drainSystemEvents(HOOKS_MAIN_SESSION_KEY);

      const resDenied = await postHook(port, "/hooks/agent", {
        message: "Denied",
        agentId: "main",
      });
      expect(resDenied.status).toBe(400);
      const deniedBody = (await resDenied.json()) as { error?: string };
      expect(deniedBody.error).toContain("hooks.allowedAgentIds");

      const resMappedDenied = await postHook(port, "/hooks/mapped", { subject: "hello" });
      expect(resMappedDenied.status).toBe(400);
      const mappedDeniedBody = (await resMappedDenied.json()) as { error?: string };
      expect(mappedDeniedBody.error).toContain("hooks.allowedAgentIds");
      expect(peekSystemEvents(resolveMainKey()).length).toBe(0);
    });
  });

  test("denies explicit agentId when hooks.allowedAgentIds is empty", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowedAgentIds: [],
    };
    testState.agentsConfig = {
      list: [{ id: "main", default: true }, { id: "hooks" }],
    };
    await withGatewayServer(async ({ port }) => {
      const resDenied = await postHook(port, "/hooks/agent", {
        message: "Denied",
        agentId: "hooks",
      });
      expect(resDenied.status).toBe(400);
      const deniedBody = (await resDenied.json()) as { error?: string };
      expect(deniedBody.error).toContain("hooks.allowedAgentIds");
      expect(peekSystemEvents(resolveMainKey()).length).toBe(0);
    });
  });

  test("throttles repeated hook auth failures and resets after success", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const firstFail = await postHook(
        port,
        "/hooks/wake",
        { text: "blocked" },
        { token: "wrong" },
      );
      expect(firstFail.status).toBe(401);

      let throttled: Response | null = null;
      for (let i = 0; i < 20; i++) {
        throttled = await postHook(port, "/hooks/wake", { text: "blocked" }, { token: "wrong" });
      }
      expect(throttled?.status).toBe(429);
      expect(throttled?.headers.get("retry-after")).toBeTruthy();

      const allowed = await postHook(port, "/hooks/wake", { text: "auth reset" });
      expect(allowed.status).toBe(200);
      await waitForSystemEvent();
      drainSystemEvents(resolveMainKey());

      const failAfterSuccess = await postHook(
        port,
        "/hooks/wake",
        { text: "blocked" },
        { token: "wrong" },
      );
      expect(failAfterSuccess.status).toBe(401);
    });
  });

  test("rejects non-POST hook requests without consuming auth failure budget", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      let lastGet: Response | null = null;
      for (let i = 0; i < 21; i++) {
        lastGet = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
          method: "GET",
          headers: { Authorization: "Bearer wrong" },
        });
      }
      expect(lastGet?.status).toBe(405);
      expect(lastGet?.headers.get("allow")).toBe("POST");

      const allowed = await postHook(port, "/hooks/wake", { text: "still works" });
      expect(allowed.status).toBe(200);
      await waitForSystemEvent();
      drainSystemEvents(resolveMainKey());
    });
  });
});
