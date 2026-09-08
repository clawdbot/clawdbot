import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";

const mocks = vi.hoisted(() => ({
  getLatest: vi.fn<() => RestartSentinelPayload | null>(),
  refreshLatest: vi.fn<() => Promise<RestartSentinelPayload | null>>(),
  prepare: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("../../../packages/gateway-protocol/src/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../packages/gateway-protocol/src/index.js")
  >("../../../packages/gateway-protocol/src/index.js");
  return {
    ...actual,
    validateUpdateReportParams: () => true,
    validateUpdateReportResult: () => true,
  };
});

vi.mock("../../infra/update-failure-report.js", () => ({
  prepareUpdateFailureReport: mocks.prepare,
  submitUpdateFailureReport: mocks.submit,
}));

vi.mock("../server-restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../server-restart-sentinel.js")>(
    "../server-restart-sentinel.js",
  );
  return {
    ...actual,
    getLatestUpdateRestartSentinel: mocks.getLatest,
    refreshLatestUpdateRestartSentinel: mocks.refreshLatest,
  };
});

const { updateHandlers } = await import("./update.js");

const failure: RestartSentinelPayload = {
  kind: "update",
  status: "error",
  ts: 500,
  stats: {
    handoffId: "handoff-failed",
    mode: "git",
    target: "origin/main@abcdef",
    reason: "build-failed",
    before: { version: "2026.8.1" },
    after: { version: "2026.8.2" },
    steps: [
      {
        name: "build",
        command: "pnpm build --token secret",
        cwd: "/Users/private/openclaw",
        durationMs: 10,
        log: { exitCode: 1, stderrTail: "raw log secret" },
      },
    ],
    durationMs: 20,
    recovery: { serviceRestartSafe: true, version: "2026.8.1" },
  },
};

async function invoke(
  params: Record<string, unknown>,
  hasCurrentClientAuthority: (() => boolean) | null = () => true,
) {
  const respond = vi.fn();
  const handler = updateHandlers["update.report"];
  if (!handler) {
    throw new Error("update.report handler is unavailable");
  }
  await handler({
    ...(hasCurrentClientAuthority ? { hasCurrentClientAuthority } : {}),
    client: { internal: { operatorRoleActor: { kind: "system" } } },
    params,
    respond,
  } as never);
  return respond;
}

describe("update.report", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLatest.mockReturnValue(failure);
    mocks.refreshLatest.mockResolvedValue(failure);
    mocks.prepare.mockResolvedValue({
      attemptId: "handoff-failed",
      body: "sanitized body",
      previewDigest: "a".repeat(64),
      savedReportPath: "/tmp/report.md",
      title: "Update failure",
      url: "https://github.com/openclaw/openclaw/issues/new",
    });
    mocks.submit.mockImplementation(async (...args: unknown[]) => {
      const options = args[2] as {
        hasCurrentAuthority?: () => boolean;
        validateCurrentAttempt?: () => boolean | Promise<boolean>;
      };
      if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
        throw new Error("client authority is stale");
      }
      if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
        return {
          message: "This failed update attempt is stale or unavailable.",
          savedReportPath: "/tmp/report.md",
          status: "stale",
        };
      }
      return {
        savedReportPath: "/tmp/report.md",
        status: "created",
        url: "https://github.com/openclaw/openclaw/issues/123",
      };
    });
  });

  it.each([
    { name: "legacy handoff", runId: undefined, attemptId: "handoff-failed" },
    {
      name: "canonical run",
      runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
  ])(
    "previews a current $name failure without carrying command or log content",
    async ({ runId, attemptId }) => {
      mocks.refreshLatest.mockResolvedValue({
        ...failure,
        stats: { ...failure.stats, ...(runId ? { runId } : {}) },
      });
      const respond = await invoke({ action: "preview", attemptId });

      expect(mocks.prepare).toHaveBeenCalledOnce();
      const input = mocks.prepare.mock.calls[0]?.[0];
      expect(input).toMatchObject({
        attemptId,
        target: "origin/main@abcdef",
        result: {
          status: "error",
          mode: "git",
          recovery: { serviceRestartSafe: true, version: "2026.8.1" },
          steps: [{ name: "build", command: "", cwd: "", exitCode: 1 }],
        },
      });
      expect(JSON.stringify(input)).not.toContain("secret");
      expect(JSON.stringify(input)).not.toContain("/Users/private");
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "ready", previewDigest: "a".repeat(64) }),
      );
      expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("savedReportPath");
    },
  );

  it("preserves advisory classification when projecting persisted update steps", async () => {
    mocks.refreshLatest.mockResolvedValue({
      ...failure,
      stats: {
        ...failure.stats,
        steps: [
          ...(failure.stats?.steps ?? []),
          {
            name: "post-install doctor",
            command: "openclaw doctor",
            durationMs: 5,
            advisory: true,
            log: { exitCode: 86 },
          },
        ],
      },
    });

    await invoke({ action: "preview", attemptId: "handoff-failed" });

    const projected = mocks.prepare.mock.calls[0]?.[0];
    expect(projected).toMatchObject({
      result: {
        steps: [
          { name: "build" },
          {
            name: "post-install doctor",
            advisory: { kind: "package-post-install-doctor" },
          },
        ],
      },
    });
    expect(projected.result.steps[0]).not.toHaveProperty("advisory");
  });

  it("submits only the reviewed digest for the same current attempt", async () => {
    const respond = await invoke({
      action: "submit",
      attemptId: "handoff-failed",
      previewDigest: "a".repeat(64),
    });

    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "handoff-failed" }),
      "a".repeat(64),
      expect.objectContaining({
        hasCurrentAuthority: expect.any(Function),
        validateCurrentAttempt: expect.any(Function),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ status: "created" }));
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("savedReportPath");
  });

  it("rechecks the attempt after preparation and refuses a replacement before submission", async () => {
    mocks.refreshLatest.mockResolvedValueOnce(failure).mockResolvedValueOnce({
      ...failure,
      stats: { ...failure.stats, handoffId: "replacement-attempt" },
    });

    const respond = await invoke({
      action: "submit",
      attemptId: "handoff-failed",
      previewDigest: "a".repeat(64),
    });

    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("stale"),
      }),
    );
  });

  it("refuses submission when client authority closes during report preparation", async () => {
    let authorityCurrent = true;
    mocks.prepare.mockImplementation(async () => {
      authorityCurrent = false;
      return {
        attemptId: "handoff-failed",
        body: "sanitized body",
        previewDigest: "a".repeat(64),
        savedReportPath: "/tmp/report.md",
        title: "Update failure",
        url: "https://github.com/openclaw/openclaw/issues/new",
      };
    });

    const respond = await invoke(
      {
        action: "submit",
        attemptId: "handoff-failed",
        previewDigest: "a".repeat(64),
      },
      () => authorityCurrent,
    );

    expect(mocks.submit).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it.each(["preview", "submit"] as const)(
    "refuses %s without a live authenticated-client guard",
    async (action) => {
      const respond = await invoke(
        {
          action,
          attemptId: "handoff-failed",
          ...(action === "submit" ? { previewDigest: "a".repeat(64) } : {}),
        },
        null,
      );

      expect(mocks.submit).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("authenticated client"),
        }),
      );
    },
  );

  it("rejects a stale update identity before preparing or submitting", async () => {
    const respond = await invoke({ action: "preview", attemptId: "older-handoff" });

    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("stale"),
      }),
    );
  });

  it("rejects successful and non-update sentinels", async () => {
    mocks.refreshLatest.mockResolvedValue({ ...failure, status: "ok" });
    const respond = await invoke({ action: "preview", attemptId: "handoff-failed" });

    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("rejects a classified skipped no-op but allows a skipped terminal failure", async () => {
    mocks.refreshLatest.mockResolvedValue({
      ...failure,
      status: "skipped",
      stats: { ...failure.stats, reason: "already-current" },
    });
    const noop = await invoke({ action: "preview", attemptId: "handoff-failed" });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(noop).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    mocks.refreshLatest.mockResolvedValue({
      ...failure,
      status: "skipped",
      stats: { ...failure.stats, reason: "not-git-install" },
    });
    const failureResponse = await invoke({
      action: "preview",
      attemptId: "handoff-failed",
    });
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(failureResponse).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "ready" }),
    );
  });

  it("uses the canonical sentinel instead of a stale cached attempt", async () => {
    mocks.getLatest.mockReturnValue(failure);
    mocks.refreshLatest.mockResolvedValue({
      ...failure,
      stats: { ...failure.stats, handoffId: "canonical-replacement" },
    });

    const respond = await invoke({ action: "preview", attemptId: "handoff-failed" });

    expect(mocks.getLatest).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("stale"),
      }),
    );
  });
});
