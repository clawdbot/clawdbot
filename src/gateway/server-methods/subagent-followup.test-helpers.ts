import { expect } from "vitest";

export function expectSubagentFollowupReactivation(params: {
  replaceSubagentRunAfterSteerMock: unknown;
  broadcastToConnIds: unknown;
  completedRun: unknown;
  childSessionKey: string;
}) {
  expect(params.replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
    previousRunId: "run-old",
    nextRunId: "run-new",
    fallback: params.completedRun,
    runTimeoutSeconds: 0,
  });
  const call = (
    params.broadcastToConnIds as {
      mock?: {
        calls?: Array<
          [
            string,
            {
              sessionKey?: string;
              reason?: string;
              status?: string;
              startedAt?: number;
              endedAt?: number;
            },
            Set<string>,
            { dropIfSlow?: boolean },
          ]
        >;
      };
    }
  ).mock?.calls?.[0];
  expect(call?.[0]).toBe("sessions.changed");
  expect(call?.[1]?.sessionKey).toBe(params.childSessionKey);
  expect(call?.[1]?.reason).toBe("send");
  expect(call?.[1]?.status).toBe("running");
  expect(call?.[1]?.startedAt).toBe(123);
  expect(call?.[1]?.endedAt).toBeUndefined();
  expect(call?.[2]).toEqual(new Set(["conn-1"]));
  expect(call?.[3]).toEqual({ dropIfSlow: true });
}
