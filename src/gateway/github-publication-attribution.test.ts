import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  BRANCH,
  SESSION_KEY,
  commandCalls,
  createTestGitHubPublicationCoordinator as createGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
} from "./github-publication.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();

describe("Gateway GitHub publication attribution", () => {
  installGitHubPublicationTestHarness();

  it("publishes canonical ordered credit and exactly one final team-session backlink", async () => {
    const config = {
      gateway: { publicOrigin: "https://team.example", controlUi: { basePath: "/control" } },
    };
    mocks.getConfigSnapshot.mockReturnValue({ config, sourceConfig: config });
    mocks.attribution.mockReturnValue({
      trailers: [
        "Co-authored-by: alice <7+alice@users.noreply.github.com>",
        "Co-authored-by: grace <9+grace@users.noreply.github.com>",
      ],
      logins: ["alice", "grace"],
      prompt: "",
    });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "ordered-attribution",
      title: "fix: publish the reconciled fix",
      body: "Detailed proof\n\n## Worked on by\n\n- @untrusted\n\n### Verification notes\n\nKeep this paragraph.\n\n---\n[View the OpenClaw team session](https://untrusted.example/session)",
    });

    expect(result).toMatchObject({ status: "published" });
    expect(commandCalls.find(({ argv }) => argv.includes("commit-tree"))?.input).toBe(
      `fix: publish the reconciled fix\n\nWorked on by:\n- @alice\n- @grace\n\nCo-authored-by: alice <7+alice@users.noreply.github.com>\nCo-authored-by: grace <9+grace@users.noreply.github.com>\nOpenClaw-Publication: ${result.requestId}\n`,
    );
    const post = commandCalls.find(({ argv }) => argv.includes("POST"));
    expect(JSON.parse(post?.input ?? "null")).toEqual({
      title: "fix: publish the reconciled fix",
      body: `Detailed proof\n\n### Verification notes\n\nKeep this paragraph.\n\n## Worked on by\n\n- @alice\n- @grace\n\n<!-- openclaw-publication:${result.requestId} -->\n\n---\n[View the OpenClaw team session](https://team.example/control/chat/main/dashboard/publication)`,
      head: `openclaw:${BRANCH}`,
      base: "main",
      draft: true,
    });
  });

  it("publishes without a session footer when the configured URL is not external HTTPS", async () => {
    const config = { gateway: { publicOrigin: "http://127.0.0.1:18789" } };
    mocks.getConfigSnapshot.mockReturnValue({ config, sourceConfig: config });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "local-session-url",
    });

    expect(result).toMatchObject({ status: "published" });
    const post = commandCalls.find(({ argv }) => argv.includes("POST"));
    expect(JSON.parse(post?.input ?? "null").body).toBe(
      `Published by the Gateway after authoritative workspace reconciliation.\n\n## Worked on by\n\n- @alice\n\n<!-- openclaw-publication:${result.requestId} -->`,
    );
  });
});
