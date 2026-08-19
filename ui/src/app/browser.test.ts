import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-contract.js";
import { resolveControlUiBasePath, resolveControlUiResourceBasePath } from "./browser.ts";

afterEach(() => {
  document.documentElement.removeAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
});

describe("Control UI route and resource bases", () => {
  it("keeps a root resource mount separate from an inferred route namespace", () => {
    document.documentElement.setAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE, "");

    expect(resolveControlUiBasePath("/focus/new")).toBe("/focus");
    expect(resolveControlUiResourceBasePath("/focus/new")).toBe("");
  });

  it("uses a configured Gateway mount for both routes and resources", () => {
    document.documentElement.setAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE, "/openclaw");

    expect(resolveControlUiBasePath("/openclaw/new")).toBe("/openclaw");
    expect(resolveControlUiResourceBasePath("/openclaw/new")).toBe("/openclaw");
  });

  it("retains pathname inference when no Gateway mount is declared", () => {
    expect(resolveControlUiBasePath("/portable/new")).toBe("/portable");
    expect(resolveControlUiResourceBasePath("/portable/new")).toBe("/portable");
  });
});
