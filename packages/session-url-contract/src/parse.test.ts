import { describe, expect, it } from "vitest";
import { buildControlUiSessionPath } from "./index.js";
import { parseControlUiSessionPath, type ControlUiSessionPathTarget } from "./parse.js";

type ParseCase = readonly [string, string, ControlUiSessionPathTarget, (string | undefined)?];
type BuildCase = readonly [
  Parameters<typeof buildControlUiSessionPath>[0],
  ControlUiSessionPathTarget,
];

describe("parseControlUiSessionPath", () => {
  it.each([
    ["main", "/chat/main", { namespace: "chat", kind: "main", agentId: "main" }],
    [
      "base path",
      "/control/dashboard/OPS-Team",
      { namespace: "dashboard", kind: "main", agentId: "ops-team" },
      "/control",
    ],
    [
      "short ref",
      "/dashboard/main/12345678",
      { namespace: "dashboard", kind: "short", agentId: "main", shortId: "12345678" },
    ],
    [
      "slugged short ref",
      "/chat/wrong/wrong-slug-1234567890AB",
      {
        namespace: "chat",
        kind: "short",
        agentId: "wrong",
        shortId: "1234567890ab",
        slugHint: "wrong-slug",
      },
    ],
    [
      "literal",
      "/chat/main/not-a-short-id",
      {
        namespace: "chat",
        kind: "literal",
        agentId: "main",
        sessionKey: "agent:main:not-a-short-id",
        slugCandidate: "not-a-short-id",
      },
    ],
    [
      "multi-segment literal",
      "/chat/ops/cron/nightly/run/8821",
      {
        namespace: "chat",
        kind: "literal",
        agentId: "ops",
        sessionKey: "agent:ops:cron:nightly:run:8821",
      },
    ],
    [
      "forced literal",
      "/chat/main/~key/release-deadbeef",
      {
        namespace: "chat",
        kind: "literal",
        agentId: "main",
        sessionKey: "agent:main:release-deadbeef",
      },
    ],
    [
      "dot escapes",
      "/chat/main/cron/~dot/~dotdot/run",
      {
        namespace: "chat",
        kind: "literal",
        agentId: "main",
        sessionKey: "agent:main:cron:.:..:run",
      },
    ],
    [
      "tilde escape",
      "/chat/main/channel/~~dot",
      {
        namespace: "chat",
        kind: "literal",
        agentId: "main",
        sessionKey: "agent:main:channel:~dot",
      },
    ],
  ] satisfies readonly ParseCase[])("parses $0", (_name, pathname, expected, basePath) => {
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
    const cases = [
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
          slugHint: "deploy-monitor",
        },
      ],
    ] satisfies readonly BuildCase[];

    for (const [params, expected] of cases) {
      const path = buildControlUiSessionPath(params);
      expect(parseControlUiSessionPath(path ?? "", params.basePath, params.mainKey)).toEqual(
        expected,
      );
    }
  });
});
