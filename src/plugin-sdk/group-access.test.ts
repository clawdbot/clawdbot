import { describe, expect, it } from "vitest";
import {
  evaluateGroupRouteAccessForPolicy,
  evaluateMatchedGroupAccessForPolicy,
  evaluateSenderGroupAccess,
  evaluateSenderGroupAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "./group-access.js";

describe("resolveSenderScopedGroupPolicy", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof resolveSenderScopedGroupPolicy>[0];
    expected: ReturnType<typeof resolveSenderScopedGroupPolicy>;
  }> = [
    {
      name: "preserves disabled policy",
      input: {
        groupPolicy: "disabled",
        groupAllowFrom: ["a"],
      },
      expected: "disabled",
    },
    {
      name: "keeps allowlist policy when sender allowlist is present",
      input: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["a"],
      },
      expected: "allowlist",
    },
    {
      name: "maps allowlist to open when sender allowlist is empty",
      input: {
        groupPolicy: "allowlist",
        groupAllowFrom: [],
      },
      expected: "open",
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(resolveSenderScopedGroupPolicy(input)).toBe(expected);
  });
});

describe("evaluateSenderGroupAccessForPolicy", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof evaluateSenderGroupAccessForPolicy>[0];
    expected: ReturnType<typeof evaluateSenderGroupAccessForPolicy>;
  }> = [
    {
      name: "blocks disabled policy",
      input: {
        groupPolicy: "disabled",
        groupAllowFrom: ["123"],
        senderId: "123",
        isSenderAllowed: () => true,
      },
      expected: {
        allowed: false,
        reason: "disabled",
        groupPolicy: "disabled",
        providerMissingFallbackApplied: false,
      },
    },
    {
      name: "blocks allowlist with empty list",
      input: {
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        senderId: "123",
        isSenderAllowed: () => true,
      },
      expected: {
        allowed: false,
        reason: "empty_allowlist",
        groupPolicy: "allowlist",
        providerMissingFallbackApplied: false,
      },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(evaluateSenderGroupAccessForPolicy(input)).toEqual(expected);
  });
});

describe("evaluateGroupRouteAccessForPolicy", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof evaluateGroupRouteAccessForPolicy>[0];
    expected: ReturnType<typeof evaluateGroupRouteAccessForPolicy>;
  }> = [
    {
      name: "blocks disabled policy",
      input: {
        groupPolicy: "disabled",
        routeAllowlistConfigured: true,
        routeMatched: true,
        routeEnabled: true,
      },
      expected: {
        allowed: false,
        groupPolicy: "disabled",
        reason: "disabled",
      },
    },
    {
      name: "blocks allowlist without configured routes",
      input: {
        groupPolicy: "allowlist",
        routeAllowlistConfigured: false,
        routeMatched: false,
      },
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "empty_allowlist",
      },
    },
    {
      name: "blocks unmatched allowlist route",
      input: {
        groupPolicy: "allowlist",
        routeAllowlistConfigured: true,
        routeMatched: false,
      },
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "route_not_allowlisted",
      },
    },
    {
      name: "blocks disabled matched route even when group policy is open",
      input: {
        groupPolicy: "open",
        routeAllowlistConfigured: true,
        routeMatched: true,
        routeEnabled: false,
      },
      expected: {
        allowed: false,
        groupPolicy: "open",
        reason: "route_disabled",
      },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(evaluateGroupRouteAccessForPolicy(input)).toEqual(expected);
  });
});

describe("evaluateMatchedGroupAccessForPolicy", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof evaluateMatchedGroupAccessForPolicy>[0];
    expected: ReturnType<typeof evaluateMatchedGroupAccessForPolicy>;
  }> = [
    {
      name: "blocks disabled policy",
      input: {
        groupPolicy: "disabled",
        allowlistConfigured: true,
        allowlistMatched: true,
      },
      expected: {
        allowed: false,
        groupPolicy: "disabled",
        reason: "disabled",
      },
    },
    {
      name: "blocks allowlist without configured entries",
      input: {
        groupPolicy: "allowlist",
        allowlistConfigured: false,
        allowlistMatched: false,
      },
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "empty_allowlist",
      },
    },
    {
      name: "blocks allowlist when required match input is missing",
      input: {
        groupPolicy: "allowlist",
        requireMatchInput: true,
        hasMatchInput: false,
        allowlistConfigured: true,
        allowlistMatched: false,
      },
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "missing_match_input",
      },
    },
    {
      name: "blocks unmatched allowlist sender",
      input: {
        groupPolicy: "allowlist",
        allowlistConfigured: true,
        allowlistMatched: false,
      },
      expected: {
        allowed: false,
        groupPolicy: "allowlist",
        reason: "not_allowlisted",
      },
    },
    {
      name: "allows open policy",
      input: {
        groupPolicy: "open",
        allowlistConfigured: false,
        allowlistMatched: false,
      },
      expected: {
        allowed: true,
        groupPolicy: "open",
        reason: "allowed",
      },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(evaluateMatchedGroupAccessForPolicy(input)).toEqual(expected);
  });
});

describe("evaluateSenderGroupAccess", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof evaluateSenderGroupAccess>[0];
    expected: ReturnType<typeof evaluateSenderGroupAccess>;
  }> = [
    {
      name: "defaults missing provider config to allowlist",
      input: {
        providerConfigPresent: false,
        configuredGroupPolicy: undefined,
        defaultGroupPolicy: "open",
        groupAllowFrom: ["123"],
        senderId: "123",
        isSenderAllowed: () => true,
      },
      expected: {
        allowed: true,
        groupPolicy: "allowlist",
        providerMissingFallbackApplied: true,
        reason: "allowed",
      },
    },
    {
      name: "blocks disabled policy",
      input: {
        providerConfigPresent: true,
        configuredGroupPolicy: "disabled",
        defaultGroupPolicy: "open",
        groupAllowFrom: ["123"],
        senderId: "123",
        isSenderAllowed: () => true,
      },
      expected: {
        allowed: false,
        reason: "disabled",
        groupPolicy: "disabled",
        providerMissingFallbackApplied: false,
      },
    },
    {
      name: "blocks allowlist with empty list",
      input: {
        providerConfigPresent: true,
        configuredGroupPolicy: "allowlist",
        defaultGroupPolicy: "open",
        groupAllowFrom: [],
        senderId: "123",
        isSenderAllowed: () => true,
      },
      expected: {
        allowed: false,
        reason: "empty_allowlist",
        groupPolicy: "allowlist",
        providerMissingFallbackApplied: false,
      },
    },
    {
      name: "blocks sender not allowlisted",
      input: {
        providerConfigPresent: true,
        configuredGroupPolicy: "allowlist",
        defaultGroupPolicy: "open",
        groupAllowFrom: ["123"],
        senderId: "999",
        isSenderAllowed: () => false,
      },
      expected: {
        allowed: false,
        reason: "sender_not_allowlisted",
        groupPolicy: "allowlist",
        providerMissingFallbackApplied: false,
      },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(evaluateSenderGroupAccess(input)).toEqual(expected);
  });
});
