import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseWorkerSkillResourceGeneration,
  parseWorkerSkillResourceLocator,
  parseWorkerSkillResourceOperation,
  validateWorkerSkillResourceInput,
} from "./skill-resource-protocol.js";

const resourceId = "abcdef0123456789".repeat(2);

describe("worker skill resource locators", () => {
  it.each(["/worker/session/.3.skill-resources-", "C:\\worker\\session\\.3.skill-resources-"])(
    "preserves the remote host path and full inode identity %s",
    (prefix) => {
      const locator = {
        resourceId,
        identity: "1:18446744073709551615",
        root: `${prefix}${resourceId}`,
      };
      expect(parseWorkerSkillResourceLocator(locator)).toEqual(locator);
    },
  );

  it.each([
    { name: "POSIX", paths: path.posix, base: "/worker" },
    { name: "Windows", paths: path.win32, base: "C:\\worker" },
  ])("accepts resource siblings of long valid $name workspaces", ({ paths, base }) => {
    const workspace = paths.join(
      base,
      ...Array.from({ length: 12 }, () => "a".repeat(100)),
      "workspace",
    );
    const locator = {
      resourceId,
      identity: "1:2",
      root: paths.join(
        paths.dirname(workspace),
        `.${Number.MAX_SAFE_INTEGER}.skill-resources-${resourceId}`,
      ),
    };
    expect(workspace.length).toBeLessThanOrEqual(4_096);
    expect(locator.root.length).toBeGreaterThan(1_024);
    expect(parseWorkerSkillResourceLocator(locator)).toEqual(locator);
  });

  it.each([
    { resourceId: "../outside" },
    { resourceId: `${resourceId}\n` },
    { identity: "1:NaN" },
    { identity: "1:2\n" },
    { root: "relative/root" },
    { root: "/tmp/\0outside" },
    { extra: true },
  ])("rejects invalid or open locator %#", (invalid) => {
    expect(() =>
      parseWorkerSkillResourceLocator({
        resourceId,
        identity: "1:2",
        root: `/worker/.3.skill-resources-${resourceId}`,
        ...invalid,
      }),
    ).toThrow("Invalid skill resource location");
  });
});

describe("worker skill resource discovery", () => {
  it("accepts only read-only discovery without caller-selected scope or input", () => {
    const operation = parseWorkerSkillResourceOperation({ operation: "discover" });
    expect(operation).toEqual({ operation: "discover" });
    expect(() => validateWorkerSkillResourceInput(operation, undefined)).not.toThrow();
    expect(() => validateWorkerSkillResourceInput(operation, "")).toThrow(
      "invalid worker skill resource chunk",
    );
    for (const extra of [
      { root: "/tmp" },
      { generation: 2 },
      { resourceId },
      { identity: "1:2" },
    ]) {
      expect(() => parseWorkerSkillResourceOperation({ operation: "discover", ...extra })).toThrow(
        "invalid worker skill resource operation",
      );
    }
  });
});

describe("worker skill resource retention identity", () => {
  it.each([0, 3, Number.MAX_SAFE_INTEGER])("recognizes exact generation %s", (generation) => {
    expect(parseWorkerSkillResourceGeneration(`.${generation}.skill-resources-${resourceId}`)).toBe(
      generation,
    );
  });

  it.each([
    `.03.skill-resources-${resourceId}`,
    `.-1.skill-resources-${resourceId}`,
    `.9007199254740992.skill-resources-${resourceId}`,
    `.3.skill-resources-${resourceId.toUpperCase()}`,
    `.3.skill-resources-short`,
    `.3.skill-resources-${resourceId}\n`,
    `.3.skill-resources-${resourceId}/child`,
    `.3.workspace-transfer-${resourceId}`,
    `3`,
    `.openclaw-worker`,
  ])("does not collect unrelated or ambiguous name %s", (name) => {
    expect(parseWorkerSkillResourceGeneration(name)).toBeUndefined();
  });
});
