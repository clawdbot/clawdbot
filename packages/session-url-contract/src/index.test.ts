import { describe, expect, it } from "vitest";
import {
  buildControlUiCatalogSessionUrl,
  buildControlUiSessionPath,
  controlUiSessionSlug,
} from "./index.js";
import { buildControlUiCatalogSharePath } from "./share-build.js";

const SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "beam",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const;

type ChatParams = Omit<Parameters<typeof buildControlUiSessionPath>[0], "namespace">;

const UUID_KEY = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const buildChatPath = (params: ChatParams) =>
  buildControlUiSessionPath({ namespace: "chat", ...params });

describe("buildControlUiCatalogSessionUrl", () => {
  it.each([
    {
      label: "root base path",
      agentId: "main",
      basePath: undefined,
      expected: "/chat/main?catalog=beam&host=gateway&thread=beam-1",
    },
    {
      label: "nested base path and non-main agent",
      agentId: "research",
      basePath: "/admin/openclaw/",
      expected: "/admin/openclaw/chat/research?catalog=beam&host=gateway&thread=beam-1",
    },
  ])("builds a canonical URL for $label", ({ agentId, basePath, expected }) => {
    expect(
      buildControlUiCatalogSessionUrl({
        namespace: "chat",
        agentId,
        basePath,
        catalog: "beam",
        host: "gateway",
        thread: "beam-1",
      }),
    ).toBe(expected);
  });

  it("encodes reserved query characters", () => {
    expect(
      buildControlUiCatalogSessionUrl({
        namespace: "dashboard",
        agentId: "main",
        catalog: "claude & codex",
        host: "gateway:local/primary",
        thread: "thread?one=1&two=2",
      }),
    ).toBe(
      "/dashboard/main?catalog=claude+%26+codex&host=gateway%3Alocal%2Fprimary&thread=thread%3Fone%3D1%26two%3D2",
    );
  });

  it.each(["agentId", "catalog", "host", "thread"] as const)(
    "returns null when required $field is empty",
    (field) => {
      expect(
        buildControlUiCatalogSessionUrl({
          namespace: "chat",
          agentId: "main",
          catalog: "beam",
          host: "gateway",
          thread: "beam-1",
          [field]: " ",
        }),
      ).toBeNull();
    },
  );
});

describe("buildControlUiCatalogSharePath", () => {
  it.each([
    ["Fix: upload flow!", "fix-upload-flow-"],
    ["Deploy face deadbeef", "deploy-"],
    ["🦞", ""],
    ["x".repeat(60), `${"x".repeat(48)}-`],
  ])("uses the session title slug for %s", (displayName, prefix) => {
    expect(
      buildControlUiCatalogSharePath({
        shareRoute: SHARE_ROUTE,
        threadId: "0123456789abcdef0123456789abcdef",
        displayName,
      }),
    ).toBe(`/beam/${prefix}0123456789ab`);
  });

  it.each([
    {
      label: "root path",
      basePath: undefined,
      expected: "/beam/0123456789ab",
    },
    {
      label: "nested base path",
      basePath: "/admin/openclaw/",
      expected: "/admin/openclaw/beam/0123456789ab",
    },
  ])("builds a lowercase 12-character share id for $label", ({ basePath, expected }) => {
    expect(
      buildControlUiCatalogSharePath({
        shareRoute: SHARE_ROUTE,
        threadId: "0123456789abcdef0123456789abcdef",
        basePath,
      }),
    ).toBe(expected);
  });

  it("can retain the full id for an unambiguous fallback", () => {
    expect(
      buildControlUiCatalogSharePath({
        shareRoute: SHARE_ROUTE,
        threadId: "0123456789abcdef0123456789abcdef",
        prefixLength: SHARE_ROUTE.fullLength,
      }),
    ).toBe("/beam/0123456789abcdef0123456789abcdef");
  });

  it.each([
    {
      shareRoute: { ...SHARE_ROUTE, routeSegment: "chat" },
      threadId: "0123456789abcdef0123456789abcdef",
    },
    {
      shareRoute: { ...SHARE_ROUTE, routeSegment: "focus" },
      threadId: "0123456789abcdef0123456789abcdef",
    },
    {
      shareRoute: { ...SHARE_ROUTE, routeSegment: "plugin" },
      threadId: "0123456789abcdef0123456789abcdef",
    },
    {
      shareRoute: { ...SHARE_ROUTE, routeSegment: "settings" },
      threadId: "0123456789abcdef0123456789abcdef",
    },
    {
      shareRoute: { ...SHARE_ROUTE, routeSegment: "Beam" },
      threadId: "0123456789abcdef0123456789abcdef",
    },
    {
      shareRoute: { ...SHARE_ROUTE, routeSegment: "beam/extra" },
      threadId: "0123456789abcdef0123456789abcdef",
    },
    { shareRoute: SHARE_ROUTE, threadId: "0123456789ab" },
    { shareRoute: SHARE_ROUTE, threadId: "0123456789ABCDEF0123456789ABCDEF" },
    { shareRoute: SHARE_ROUTE, threadId: "not-hex" },
  ])("rejects invalid catalog share input %#", ({ shareRoute, threadId }) => {
    expect(buildControlUiCatalogSharePath({ shareRoute, threadId })).toBeNull();
  });
});

describe("buildControlUiSessionPath", () => {
  it.each([
    [
      "case-sensitive literal",
      { sessionKey: "Agent:Ops:Matrix:Channel:!Room:Org:Thread:$Event", exactKey: true },
      "/chat/ops/Matrix/Channel/!Room/Org/Thread/%24Event",
    ],
    [
      "opaque catalog",
      { sessionKey: "agent:ops:catalog:fixture:Host:Thread" },
      "/chat/ops/catalog/fixture/Host/Thread",
    ],
    ["scoped main", { sessionKey: "agent:main:main" }, "/chat/main"],
    ["unscoped main", { sessionKey: "main", fallbackAgentId: "research" }, "/chat/research"],
    [
      "configured main",
      { sessionKey: "agent:research:workspace", mainKey: "workspace" },
      "/chat/research",
    ],
    [
      "default main under a configured key",
      { sessionKey: "agent:research:main", mainKey: "workspace" },
      "/chat/research/main",
    ],
    ["global", { sessionKey: "global", fallbackAgentId: "ops" }, "/chat/ops"],
    [
      "global under a configured main key",
      { sessionKey: "global", fallbackAgentId: "ops", mainKey: "workspace", exactKey: true },
      "/chat/ops",
    ],
    [
      "qualified global with a conflicting fallback agent",
      { sessionKey: "agent:research:global", fallbackAgentId: "main" },
      "/chat/research/~key/global",
    ],
    [
      "qualified global under a configured main key",
      { sessionKey: "agent:research:global", mainKey: "workspace" },
      "/chat/research/~key/global",
    ],
    [
      "qualified global casing",
      { sessionKey: "AGENT:RESEARCH:GlObAl" },
      "/chat/research/~key/GlObAl",
    ],
    [
      "global as the configured main key",
      { sessionKey: "agent:research:global", mainKey: "global", exactKey: true },
      "/chat/research",
    ],
    [
      "global as a literal rest prefix",
      { sessionKey: "agent:research:global:notes" },
      "/chat/research/global/notes",
    ],
    [
      "literal segments",
      { sessionKey: "telegram:group:12345", fallbackAgentId: "research" },
      "/chat/research/telegram/group/12345",
    ],
    [
      "dotted segment",
      { sessionKey: "channel:release.js", fallbackAgentId: "research" },
      "/chat/research/channel/release%2Ejs",
    ],
    ["dot escapes", { sessionKey: "agent:main:cron:.:..:run" }, "/chat/main/cron/~dot/~dotdot/run"],
    ["tilde escape", { sessionKey: "agent:main:channel:~dot" }, "/chat/main/channel/~~dot"],
    ["marker escape", { sessionKey: "agent:main:~key" }, "/chat/main/~~key"],
    ["short-id literal", { sessionKey: "agent:main:12345678" }, "/chat/main/~key/12345678"],
    [
      "slug-shaped literal",
      { sessionKey: "agent:main:release-deadbeef" },
      "/chat/main/~key/release-deadbeef",
    ],
    ["UUID", { sessionKey: UUID_KEY }, "/chat/main/12345678"],
    [
      "UUID slug",
      { sessionKey: UUID_KEY, displayName: "Deploy Monitor" },
      "/chat/main/deploy-monitor-12345678",
    ],
    [
      "reserved short ref",
      {
        sessionKey: "agent:main:dashboard:deadbeef-0aaa-4000-8000-000000000001",
        mainKey: "deadbeef",
      },
      "/chat/main/deadbeef0",
    ],
  ] satisfies readonly (readonly [string, ChatParams, string])[])(
    "builds $0",
    (_name, params, expected) => {
      expect(buildChatPath(params)).toBe(expected);
    },
  );

  it.each([
    ["agent:ops:telegram:12345", "/control/dashboard/ops/telegram/12345"],
    ["agent:research:global", "/control/dashboard/research/~key/global"],
  ])("preserves base paths and namespaces for %s", (sessionKey, expected) => {
    expect(
      buildControlUiSessionPath({
        namespace: "dashboard",
        sessionKey,
        basePath: " /control/// ",
      }),
    ).toBe(expected);
  });

  it.each([
    ["OPS_TEAM", "ops_team"],
    ["Research Agent!", "research-agent"],
    ["..", "main"],
    ["Kelvin", "kelvin"],
    ["ſ", "main"],
  ])("normalizes fallback agent %j", (fallbackAgentId, expectedAgentId) => {
    expect(buildChatPath({ sessionKey: "control-link", fallbackAgentId })).toBe(
      `/chat/${expectedAgentId}/control-link`,
    );
  });

  it("normalizes an embedded Unicode long-s through the canonical agent helper", () => {
    expect(buildChatPath({ sessionKey: "agent:AſB:control-link" })).toBe("/chat/a-b/control-link");
  });

  it.each([
    { sessionKey: "", fallbackAgentId: "main" },
    { sessionKey: "telegram:12345" },
    { sessionKey: "agent:main" },
    { sessionKey: "agent::control-link" },
    { sessionKey: "agent:main:" },
    { sessionKey: "agent:main:telegram::12345" },
    { sessionKey: "agent:ops:room::part" },
    { sessionKey: "agent:ops::main" },
    { sessionKey: "agent:ops:cron:" },
  ] satisfies readonly ChatParams[])("rejects invalid input %#", (params) => {
    expect(buildChatPath(params)).toBeNull();
  });

  it("removes trailing hex tokens from UUID display slugs", () => {
    expect(controlUiSessionSlug("Deploy face deadbeef")).toBe("deploy");
    expect(buildChatPath({ sessionKey: UUID_KEY, displayName: "Deploy face deadbeef" })).toBe(
      "/chat/main/deploy-12345678",
    );
  });
});
