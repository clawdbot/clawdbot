import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import { ensureProfileForTailscaleIdentity, syncGitHubIdentity } from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function stateOptions() {
  const directory = tempDirs.make("openclaw-user-profiles-unicode-");
  return { path: join(directory, "openclaw.sqlite") };
}

it("keeps Tailscale and GitHub display names valid at the UTF-16 limit", () => {
  const options = stateOptions();
  const prefix = "x".repeat(255);
  const tailscale = ensureProfileForTailscaleIdentity(
    { login: "tailscale-proof@github", name: `${prefix}🤖` },
    options,
  );
  const github = syncGitHubIdentity(
    {
      identity: {
        accountId: 42,
        login: "github-proof",
        name: `${prefix}🤖`,
      },
      authenticationAlias: { kind: "github-login", login: "github-proof" },
    },
    options,
  );

  expect(tailscale.displayName).toBe(prefix);
  expect(github.displayName).toBe(prefix);
});
