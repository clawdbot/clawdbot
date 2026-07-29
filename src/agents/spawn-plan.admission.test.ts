import { describe, expect, it } from "vitest";
import { resolveChildAdmission, type ChildAdmissionCap } from "./child-admission.js";

type AdmissionParams = Parameters<typeof resolveChildAdmission>[0];
type AnnounceAdmissionParams = Extract<AdmissionParams, { collect: false }>;
type CollectorAdmissionParams = Extract<AdmissionParams, { collect: true }>;

const announce = (
  overrides: Partial<Omit<AnnounceAdmissionParams, "collect">> = {},
): AnnounceAdmissionParams => ({
  collect: false,
  callerDepth: 0,
  maxSpawnDepth: 2,
  activeChildren: 0,
  maxActiveChildren: 5,
  ...overrides,
});

const collector = (
  overrides: Partial<Omit<CollectorAdmissionParams, "collect">> = {},
): CollectorAdmissionParams => ({
  collect: true,
  callerDepth: 0,
  maxSpawnDepth: 2,
  activeChildren: 0,
  maxActiveChildren: 50,
  totalChildren: 0,
  maxTotalChildren: 200,
  ...overrides,
});

const cases: Array<{
  name: string;
  params: AdmissionParams;
  governingCap?: ChildAdmissionCap;
}> = [
  { name: "announce below depth", params: announce({ callerDepth: 1 }) },
  {
    name: "announce at depth",
    params: announce({ callerDepth: 2 }),
    governingCap: "subagents.maxSpawnDepth",
  },
  { name: "collector below depth", params: collector({ callerDepth: 1 }) },
  {
    name: "collector at depth",
    params: collector({ callerDepth: 2 }),
    governingCap: "subagents.maxSpawnDepth",
  },
  { name: "announce below session cap", params: announce({ activeChildren: 4 }) },
  {
    name: "announce at session cap",
    params: announce({ activeChildren: 5 }),
    governingCap: "subagents.maxChildrenPerAgent",
  },
  { name: "collector below live group cap", params: collector({ activeChildren: 49 }) },
  {
    name: "collector at live group cap",
    params: collector({ activeChildren: 50 }),
    governingCap: "tools.swarm.maxChildrenPerGroup",
  },
  { name: "collector below lifetime group cap", params: collector({ totalChildren: 199 }) },
  {
    name: "collector at lifetime group cap",
    params: collector({ totalChildren: 200 }),
    governingCap: "tools.swarm.maxTotalPerGroup",
  },
];

describe("resolveChildAdmission", () => {
  it.each(cases)("decides $name", ({ params, governingCap }) => {
    const result = resolveChildAdmission(params);

    if (!governingCap) {
      expect(result).toEqual({ ok: true });
      return;
    }
    expect(result).toMatchObject({ ok: false, governingCap });
    if (!result.ok) {
      expect(result.error).toContain(governingCap);
    }
  });
});
