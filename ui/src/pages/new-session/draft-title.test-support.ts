import { onTestFinished } from "vitest";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { NewSessionTitleController } from "./draft-title.ts";
import type { NewSessionRouteData } from "./location.ts";
import { TestReactiveControllerHost } from "./reactive-controller-host.test-support.ts";

const DEFAULT_PREPARED_TITLE = "Repair naming";

export function createDraftTitleFixture(
  request = async (_method: string, _params?: unknown): Promise<unknown> => ({
    title: DEFAULT_PREPARED_TITLE,
  }),
  data?: NewSessionRouteData,
  requestOther = async (_method: string, _params?: unknown): Promise<unknown> => ({}),
) {
  const fixture = createDraftFixture({
    data,
    methods: ["sessions.create", "sessions.title.prepare", "worktrees.branches"],
    scopes: ["operator.read", "operator.write", "operator.admin"],
    agents: [
      {
        id: "main",
        workspace: "/workspace",
        workspaceGit: true,
        model: { primary: "test/primary" },
      },
    ],
    request: async (method, params) =>
      method === "sessions.title.prepare"
        ? request(method, params)
        : method === "worktrees.branches"
          ? { repositoryStatus: "git", branches: [], defaultBranch: "main" }
          : requestOther(method, params),
    takePreparedTitle: () => titles.takePreparedTitle(),
  });
  const titles = new NewSessionTitleController(new TestReactiveControllerHost(), () => ({
    context: fixture.context,
    data,
    place: fixture.place,
    submission: fixture.flow,
    dictating: false,
  }));
  titles.hostConnected();
  onTestFinished(() => {
    titles.hostDisconnected();
    fixture.flow.disconnect();
  });
  return { ...fixture, titles };
}
