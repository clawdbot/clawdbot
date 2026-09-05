import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-contract.js";
import { resolveControlUiPaths } from "./browser.ts";

afterEach(() => {
  document.documentElement.removeAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
});

describe("Control UI route and resource bases", () => {
  it("uses a configured Gateway mount for both routes and resources", () => {
    document.documentElement.setAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE, "/openclaw");

    expect(resolveControlUiPaths("/openclaw/new")).toEqual(["/openclaw", "/openclaw"]);
  });

  it("retains pathname inference when no Gateway mount is declared", () => {
    expect(resolveControlUiPaths("/portable/new")).toEqual(["/portable", "/portable"]);
  });
});
