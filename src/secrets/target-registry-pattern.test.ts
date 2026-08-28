/** Tests secret target registry pattern compile/match/expand behavior. */
import { describe, expect, it } from "vitest";
import {
  compileTargetRegistryEntry,
  expandPathTokens,
  matchPathTokens,
  materializePathTokens,
} from "./target-registry-pattern.js";

function compilePattern(pathPattern: string, refPathPattern?: string) {
  return compileTargetRegistryEntry({
    id: "test.pattern",
    targetType: "test.pattern",
    configFile: "openclaw.json",
    pathPattern,
    ...(refPathPattern ? { refPathPattern } : {}),
    secretShape: refPathPattern ? "sibling_ref" : "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  });
}

describe("target registry pattern helpers", () => {
  it("matches wildcard and array tokens with stable capture ordering", () => {
    const tokens = compilePattern("agents.list[].memory.search.providers.*.apiKey").pathTokens;
    const match = matchPathTokens(
      ["agents", "list", 2, "memory", "search", "providers", "openai", "apiKey"],
      tokens,
    );

    expect(match).toEqual({
      captures: [2, "openai"],
    });
    expect(
      matchPathTokens(
        ["agents", "list", "2", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
        { allowLegacyArrayString: true },
      ),
    ).toEqual({ captures: [2, "openai"] });
    expect(
      matchPathTokens(
        ["agents", "list", "2", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
    expect(
      matchPathTokens(
        ["agents", "list", "x", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
    expect(
      matchPathTokens(
        ["agents", "list", "02", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
    expect(
      matchPathTokens(
        ["agents", "list", "+2", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
    expect(
      matchPathTokens(
        ["agents", "list", "4294967294", "memory", "search", "providers", "openai", "apiKey"],
        tokens,
      ),
    ).toBeNull();
  });

  it("materializes sibling ref paths from wildcard and array captures", () => {
    const refTokens = compilePattern(
      "agents.list[].memory.search.providers.*.apiKey",
      "agents.list[].memory.search.providers.*.apiKeyRef",
    ).refPathTokens;
    expect(refTokens).toBeDefined();
    expect(materializePathTokens(refTokens ?? [], [1, "anthropic"])).toEqual([
      "agents",
      "list",
      1,
      "memory",
      "search",
      "providers",
      "anthropic",
      "apiKeyRef",
    ]);
    expect(materializePathTokens(refTokens ?? [], ["anthropic"])).toBeNull();
    expect(materializePathTokens(refTokens ?? [], ["1", "anthropic"])).toBeNull();
    expect(materializePathTokens(refTokens ?? [], ["01", "anthropic"])).toBeNull();
    expect(materializePathTokens(refTokens ?? [], ["+1", "anthropic"])).toBeNull();
    expect(materializePathTokens(refTokens ?? [], ["4294967294", "anthropic"])).toBeNull();
  });

  it("matches two wildcard captures in five-segment header paths", () => {
    const tokens = compilePattern("models.providers.*.headers.*").pathTokens;
    const match = matchPathTokens(
      ["models", "providers", "openai", "headers", "x-api-key"],
      tokens,
    );
    expect(match).toEqual({
      captures: ["openai", "x-api-key"],
    });
  });

  it("keeps wildcard record keys distinct from array indices without excluding arrays", () => {
    const tokens = compilePattern("accounts.*.token").pathTokens;

    expect(matchPathTokens(["accounts", "0", "token"], tokens)).toEqual({ captures: ["0"] });
    expect(matchPathTokens(["accounts", 0, "token"], tokens)).toEqual({ captures: [0] });
    expect(
      matchPathTokens(["accounts", 0, "token"], compilePattern("accounts.0.token").pathTokens),
    ).toBeNull();
  });

  it("normalizes legacy numeric strings only for declared array captures", () => {
    const arrayTokens = compilePattern("accounts[].token").pathTokens;
    const wildcardTokens = compilePattern("accounts.*.token").pathTokens;
    const options = { allowLegacyArrayString: true };

    expect(matchPathTokens(["accounts", "0", "token"], arrayTokens)).toBeNull();
    expect(matchPathTokens(["accounts", "0", "token"], arrayTokens, options)).toEqual({
      captures: [0],
    });
    expect(matchPathTokens(["accounts", "0", "token"], wildcardTokens, options)).toEqual({
      captures: ["0"],
    });
    for (const invalid of ["01", "+1", "4294967294"]) {
      expect(matchPathTokens(["accounts", invalid, "token"], arrayTokens, options)).toBeNull();
    }
  });

  it("materializes wildcard sibling ref paths with their original container shape", () => {
    const { pathTokens, refPathTokens } = compilePattern("accounts.*.token", "accounts.*.tokenRef");

    for (const segment of ["0", 0] as const) {
      const matched = matchPathTokens(["accounts", segment, "token"], pathTokens);

      expect(matched).not.toBeNull();
      expect(materializePathTokens(refPathTokens ?? [], matched!.captures)).toEqual([
        "accounts",
        segment,
        "tokenRef",
      ]);
    }
  });

  it("expands wildcard and array patterns over config objects", () => {
    const root = {
      agents: {
        entries: {
          main: { memory: { search: { remote: { apiKey: "a" } } } },
          ops: { memory: { search: { remote: { apiKey: "b" } } } },
        },
      },
      talk: {
        providers: {
          openai: { apiKey: "oa" }, // pragma: allowlist secret
          anthropic: { apiKey: "an" }, // pragma: allowlist secret
        },
      },
    };

    const arrayMatches = expandPathTokens(
      root,
      compilePattern("agents.entries.*.memory.search.remote.apiKey").pathTokens,
    );
    expect(
      arrayMatches.map((entry) => ({
        segments: entry.segments.join("."),
        captures: entry.captures,
        value: entry.value,
      })),
    ).toEqual([
      {
        segments: "agents.entries.main.memory.search.remote.apiKey",
        captures: ["main"],
        value: "a",
      },
      {
        segments: "agents.entries.ops.memory.search.remote.apiKey",
        captures: ["ops"],
        value: "b",
      },
    ]);

    const wildcardMatches = expandPathTokens(
      root,
      compilePattern("talk.providers.*.apiKey").pathTokens,
    );
    expect(
      wildcardMatches
        .map((entry) => ({
          segments: entry.segments.join("."),
          captures: entry.captures,
          value: entry.value,
        }))
        .toSorted((left, right) => left.segments.localeCompare(right.segments)),
    ).toEqual([
      {
        segments: "talk.providers.anthropic.apiKey",
        captures: ["anthropic"],
        value: "an",
      },
      {
        segments: "talk.providers.openai.apiKey",
        captures: ["openai"],
        value: "oa",
      },
    ]);
  });

  it("preserves numeric indices when expanding array and wildcard patterns", () => {
    const root = { accounts: [{ token: "array-secret" }] };

    for (const pattern of ["accounts[].token", "accounts.*.token"]) {
      expect(expandPathTokens(root, compilePattern(pattern).pathTokens)).toEqual([
        {
          segments: ["accounts", 0, "token"],
          captures: [0],
          value: "array-secret",
        },
      ]);
    }
  });
});
