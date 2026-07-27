import { describe, expect, it } from "vitest";
import {
  formatValidationErrors,
  messageReportsUnexpectedProperty,
  type ValidationError,
} from "./validation-errors.js";

const makeError = (overrides: Partial<ValidationError>): ValidationError => ({
  keyword: "type",
  instancePath: "",
  schemaPath: "#/",
  params: {},
  message: "validation error",
  ...overrides,
});

describe("formatValidationErrors property-name delimiters", () => {
  it("formats required-property misses with JSON-compatible double quotes", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      params: { missingProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe('at /auth: must have required property "token"');
  });

  it("escapes embedded quotes/backslashes in unexpected-property names as valid JSON tokens", () => {
    const weird = 'weird"key\\path';
    const err = makeError({
      keyword: "additionalProperties",
      params: { additionalProperty: weird },
    });

    const message = formatValidationErrors([err]);
    expect(message).toBe(`at root: unexpected property ${JSON.stringify(weird)}`);
    expect(JSON.parse(message.slice(message.indexOf('"')))).toBe(weird);
  });

  it("escapes embedded quotes/backslashes in required-property names as valid JSON tokens", () => {
    const weird = 'weird"key\\path';
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      params: { missingProperty: weird },
    });

    const message = formatValidationErrors([err]);
    expect(message).toBe(`at /auth: must have required property ${JSON.stringify(weird)}`);
    expect(JSON.parse(message.slice(message.indexOf('"')))).toBe(weird);
  });
});

describe("messageReportsUnexpectedProperty", () => {
  it.each([
    ["legacy single-quoted", "at /auth: unexpected property 'agentRuntimeIdentityToken'"],
    ["JSON-quoted", 'at /auth: unexpected property "agentRuntimeIdentityToken"'],
  ])("matches an unexpected-property rejection in %s form", (_label, message) => {
    expect(messageReportsUnexpectedProperty(message, "agentRuntimeIdentityToken")).toBe(true);
  });

  it("matches the current formatValidationErrors output for the same property", () => {
    const message = formatValidationErrors([
      {
        keyword: "additionalProperties",
        instancePath: "/auth",
        params: { additionalProperty: "timeZone" },
      },
    ]);
    expect(messageReportsUnexpectedProperty(message, "timeZone")).toBe(true);
  });

  it("requires the request context when one is supplied", () => {
    const message = 'invalid cron.list params: at root: unexpected property "compact"';
    expect(messageReportsUnexpectedProperty(message, "compact", "invalid cron.list params")).toBe(
      true,
    );
    expect(messageReportsUnexpectedProperty(message, "compact", "invalid connect params")).toBe(
      false,
    );
  });

  it("does not match a different property or an unrelated failure", () => {
    expect(
      messageReportsUnexpectedProperty('at root: unexpected property "timeZone"', "compact"),
    ).toBe(false);
    expect(messageReportsUnexpectedProperty("must have required property 'token'", "token")).toBe(
      false,
    );
  });
});
