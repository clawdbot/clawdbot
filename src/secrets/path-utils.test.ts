import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  deletePathStrict,
  getPath,
  setPathCreateStrict,
  setPathExistingStrict,
} from "./path-utils.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function createAgentListConfig(): OpenClawConfig {
  return asConfig({
    agents: {
      list: [{ id: "a" }],
    },
  });
}

describe("secrets path utils", () => {
  it("deletePathStrict compacts arrays via splice", () => {
    const config = asConfig({});
    setPathCreateStrict(config, ["agents", "list"], [{ id: "a" }, { id: "b" }, { id: "c" }]);
    const changed = deletePathStrict(config, ["agents", "list", "1"]);
    expect(changed).toBe(true);
    expect(getPath(config, ["agents", "list"])).toEqual([{ id: "a" }, { id: "c" }]);
  });

  it("getPath returns undefined for invalid array path segment", () => {
    const config = asConfig({
      agents: {
        list: [{ id: "a" }],
      },
    });
    expect(getPath(config, ["agents", "list", "foo"])).toBeUndefined();
    expect(getPath(config, ["agents", "list", "0abc"])).toBeUndefined();
    expect(getPath(config, ["agents", "list", "+0"])).toBeUndefined();
    expect(getPath(config, ["agents", "list", "9007199254740993"])).toBeUndefined();
    expect(getPath(config, ["agents", "list", "4294967294"])).toBeUndefined();
  });

  it("setPathCreateStrict rejects unsafe array path segments", () => {
    const config = createAgentListConfig();

    expect(() =>
      setPathCreateStrict(config, ["agents", "list", "9007199254740993", "id"], "b"),
    ).toThrow(/Invalid array index segment/);
    expect(() => setPathCreateStrict(config, ["agents", "list", "4294967294", "id"], "b")).toThrow(
      /Invalid array index segment/,
    );
    expect(() => setPathCreateStrict(config, ["agents", "list", "+0", "id"], "b")).toThrow(
      /Invalid path shape/,
    );
  });

  it("setPathExistingStrict throws when path does not already exist", () => {
    const config = createAgentListConfig();
    expect(() =>
      setPathExistingStrict(
        config,
        ["agents", "list", "0", "memorySearch", "remote", "apiKey"],
        "x",
      ),
    ).toThrow(/Path segment does not exist/);
  });

  it("setPathExistingStrict updates an existing leaf", () => {
    const config = asConfig({
      talk: {
        apiKey: "old", // pragma: allowlist secret
      },
    });
    const changed = setPathExistingStrict(config, ["talk", "apiKey"], "new");
    expect(changed).toBe(true);
    expect(getPath(config, ["talk", "apiKey"])).toBe("new");
  });

  it("setPathCreateStrict creates missing container segments", () => {
    const config = asConfig({});
    const changed = setPathCreateStrict(config, ["talk", "provider", "apiKey"], "x");
    expect(changed).toBe(true);
    expect(getPath(config, ["talk", "provider", "apiKey"])).toBe("x");
  });

  it("setPathCreateStrict leaves value unchanged when equal", () => {
    const config = asConfig({
      talk: {
        apiKey: "same", // pragma: allowlist secret
      },
    });
    const changed = setPathCreateStrict(config, ["talk", "apiKey"], "same");
    expect(changed).toBe(false);
    expect(getPath(config, ["talk", "apiKey"])).toBe("same");
  });

  it("setPathCreateStrict works on nested config sub-objects", () => {
    const pluginConfig: Record<string, unknown> = {};
    const changed = setPathCreateStrict(pluginConfig, ["webSearch", "mode"], "llm-context");
    expect(changed).toBe(true);
    expect(pluginConfig).toEqual({
      webSearch: {
        mode: "llm-context",
      },
    });
  });
});
