import { describe, expect, it } from "vitest";
import {
  CORE_READINESS_SUBJECT_REFS,
  createGatewayReadinessIdentity,
  createPluginReadinessSubjectCollection,
  reconcileReadinessIdentity,
} from "./subjects.js";

describe("readiness subjects", () => {
  it("keeps one Gateway identity stable and creates a new identity for another lifecycle", () => {
    const first = createGatewayReadinessIdentity({ createInstanceId: () => "gateway-1" });
    const second = createGatewayReadinessIdentity({ createInstanceId: () => "gateway-2" });

    expect(first.subjects.find((subject) => subject.ref === first.producerRef)?.id).toBe(
      "gateway-1",
    );
    expect(second.subjects.find((subject) => subject.ref === second.producerRef)?.id).toBe(
      "gateway-2",
    );
  });

  it("accepts one host-supplied identity for the Gateway lifecycle", () => {
    const identity = createGatewayReadinessIdentity({
      env: { OPENCLAW_INSTANCE_ID: "pod-7/restart-2" },
    });

    expect(identity.subjects.find((subject) => subject.ref === identity.producerRef)?.id).toBe(
      "pod-7/restart-2",
    );
  });

  it("namespaces plugin subjects and reconciles equal declarations", () => {
    const collection = createPluginReadinessSubjectCollection({
      pluginId: "storage",
      criterionId: "backend",
    });
    const first = collection.collector.declare({
      kind: "backend",
      key: "primary",
      identity: { id: "account-7", generation: "config-42" },
    });
    const second = collection.collector.declare({
      kind: "backend",
      key: "primary",
      identity: { id: "account-7", generation: "config-42" },
    });

    expect(first).toBe("plugin.storage/backend/primary");
    expect(second).toBe(first);
    expect(collection.subjects.filter((subject) => subject.ref === first)).toHaveLength(1);
  });

  it("rejects conflicting plugin declarations", () => {
    const collection = createPluginReadinessSubjectCollection({
      pluginId: "storage",
      criterionId: "backend",
    });
    collection.collector.declare({ kind: "backend", key: "primary", identity: { id: "one" } });

    expect(() =>
      collection.collector.declare({
        kind: "backend",
        key: "primary",
        identity: { id: "two" },
      }),
    ).toThrow("conflicting plugin readiness subject declaration");
  });

  it("rejects plugin subjects parented to another plugin namespace", () => {
    const collection = createPluginReadinessSubjectCollection({
      pluginId: "storage",
      criterionId: "backend",
    });

    expect(() =>
      collection.collector.declare({
        kind: "backend",
        key: "primary",
        parentRef: "plugin.other/runtime/default",
      }),
    ).toThrow("invalid plugin readiness subject parent");
  });

  it("rejects an undeclared parent in the plugin namespace", () => {
    const collection = createPluginReadinessSubjectCollection({
      pluginId: "storage",
      criterionId: "backend",
    });

    expect(() =>
      collection.collector.declare({
        kind: "replica",
        key: "secondary",
        parentRef: "plugin.storage/backend/primary",
      }),
    ).toThrow("unresolved plugin readiness subject parent");
  });

  it("enriches a core placeholder with compatible owner identity", () => {
    const base = createGatewayReadinessIdentity({ instanceId: "gateway-1" });
    const identity = reconcileReadinessIdentity({
      base,
      subjects: [
        {
          ref: CORE_READINESS_SUBJECT_REFS.config,
          kind: "openclaw.config",
          generation: "config-42",
        },
      ],
      references: [{ subjectRef: CORE_READINESS_SUBJECT_REFS.config }],
    });

    expect(
      identity.subjects.find((subject) => subject.ref === CORE_READINESS_SUBJECT_REFS.config),
    ).toMatchObject({ generation: "config-42" });
  });

  it("retains referenced subjects and their parent chain in deterministic order", () => {
    const base = createGatewayReadinessIdentity({ instanceId: "gateway-1" });
    const collection = createPluginReadinessSubjectCollection({
      pluginId: "storage",
      criterionId: "backend",
    });
    const backend = collection.collector.declare({
      kind: "backend",
      key: "primary",
      identity: { id: "account-7" },
      parentRef: CORE_READINESS_SUBJECT_REFS.gateway,
    });

    const identity = reconcileReadinessIdentity({
      base,
      subjects: collection.subjects,
      references: [{ subjectRef: backend }],
    });

    expect(identity.subjects.map((subject) => subject.ref)).toEqual([
      CORE_READINESS_SUBJECT_REFS.gateway,
      CORE_READINESS_SUBJECT_REFS.process,
      backend,
    ]);
  });

  it("rejects unresolved and cyclic references", () => {
    const base = createGatewayReadinessIdentity({ instanceId: "gateway-1" });
    expect(() =>
      reconcileReadinessIdentity({ base, references: [{ subjectRef: "plugin.missing/item/one" }] }),
    ).toThrow("unresolved readiness subject reference");
    expect(() =>
      reconcileReadinessIdentity({
        base,
        subjects: [
          {
            ref: "plugin.test/item/one",
            kind: "plugin.test.item",
            parentRef: "plugin.test/item/two",
          },
          {
            ref: "plugin.test/item/two",
            kind: "plugin.test.item",
            parentRef: "plugin.test/item/one",
          },
        ],
        references: [{ subjectRef: "plugin.test/item/one" }],
      }),
    ).toThrow("readiness subject parent cycle");
  });
});
