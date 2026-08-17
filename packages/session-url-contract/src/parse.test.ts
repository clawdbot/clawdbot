import { describe, expect, it } from "vitest";
import { buildControlUiSessionPath } from "./index.js";
import { parseControlUiSessionPath, type ControlUiSessionPathTarget } from "./parse.js";

type ParseCase = {
  name: string;
  pathname: string;
  expected: ControlUiSessionPathTarget;
  basePath?: string;
};
type BuildCase = readonly [
  Parameters<typeof buildControlUiSessionPath>[0],
  ControlUiSessionPathTarget,
];

describe("parseControlUiSessionPath", () => {
  it.each([
    {
      name: "main",
      pathname: "/chat/main",
      expected: { namespace: "chat", kind: "main", agentId: "main" },
    },
    {
      name: "base path",
      pathname: "/control/dashboard/OPS-Team",
      expected: { namespace: "dashboard", kind: "main", agentId: "ops-team" },
      basePath: "/control",
    },
    {
      name: "short ref",
      pathname: "/dashboard/main/12345678",
      expected: {
        namespace: "dashboard",
        kind: "short",
        agentId: "main",
        shortId: "12345678",
        literalSessionKey: "agent:main:12345678",
      },
    },
    {
      name: "slugged short ref",
      pathname: "/chat/wrong/wrong-slug-1234567890AB",
      expected: {
        namespace: "chat",
        kind: "short",
        agentId: "wrong",
        shortId: "1234567890ab",
        literalSessionKey: "agent:wrong:wrong-slug-1234567890AB",
        slugHint: "wrong-slug",
      },
    },
    {
      name: "literal",
      pathname: "/chat/main/not-a-short-id",
      expected: {
        namespace: "chat",
        kind: "literal",
        agentId: "main",
        sessionKey: "agent:main:not-a-short-id",
        slugCandidate: "not-a-short-id",
      },
    },
    {
      name: "multi-segment literal",
      pathname: "/chat/ops/cron/nightly/run/8821",
      expected: {
        namespace: "chat",
        kind: "literal",
        agentId: "ops",
        sessionKey: "agent:ops:cron:nightly:run:8821",
      },
    },
    {
      name: "forced literal",
      pathname: "/chat/main/~key/release-deadbeef",
      expected: {
        namespace: "chat",
        kind: "literal",
        agentId: "main",
        sessionKey: "agent:main:release-deadbeef",
      },
    },
    {
      name: "dot escapes",
      pathname: "/chat/main/cron/~dot/~dotdot/run",
      expected: {
        namespace: "chat",
        kind: "literal",
        agentId: "main",
        sessionKey: "agent:main:cron:.:..:run",
      },
    },
    {
      name: "tilde escape",
      pathname: "/chat/main/channel/~~dot",
      expected: {
        namespace: "chat",
        kind: "literal",
        agentId: "main",
        sessionKey: "agent:main:channel:~dot",
      },
    },
  ] satisfies readonly ParseCase[])("parses $name", ({ pathname, expected, basePath }) => {
    expect(parseControlUiSessionPath(pathname, basePath)).toEqual(expected);
  });

  it.each(["main", "global", "boot", "sessions"])("keeps reserved %s literal", (reserved) => {
    expect(parseControlUiSessionPath(`/chat/main/${reserved}`)).toMatchObject({
      kind: "literal",
      sessionKey: `agent:main:${reserved}`,
    });
  });

  it("keeps configured and default main keys distinct", () => {
    expect(parseControlUiSessionPath("/chat/research", "", "workspace")).toMatchObject({
      kind: "main",
      agentId: "research",
    });
    for (const key of ["main", "workspace"]) {
      expect(parseControlUiSessionPath(`/chat/research/${key}`, "", "workspace")).toMatchObject({
        kind: "literal",
        sessionKey: `agent:research:${key}`,
      });
    }
  });

  it.each([
    ["%C5%BF", "main"],
    ["%E2%84%AAelvin", "kelvin"],
    ["OPS-Team", "ops-team"],
    ["..%21", "main"],
  ])("normalizes URL agent %s", (encodedAgentId, agentId) => {
    expect(parseControlUiSessionPath(`/chat/${encodedAgentId}`)).toMatchObject({ agentId });
  });

  it.each([
    "/chat/%",
    "/chat/main/%",
    "/chat/main/~key/%",
    "/chat/main/~key",
    "/chat/main/telegram//12345",
    "/other/main",
  ])("rejects malformed or unrelated path %s", (pathname) => {
    expect(parseControlUiSessionPath(pathname)).toBeNull();
  });

  it("round-trips main, literal, and slugged UUID paths", () => {
    const cases: readonly BuildCase[] = [
      [
        { namespace: "chat", sessionKey: "agent:research:workspace", mainKey: "workspace" },
        { namespace: "chat", kind: "main", agentId: "research" },
      ],
      [
        { namespace: "chat", sessionKey: "agent:main:telegram:group:12345" },
        {
          namespace: "chat",
          kind: "literal",
          agentId: "main",
          sessionKey: "agent:main:telegram:group:12345",
        },
      ],
      [
        {
          namespace: "dashboard",
          sessionKey: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
          basePath: "/control",
          displayName: "Deploy Monitor",
        },
        {
          namespace: "dashboard",
          kind: "short",
          agentId: "main",
          shortId: "12345678",
          literalSessionKey: "agent:main:deploy-monitor-12345678",
          slugHint: "deploy-monitor",
        },
      ],
    ];

    for (const [params, expected] of cases) {
      const path = buildControlUiSessionPath(params);
      expect(parseControlUiSessionPath(path ?? "", params.basePath, params.mainKey)).toEqual(
        expected,
      );
    }
  });

  it.each([
    {
      sessionKey: "agent:main:main",
      agentId: "main",
      expected: { namespace: "chat", kind: "main", agentId: "main" },
    },
    {
      sessionKey: "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6",
      agentId: "roboclaw",
      expected: {
        namespace: "chat",
        kind: "literal",
        agentId: "roboclaw",
        sessionKey: "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6",
      },
    },
    {
      sessionKey: "agent:x:telegram:group:12345",
      agentId: "x",
      expected: {
        namespace: "chat",
        kind: "literal",
        agentId: "x",
        sessionKey: "agent:x:telegram:group:12345",
      },
    },
    {
      sessionKey: "agent:x:discord:direct:9",
      agentId: "x",
      expected: {
        namespace: "chat",
        kind: "literal",
        agentId: "x",
        sessionKey: "agent:x:discord:direct:9",
      },
    },
    {
      sessionKey: "agent:x:standup",
      agentId: "x",
      expected: {
        namespace: "chat",
        kind: "literal",
        agentId: "x",
        sessionKey: "agent:x:standup",
      },
    },
    {
      sessionKey: "agent:main:2139bddb-3211-4641-b993-10f619f124e6",
      agentId: "main",
      expected: {
        namespace: "chat",
        kind: "literal",
        agentId: "main",
        sessionKey: "agent:main:2139bddb-3211-4641-b993-10f619f124e6",
      },
    },
  ] satisfies ReadonlyArray<{
    sessionKey: string;
    agentId: string;
    expected: ControlUiSessionPathTarget;
  }>)("parses the tool-composed URL for $sessionKey", ({ sessionKey, agentId, expected }) => {
    const base = "https://gateway.example/control";
    const url =
      sessionKey === "agent:main:main"
        ? `${base}/chat/main`
        : `${base}/chat/${agentId}/~key/${sessionKey
            .slice(`agent:${agentId}:`.length)
            .replaceAll(":", "/")}`;

    expect(parseControlUiSessionPath(new URL(url).pathname, "/control")).toEqual(expected);
  });
});
