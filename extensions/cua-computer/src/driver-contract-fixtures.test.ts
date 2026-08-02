import { describe, expect, it } from "vitest";
import {
  COMPUTER_ACT_ACTION_FIXTURES,
  CUA_DRIVER_0141_COMPUTER_ACT_PARITY,
  CUA_DRIVER_0141_CONTRACT,
  CUA_DRIVER_0141_CORE_LOCAL_COMPUTER_ACT_ACTIONS,
  CUA_DRIVER_0141_DESKTOP_OPERATIONS,
  CUA_DRIVER_0141_FAILURE_FIXTURES,
  CUA_DRIVER_0141_GENERATION_FIXTURE,
  CUA_DRIVER_0141_MCP_FIXTURES,
  CUA_DRIVER_0141_SDK_DESKTOP_SCOPE,
  CUA_DRIVER_0141_SDK_FIXTURES,
  CUA_DRIVER_0141_UNSUPPORTED_COMPUTER_ACT_ACTIONS,
} from "./driver-contract-fixtures.test-fixtures.js";

describe("cua-driver 0.14.1 computer.act parity fixtures", () => {
  it("pins the released CUA driver identity and SDK desktop-scope representation", () => {
    expect(CUA_DRIVER_0141_CONTRACT).toMatchObject({
      version: "0.14.1",
      releaseTag: "cua-driver-rs-v0.14.1",
      releaseCommit: "41ae29b44b49b68c6e01c934fffbbe74d22e26fb",
      serverName: "cua-driver",
      capabilityVersion: "1",
      schemaVersion: "1",
    });
    expect(CUA_DRIVER_0141_SDK_FIXTURES.click.scope).toBe(CUA_DRIVER_0141_SDK_DESKTOP_SCOPE);
    expect(CUA_DRIVER_0141_SDK_FIXTURES.drag.durationMs).toBe(500n);
    expect(Object.keys(CUA_DRIVER_0141_SDK_FIXTURES)).toEqual(
      CUA_DRIVER_0141_COMPUTER_ACT_PARITY.map(({ sdkMethod }) => sdkMethod),
    );
    expect(CUA_DRIVER_0141_MCP_FIXTURES.desktopState.screenshot_mime_type).toBe("image/png");
  });

  it("freezes driver failures and reconnect generations for later runtime migration", () => {
    expect(CUA_DRIVER_0141_FAILURE_FIXTURES.invalidArguments).toMatchObject({
      isError: true,
      structuredContent: { code: "invalid_arguments", tool: "click" },
    });
    expect(CUA_DRIVER_0141_FAILURE_FIXTURES.refusal).toMatchObject({
      isError: true,
      structuredContent: { code: "desktop_unavailable" },
    });
    expect(typeof CUA_DRIVER_0141_GENERATION_FIXTURE.initial).toBe("string");
    expect(CUA_DRIVER_0141_GENERATION_FIXTURE.reconnected).not.toBe(
      CUA_DRIVER_0141_GENERATION_FIXTURE.initial,
    );
  });

  it("classifies every frozen desktop operation and computer action exactly once", () => {
    const operations = CUA_DRIVER_0141_COMPUTER_ACT_PARITY.map(({ operation }) => operation);
    expect(new Set(operations).size).toBe(operations.length);
    expect(new Set(operations)).toEqual(new Set(CUA_DRIVER_0141_DESKTOP_OPERATIONS));

    const classifiedActions = [
      ...CUA_DRIVER_0141_COMPUTER_ACT_PARITY.flatMap(({ computerActions }) => computerActions),
      ...CUA_DRIVER_0141_UNSUPPORTED_COMPUTER_ACT_ACTIONS,
      ...CUA_DRIVER_0141_CORE_LOCAL_COMPUTER_ACT_ACTIONS,
    ];
    expect(classifiedActions).toHaveLength(COMPUTER_ACT_ACTION_FIXTURES.length);
    expect(new Set(classifiedActions).size).toBe(COMPUTER_ACT_ACTION_FIXTURES.length);
    expect(new Set(classifiedActions)).toEqual(new Set(COMPUTER_ACT_ACTION_FIXTURES));
  });

  it("keeps the existing model-facing projection narrow", () => {
    expect(
      CUA_DRIVER_0141_COMPUTER_ACT_PARITY.filter(
        ({ disposition }) => disposition === "computer.act",
      ).map(({ operation }) => operation),
    ).toEqual(["click", "drag", "move_cursor", "scroll", "type_text", "press_key"]);
    expect(
      CUA_DRIVER_0141_COMPUTER_ACT_PARITY.filter(
        ({ disposition }) => disposition === "not projected",
      ).map(({ operation }) => operation),
    ).toEqual(["get_cursor_position", "hotkey"]);
  });
});
