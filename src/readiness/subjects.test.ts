import { describe, expect, it } from "vitest";
import {
  CORE_READINESS_SUBJECT_REFS,
  createGatewayReadinessIdentity,
  createPluginReadinessSubjectCollection,
  reconcileReadinessIdentity,
} from "./subjects.js";

describe("readiness subjects", () => {
  it("keeps one Gateway identity stable and creates a new identity for another lifecycle", () => {
    const first = createGatewayReadinessIdentity({
      createGatewayInstanceId: () => "gateway-1",
    });
    const second = createGatewayReadinessIdentity({
      createGatewayInstanceId: () => "gateway-2",
    });

    expect(first.subjects.find((subject) => subject.ref === first.producerRef)?.id).toBe(
      "gateway-1",
    );
    expect(second.subjects.find((subject) => subject.ref === second.producerRef)?.id).toBe(
      "gateway-2",
    );
  });

  it("keeps host, process, and Gateway renewal scopes separate", () => {
    const first = createGatewayReadinessIdentity({
      env: { OPENCLAW_INSTANCE_ID: "pod-7/restart-2" },
      createGatewayInstanceId: () => "gateway-1",
    });
    const second = createGatewayReadinessIdentity({
      env: { OPENCLAW_INSTANCE_ID: "pod-7/restart-2" },
      createGatewayInstanceId: () => "gateway-2",
    });
    const replacement = createGatewayReadinessIdentity({
      env: { OPENCLAW_INSTANCE_ID: "pod-8/restart-1" },
      createGatewayInstanceId: () => "gateway-3",
    });

    expect(first.subjects.find((subject) => subject.ref === first.producerRef)?.id).toBe(
      "gateway-1",
    );
    expect(second.subjects.find((subject) => subject.ref === second.producerRef)?.id).toBe(
      "gateway-2",
    );
    const firstHost = first.subjects.find(
      (subject) => subject.ref === CORE_READINESS_SUBJECT_REFS.hostInstance,
    );
    const secondHost = second.subjects.find(
      (subject) => subject.ref === CORE_READINESS_SUBJECT_REFS.hostInstance,
    );
    const replacementHost = replacement.subjects.find(
      (subject) => subject.ref === CORE_READINESS_SUBJECT_REFS.hostInstance,
    );
    const firstProcess = first.subjects.find(
      (subject) => subject.ref === CORE_READINESS_SUBJECT_REFS.process,
    );
    const secondProcess = second.subjects.find(
      (subject) => subject.ref === CORE_READINESS_SUBJECT_REFS.process,
    );
    const replacementProcess = replacement.subjects.find(
      (subject) => subject.ref === CORE_READINESS_SUBJECT_REFS.process,
    );
    expect(firstHost?.id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(firstHost?.id).toBe(secondHost?.id);
    expect(replacementHost?.id).not.toBe(firstHost?.id);
    expect(firstHost?.id).not.toContain("pod-7");
    expect(firstProcess?.id).toBe(secondProcess?.id);
    expect(firstProcess?.id).toBe(replacementProcess?.id);
    expect(firstProcess?.parentRef).toBe(firstHost?.ref);
    expect(secondProcess?.parentRef).toBe(secondHost?.ref);
    expect(replacementProcess?.parentRef).toBe(replacementHost?.ref);
    expect(first.subjects.find((subject) => subject.ref === first.producerRef)?.parentRef).toBe(
      firstProcess?.ref,
    );
  });

  it("distinguishes plugin object replacement from revision of the same object", () => {
    const collect = (id: string, generation: string) => {
      const collection = createPluginReadinessSubjectCollection({
        pluginId: "storage",
        criterionId: "backend",
      });
      const ref = collection.collector.declare({
        kind: "backend",
        key: "primary",
        identity: { id, generation },
      });
      return collection.subjects.find((subject) => subject.ref === ref);
    };

    const first = collect("account-7", "config-1");
    const revised = collect("account-7", "config-2");
    const replacement = collect("account-8", "config-1");

    expect(first?.id).toBe(revised?.id);
    expect(first?.generation).not.toBe(revised?.generation);
    expect(first?.id).not.toBe(replacement?.id);
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

  it("allows exactly 64 explicit plugin subjects", () => {
    const collection = createPluginReadinessSubjectCollection({
      pluginId: "storage",
      criterionId: "backend",
    });
    for (let index = 0; index < 64; index += 1) {
      collection.collector.declare({ kind: "replica", key: `replica-${index}` });
    }
    expect(collection.subjects).toHaveLength(65);
    expect(() =>
      collection.collector.declare({ kind: "replica", key: "replica-overflow" }),
    ).toThrow("plugin readiness subject limit exceeded");
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

  it("allows parent-independent declaration order and validates the completed graph", () => {
    const collection = createPluginReadinessSubjectCollection({
      pluginId: "storage",
      criterionId: "backend",
    });

    const child = collection.collector.declare({
      kind: "replica",
      key: "secondary",
      parentRef: "plugin.storage/backend/primary",
    });
    expect(collection.validateReferences(child)).toBe(false);
    collection.collector.declare({ kind: "backend", key: "primary" });
    expect(collection.validateReferences(child)).toBe(true);
  });

  it("enriches a core placeholder with compatible owner identity", () => {
    const base = createGatewayReadinessIdentity({
      createGatewayInstanceId: () => "gateway-1",
    });
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
    const base = createGatewayReadinessIdentity({
      createGatewayInstanceId: () => "gateway-1",
    });
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
    const base = createGatewayReadinessIdentity({
      createGatewayInstanceId: () => "gateway-1",
    });
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
