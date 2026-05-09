import { beforeEach, describe, expect, test } from "vitest";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
  resetToolPolicyWarningCacheForTest,
} from "./tool-policy-pipeline.js";
import { resolveToolProfilePolicy } from "./tool-policy.js";

type DummyTool = { name: string };

function runAllowlistWarningStep(params: {
  allow: string[];
  label: string;
  suppressUnavailableCoreToolWarning?: boolean;
  suppressUnavailableCoreToolWarningAllowlist?: string[];
}) {
  const warnings: string[] = [];
  const tools = [{ name: "exec" }] as unknown as DummyTool[];
  applyToolPolicyPipeline({
    tools: tools as any,
    toolMeta: () => undefined,
    warn: (msg) => warnings.push(msg),
    steps: [
      {
        policy: { allow: params.allow },
        label: params.label,
        stripPluginOnlyAllowlist: true,
        suppressUnavailableCoreToolWarning: params.suppressUnavailableCoreToolWarning,
        suppressUnavailableCoreToolWarningAllowlist:
          params.suppressUnavailableCoreToolWarningAllowlist,
      },
    ],
  });
  return warnings;
}

describe("tool-policy-pipeline", () => {
  beforeEach(() => {
    resetToolPolicyWarningCacheForTest();
  });

  test("preserves plugin-only allowlists instead of silently stripping them", () => {
    const tools = [{ name: "exec" }, { name: "plugin_tool" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: (t: any) => (t.name === "plugin_tool" ? { pluginId: "foo" } : undefined),
      warn: () => {},
      steps: [
        {
          policy: { allow: ["plugin_tool"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    const names = filtered.map((t) => (t as unknown as DummyTool).name).toSorted();
    expect(names).toEqual(["plugin_tool"]);
  });

  test("warns about unknown allowlist entries", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["wat"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown entries (wat)");
  });

  test("suppresses built-in profile warnings for unavailable gated core tools", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch"],
      label: "tools.profile (coding)",
      suppressUnavailableCoreToolWarningAllowlist: ["apply_patch"],
    });
    expect(warnings).toStrictEqual([]);
  });

  test("still warns for profile steps when explicit alsoAllow entries are present", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch", "browser"],
      label: "tools.profile (coding)",
      suppressUnavailableCoreToolWarningAllowlist: ["apply_patch"],
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown entries (browser)");
    expect(warnings[0]).not.toContain("apply_patch");
    expect(warnings[0]).toContain(
      "shipped core tools but unavailable in the current runtime/provider/model/config",
    );
  });

  test("still warns for explicit allowlists that mention unavailable gated core tools", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch"],
      label: "tools.allow",
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown entries (apply_patch)");
    expect(warnings[0]).toContain(
      "shipped core tools but unavailable in the current runtime/provider/model/config",
    );
    expect(warnings[0]).not.toContain("Allowlist contains only plugin entries");
    expect(warnings[0]).not.toContain("unless the plugin is enabled");
  });

  test("default profile steps suppress unavailable baseline profile entries", () => {
    const warnings: string[] = [];
    const profilePolicy = resolveToolProfilePolicy("coding");
    applyToolPolicyPipeline({
      tools: [{ name: "exec" }] as any,
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      steps: buildDefaultToolPolicyPipelineSteps({
        profile: "coding",
        profilePolicy,
        profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
      }),
    });

    expect(warnings).toStrictEqual([]);
  });

  test("dedupes identical unknown-allowlist warnings across repeated runs", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    const params = {
      tools: tools as any,
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["wat"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    };

    applyToolPolicyPipeline(params);
    applyToolPolicyPipeline(params);

    expect(warnings).toHaveLength(1);
  });

  test("bounds the warning dedupe cache so new warnings still surface", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];

    for (let i = 0; i < 257; i += 1) {
      applyToolPolicyPipeline({
        tools: tools as any,
        toolMeta: () => undefined,
        warn: (msg: string) => warnings.push(msg),
        steps: [
          {
            policy: { allow: [`unknown_${i}`] },
            label: "tools.profile (coding)",
            stripPluginOnlyAllowlist: true,
          },
        ],
      });
    }

    applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["unknown_0"] },
          label: "tools.profile (coding)",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toHaveLength(258);
  });

  test("evicts the oldest warning when the dedupe cache is full", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];

    for (let i = 0; i < 256; i += 1) {
      applyToolPolicyPipeline({
        tools: tools as any,
        toolMeta: () => undefined,
        warn: (msg: string) => warnings.push(msg),
        steps: [
          {
            policy: { allow: [`unknown_${i}`] },
            label: "tools.allow",
            stripPluginOnlyAllowlist: true,
          },
        ],
      });
    }

    warnings.length = 0;

    applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["unknown_256"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        { policy: { allow: ["unknown_0"] }, label: "tools.allow", stripPluginOnlyAllowlist: true },
      ],
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("unknown_0");
  });

  test("applies allowlist filtering when core tools are explicitly listed", () => {
    const tools = [{ name: "exec" }, { name: "process" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(filtered.map((t) => (t as unknown as DummyTool).name)).toEqual(["exec"]);
  });

  test("applies deny filtering after allow filtering", () => {
    const tools = [{ name: "exec" }, { name: "process" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      tools: tools as any,
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec", "process"], deny: ["process"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(filtered.map((t) => (t as unknown as DummyTool).name)).toEqual(["exec"]);
  });
});
