import { describe, expect, it } from "vitest";
import {
  reserveChildAdmissionSlot,
  resolveChildAdmission,
  type ChildAdmissionCap,
} from "./child-admission.js";

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

  it("shares pending capacity by controller and releases reservations exactly once", () => {
    let registeredChildren = 0;
    const reserve = (controllerSessionKey = "agent:main:controller") =>
      reserveChildAdmissionSlot({
        controllerSessionKey,
        resolveAdmission: (pendingChildren) =>
          resolveChildAdmission(
            announce({
              activeChildren: registeredChildren + pendingChildren,
              maxActiveChildren: 1,
            }),
          ),
      });
    const first = reserve();
    const otherController = reserve("agent:main:other-controller");
    if (!first.ok || !otherController.ok) {
      throw new Error("Expected independent controller reservations");
    }

    expect(reserve()).toMatchObject({
      ok: false,
      governingCap: "subagents.maxChildrenPerAgent",
    });
    first.release();
    first.release();
    otherController.release();

    const replacement = reserve();
    if (!replacement.ok) {
      throw new Error("Expected released controller capacity");
    }
    registeredChildren += 1;
    replacement.release();
    expect(reserve()).toMatchObject({
      ok: false,
      governingCap: "subagents.maxChildrenPerAgent",
    });
  });

  it("preserves caller-owned fields on both admission outcomes", () => {
    const reserve = (accept: boolean) =>
      reserveChildAdmissionSlot({
        controllerSessionKey: "agent:main:payload-controller",
        resolveAdmission: () =>
          accept
            ? { ok: true as const, maxSpawnDepth: 2 }
            : { ok: false as const, activeChildren: 1 },
      });

    const accepted = reserve(true);
    if (!accepted.ok) {
      throw new Error("Expected accepted child reservation");
    }
    expect(accepted.maxSpawnDepth).toBe(2);
    accepted.release();

    const rejected = reserve(false);
    if (rejected.ok) {
      rejected.release();
      throw new Error("Expected rejected child reservation");
    }
    expect(rejected.activeChildren).toBe(1);
  });
});
