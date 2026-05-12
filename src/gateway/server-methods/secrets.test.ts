import { describe, expect, it, vi } from "vitest";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
} from "../../test-utils/talk-test-provider.js";
import { createSecretsHandlers } from "./secrets.js";

async function invokeSecretsReload(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  respond: ReturnType<typeof vi.fn>;
}) {
  await params.handlers["secrets.reload"]({
    req: { type: "req", id: "1", method: "secrets.reload" },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as unknown as Parameters<
      ReturnType<typeof createSecretsHandlers>["secrets.reload"]
    >[0]["respond"],
    context: {} as never,
  });
}

async function invokeSecretsResolve(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  respond: ReturnType<typeof vi.fn>;
  commandName: unknown;
  targetIds: unknown;
}) {
  await params.handlers["secrets.resolve"]({
    req: { type: "req", id: "1", method: "secrets.resolve" },
    params: {
      commandName: params.commandName,
      targetIds: params.targetIds,
    },
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as unknown as Parameters<
      ReturnType<typeof createSecretsHandlers>["secrets.resolve"]
    >[0]["respond"],
    context: {} as never,
  });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function expectRespondError(
  respond: ReturnType<typeof vi.fn>,
  expected: { code: string; message?: string },
): void {
  const call = respond.mock.calls.at(0);
  expect(call?.[0]).toBe(false);
  expect(call?.[1]).toBeUndefined();
  const error = requireRecord(call?.[2]);
  expect(error.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(error.message).toBe(expected.message);
  }
}

function expectWarnMessageWith(warn: ReturnType<typeof vi.fn>, text: string): void {
  expect(warn.mock.calls.some(([message]) => String(message).includes(text))).toBe(true);
}

describe("secrets handlers", () => {
  function createHandlers(overrides?: {
    reloadSecrets?: () => Promise<{ warningCount: number }>;
    resolveSecrets?: (params: { commandName: string; targetIds: string[] }) => Promise<{
      assignments: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      diagnostics: string[];
      inactiveRefPaths: string[];
    }>;
    log?: { warn?: (message: string) => void };
  }) {
    const reloadSecrets = overrides?.reloadSecrets ?? (async () => ({ warningCount: 0 }));
    const resolveSecrets =
      overrides?.resolveSecrets ??
      (async () => ({
        assignments: [],
        diagnostics: [],
        inactiveRefPaths: [],
      }));
    return createSecretsHandlers({
      reloadSecrets,
      resolveSecrets,
      log: overrides?.log,
    });
  }

  it("responds with warning count on successful reload", async () => {
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockResolvedValue({ warningCount: 2 }),
    });
    const respond = vi.fn();
    await invokeSecretsReload({ handlers, respond });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 2 });
  });

  it("returns unavailable when reload fails", async () => {
    const warn = vi.fn();
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockRejectedValue(new Error("disk full")),
      log: { warn },
    });
    const respond = vi.fn();
    await invokeSecretsReload({ handlers, respond });
    expectRespondError(respond, {
      code: "UNAVAILABLE",
      message: "secrets.reload failed",
    });
    expectWarnMessageWith(warn, "disk full");
  });

  it("resolves requested command secret assignments from the active snapshot", async () => {
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          value: "sk",
        },
      ],
      diagnostics: ["note"],
      inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
    });
    expect(resolveSecrets).toHaveBeenCalledWith({
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
    });
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      assignments: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          value: "sk",
        },
      ],
      diagnostics: ["note"],
      inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
  });

  it("rejects invalid secrets.resolve params", async () => {
    const handlers = createHandlers();
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "",
      targetIds: "bad",
    });
    expectRespondError(respond, { code: "INVALID_REQUEST" });
  });

  it("rejects secrets.resolve params when targetIds entries are not strings", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey", 12],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: "INVALID_REQUEST",
      message: "invalid secrets.resolve params: targetIds",
    });
  });

  it("rejects unknown secrets.resolve target ids", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["unknown.target"],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: "INVALID_REQUEST",
      message: 'invalid secrets.resolve params: unknown target id "unknown.target"',
    });
  });

  it("returns unavailable when secrets.resolve handler returns an invalid payload shape", async () => {
    const warn = vi.fn();
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [{ path: TALK_TEST_PROVIDER_API_KEY_PATH, pathSegments: [""], value: "sk" }],
      diagnostics: [],
      inactiveRefPaths: [],
    });
    const handlers = createHandlers({ resolveSecrets, log: { warn } });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
    });
    expectRespondError(respond, {
      code: "UNAVAILABLE",
      message: "secrets.resolve failed",
    });
    expectWarnMessageWith(warn, "secrets.resolve returned invalid payload.");
  });

  it("logs error details when secrets.resolve throws", async () => {
    const warn = vi.fn();
    const handlers = createHandlers({
      resolveSecrets: vi.fn().mockRejectedValue(new Error("EACCES: permission denied")),
      log: { warn },
    });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
    });
    expectRespondError(respond, {
      code: "UNAVAILABLE",
      message: "secrets.resolve failed",
    });
    expectWarnMessageWith(warn, "EACCES: permission denied");
  });
});
