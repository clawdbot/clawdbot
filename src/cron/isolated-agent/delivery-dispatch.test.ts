// Tests cron delivery route session-key selection (#95646 namespace preservation).
import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { selectCronRouteCurrentSessionKey } from "./delivery-dispatch.js";

const job = (sessionKey?: string): CronJob => ({ sessionKey }) as CronJob;
const ISOLATED_RUN_KEY = "agent:main:cron:job-1:run:run-1";

describe("selectCronRouteCurrentSessionKey", () => {
  it("prefers a bound Mattermost private-channel (group) thread session over the isolated run key", () => {
    // The exact #95646 scenario: a recheck cron bound to the inbound group session.
    const bound =
      "agent:main:mattermost:group:mde76yfz8ifgpgag69otk8rw6c:thread:mofm6k3fai8ixyhhna7m4pa43o";
    expect(selectCronRouteCurrentSessionKey(job(bound), ISOLATED_RUN_KEY)).toBe(bound);
  });

  it("prefers bound channel and direct thread sessions too", () => {
    const channel = "agent:main:mattermost:channel:pub999:thread:root1";
    expect(selectCronRouteCurrentSessionKey(job(channel), ISOLATED_RUN_KEY)).toBe(channel);
    const direct = "agent:main:mattermost:direct:user1:thread:root2";
    expect(selectCronRouteCurrentSessionKey(job(direct), ISOLATED_RUN_KEY)).toBe(direct);
  });

  it("falls back to the isolated run key when the job has no bound session", () => {
    expect(selectCronRouteCurrentSessionKey(job(undefined), ISOLATED_RUN_KEY)).toBe(
      ISOLATED_RUN_KEY,
    );
    expect(selectCronRouteCurrentSessionKey(job("   "), ISOLATED_RUN_KEY)).toBe(ISOLATED_RUN_KEY);
  });

  it("falls back to the isolated run key for cron-namespace bindings", () => {
    expect(
      selectCronRouteCurrentSessionKey(job("agent:main:cron:job-2:run:run-2"), ISOLATED_RUN_KEY),
    ).toBe(ISOLATED_RUN_KEY);
  });
});
