// Tests cron delivery route session-key selection (#95646 namespace preservation).
import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { selectCronRouteCurrentSessionKey } from "./delivery-route-session-key.js";

const job = (sessionKey?: string): CronJob => ({ sessionKey }) as CronJob;
const ISOLATED_RUN_KEY = "agent:main:cron:job-1:run:run-1";

describe("selectCronRouteCurrentSessionKey", () => {
  it("prefers a bound Mattermost private-channel (group) thread session over the isolated run key", () => {
    // The exact #95646 scenario: a recheck cron bound to the inbound group session.
    const bound =
      "agent:main:mattermost:group:mde76yfz8ifgpgag69otk8rw6c:thread:mofm6k3fai8ixyhhna7m4pa43o";
    expect(
      selectCronRouteCurrentSessionKey(
        job(bound),
        ISOLATED_RUN_KEY,
        "mattermost",
        "channel:mde76yfz8ifgpgag69otk8rw6c",
      ),
    ).toBe(bound);
  });

  it("prefers bound channel and direct thread sessions too", () => {
    const channel = "agent:main:mattermost:channel:pub999:thread:root1";
    expect(
      selectCronRouteCurrentSessionKey(
        job(channel),
        ISOLATED_RUN_KEY,
        "mattermost",
        "channel:pub999",
      ),
    ).toBe(channel);
    const direct = "agent:main:mattermost:direct:user1:thread:root2";
    expect(
      selectCronRouteCurrentSessionKey(job(direct), ISOLATED_RUN_KEY, "mattermost", "user:user1"),
    ).toBe(direct);
  });

  it("keeps the isolated run key when a Mattermost-bound job delivers elsewhere", () => {
    const bound =
      "agent:main:mattermost:group:mde76yfz8ifgpgag69otk8rw6c:thread:mofm6k3fai8ixyhhna7m4pa43o";
    expect(
      selectCronRouteCurrentSessionKey(job(bound), ISOLATED_RUN_KEY, "telegram", "group:-100123"),
    ).toBe(ISOLATED_RUN_KEY);
  });

  it.each([
    ["telegram", "agent:main:telegram:group:-100123:thread:42", "group:-100123"],
    ["signal", "agent:main:signal:direct:15550001111", "user:15550001111"],
    ["discord", "agent:main:discord:channel:channel-123:thread:thread-456", "channel:channel-123"],
  ])("reuses a canonical same-provider %s conversation", (provider, bound, target) => {
    expect(selectCronRouteCurrentSessionKey(job(bound), ISOLATED_RUN_KEY, provider, target)).toBe(
      bound,
    );
  });

  it("rejects a matching-provider conversation bound to a different agent", () => {
    const bound = "agent:other:mattermost:group:private-channel:thread:root";
    expect(
      selectCronRouteCurrentSessionKey(
        job(bound),
        ISOLATED_RUN_KEY,
        "mattermost",
        "channel:private-channel",
      ),
    ).toBe(ISOLATED_RUN_KEY);
  });

  it("rejects a same-provider binding belonging to a different destination peer", () => {
    const bound = "agent:main:mattermost:group:private-channel-a:thread:root-a";
    expect(
      selectCronRouteCurrentSessionKey(
        job(bound),
        ISOLATED_RUN_KEY,
        "mattermost",
        "channel:private-channel-b",
      ),
    ).toBe(ISOLATED_RUN_KEY);
  });

  it("normalizes the selected provider prefix before comparing destination peers", () => {
    const bound = "agent:main:mattermost:group:private-channel:thread:root";
    expect(
      selectCronRouteCurrentSessionKey(
        job(bound),
        ISOLATED_RUN_KEY,
        "mattermost",
        "mattermost:channel:private-channel",
      ),
    ).toBe(bound);
  });

  it("falls back to the isolated run key when the job has no bound session", () => {
    expect(
      selectCronRouteCurrentSessionKey(
        job(undefined),
        ISOLATED_RUN_KEY,
        "mattermost",
        "channel:private-channel",
      ),
    ).toBe(ISOLATED_RUN_KEY);
    expect(
      selectCronRouteCurrentSessionKey(
        job("   "),
        ISOLATED_RUN_KEY,
        "mattermost",
        "channel:private-channel",
      ),
    ).toBe(ISOLATED_RUN_KEY);
  });

  it("falls back to the isolated run key for non-Mattermost and malformed bindings", () => {
    expect(
      selectCronRouteCurrentSessionKey(
        job("agent:main:cron:job-2:run:run-2"),
        ISOLATED_RUN_KEY,
        "mattermost",
        "channel:private-channel",
      ),
    ).toBe(ISOLATED_RUN_KEY);
    expect(
      selectCronRouteCurrentSessionKey(
        job("agent:main:telegram:group:-100123:thread:42"),
        ISOLATED_RUN_KEY,
        "mattermost",
        "channel:private-channel",
      ),
    ).toBe(ISOLATED_RUN_KEY);
    expect(
      selectCronRouteCurrentSessionKey(
        job("agent:main:main"),
        ISOLATED_RUN_KEY,
        "mattermost",
        "channel:private-channel",
      ),
    ).toBe(ISOLATED_RUN_KEY);
    expect(
      selectCronRouteCurrentSessionKey(
        job("agent:main:mattermost:group:peer:unexpected"),
        ISOLATED_RUN_KEY,
        "mattermost",
        "channel:peer",
      ),
    ).toBe(ISOLATED_RUN_KEY);
  });
});
