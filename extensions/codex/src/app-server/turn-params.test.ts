import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import { buildTurnStartParams } from "./turn-params.js";

afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
});

describe("buildTurnStartParams temporal context", () => {
  it("uses the configured user timezone on every turn without changing cron input", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T00:30:00.000Z"));
    const params = createParams("/tmp/session.jsonl", "/repo", {
      agents: { defaults: { userTimezone: "America/Los_Angeles" } },
    });
    params.provider = "openai";
    params.modelId = "gpt-5.4";
    params.prompt = "run exactly";
    params.trigger = "cron";
    params.bootstrapContextMode = "lightweight";
    params.bootstrapContextRunKind = "cron";
    params.startedAtMs = Date.parse("2026-09-01T00:30:00.000Z");
    const options = {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions(),
      sessionStatusAvailable: true,
    };

    const firstTurn = buildTurnStartParams(params, options);
    expect(firstTurn.input).toEqual([{ type: "text", text: "run exactly", text_elements: [] }]);
    expect(firstTurn.additionalContext).toEqual({
      openclaw_temporal_context: {
        kind: "application",
        value:
          "## Temporal Context\nCurrent date: 2026-09-01\nTime zone: America/Los_Angeles\nFor the exact current time, use `session_status`.",
      },
    });

    clock.mockReturnValue(Date.parse("2026-09-03T00:30:00.000Z"));
    const nextTurn = buildTurnStartParams(params, options);
    expect(nextTurn.input).toEqual(firstTurn.input);
    expect(nextTurn.additionalContext?.openclaw_temporal_context?.value).toContain(
      "Current date: 2026-09-02",
    );
  });

  it("emits the host fallback after a timezone override is removed", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T00:30:00.000Z"));
    const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || "UTC";
    const options = {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions(),
      sessionStatusAvailable: false,
    };
    const configured = buildTurnStartParams(
      createParams("/tmp/session.jsonl", "/repo", {
        agents: { defaults: { userTimezone: "America/Los_Angeles" } },
      }),
      options,
    );
    const fallback = buildTurnStartParams(createParams("/tmp/session.jsonl", "/repo"), options);

    expect(configured.additionalContext?.openclaw_temporal_context?.value).toContain(
      "Current date: 2026-09-01",
    );
    expect(fallback.additionalContext?.openclaw_temporal_context?.value).toContain(
      `Time zone: ${hostTimezone}`,
    );
    expect(fallback.additionalContext?.openclaw_temporal_context?.value).not.toContain(
      "America/Los_Angeles",
    );
  });
});
