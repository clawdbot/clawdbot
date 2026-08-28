import { describe, expect, it } from "vitest";
import type { CronJob, CronJobCreate } from "../../cron/types.js";
import {
  cronJobMatchesCallerScope,
  cronJobMatchesDeclarationScope,
  readCronCallerScope,
} from "./cron-caller-scope.js";

function createScopedJob(): CronJob {
  return {
    id: "ops-job",
    name: "Ops job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    sessionKey: "agent:ops:main",
    agentId: " ",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "work" },
    state: {},
  };
}

describe("cron caller scope ownership", () => {
  it.each([
    [
      "external channel",
      { turnSourceChannel: " Discord " },
      { kind: "external", channel: "discord" },
    ],
    ["explicit local", { turnSourceLocal: true }, { kind: "local" }],
    ["missing", {}, { kind: "unknown" }],
  ] as const)(
    "stamps %s creator origin without reading the routing key",
    (_label, source, origin) => {
      const scope = readCronCallerScope({
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:main",
            turnSourceAccountId: "work",
            cronToolsAllowCapture: "final-executable-surface",
            cronExecToolTarget: { host: "gateway", ask: "always" },
            ...source,
          },
        },
      } as never);

      expect(scope?.toolsAllowProvenance?.callerOrigin).toEqual(origin);
      expect(scope?.toolsAllowExecTarget).toEqual({
        version: 1,
        host: "gateway",
        ask: "always",
      });
    },
  );

  it("uses a scoped session key before the configured default", () => {
    const job = createScopedJob();

    expect(
      cronJobMatchesCallerScope({
        job,
        callerScope: { kind: "agentTool", agentId: "main", accountId: "default" },
        defaultAgentId: "main",
      }),
    ).toBe(false);
    expect(
      cronJobMatchesCallerScope({
        job,
        callerScope: { kind: "agentTool", agentId: "ops", accountId: "default" },
        defaultAgentId: "main",
      }),
    ).toBe(true);

    const input: CronJobCreate = {
      ...job,
      id: undefined,
      state: undefined,
    };
    expect(
      cronJobMatchesDeclarationScope({
        job,
        input,
        callerScope: undefined,
        defaultAgentId: "main",
      }),
    ).toBe(true);
  });
});
