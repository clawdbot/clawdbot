import { describe, expect, it } from "vitest";
import type { CronPayload, CronPayloadPatch } from "../types.js";
import { mergeCronPayload } from "./payload-merge.js";

type MergeCase = {
  label: string;
  existing: CronPayload;
  patch: CronPayloadPatch;
  expected: CronPayload;
};

const preserveCases = [
  {
    label: "systemEvent",
    existing: { kind: "systemEvent", text: "before", toolsAllow: ["read", "cron"] },
    patch: { kind: "systemEvent", text: "after" },
    expected: { kind: "systemEvent", text: "after", toolsAllow: ["read", "cron"] },
  },
  {
    label: "command",
    existing: { kind: "command", argv: ["echo", "before"], toolsAllow: ["read", "cron"] },
    patch: { kind: "command", argv: ["echo", "after"] },
    expected: { kind: "command", argv: ["echo", "after"], toolsAllow: ["read", "cron"] },
  },
] satisfies MergeCase[];

const updateCases = [
  {
    label: "systemEvent",
    existing: { kind: "systemEvent", text: "tick", toolsAllow: ["read", "cron"] },
    patch: { kind: "systemEvent", toolsAllow: ["cron"] },
    expected: { kind: "systemEvent", text: "tick", toolsAllow: ["cron"] },
  },
  {
    label: "command",
    existing: { kind: "command", argv: ["echo", "tick"], toolsAllow: ["read", "cron"] },
    patch: { kind: "command", toolsAllow: ["cron"] },
    expected: { kind: "command", argv: ["echo", "tick"], toolsAllow: ["cron"] },
  },
] satisfies MergeCase[];

const clearCases = [
  {
    label: "systemEvent",
    existing: { kind: "systemEvent", text: "tick", toolsAllow: ["read", "cron"] },
    patch: { kind: "systemEvent", toolsAllow: null },
    expected: { kind: "systemEvent", text: "tick" },
  },
  {
    label: "command",
    existing: { kind: "command", argv: ["echo", "tick"], toolsAllow: ["read", "cron"] },
    patch: { kind: "command", toolsAllow: null },
    expected: { kind: "command", argv: ["echo", "tick"] },
  },
] satisfies MergeCase[];

const kindChangeCases = [
  {
    label: "systemEvent to agentTurn",
    existing: { kind: "systemEvent", text: "before", toolsAllow: ["read", "cron"] },
    patch: { kind: "agentTurn", message: "after" },
    expected: { kind: "agentTurn", message: "after", toolsAllow: ["read", "cron"] },
  },
  {
    label: "agentTurn to command",
    existing: { kind: "agentTurn", message: "before", toolsAllow: ["read", "cron"] },
    patch: { kind: "command", argv: ["echo", "after"] },
    expected: { kind: "command", argv: ["echo", "after"], toolsAllow: ["read", "cron"] },
  },
  {
    label: "command to systemEvent",
    existing: { kind: "command", argv: ["echo", "before"], toolsAllow: ["read", "cron"] },
    patch: { kind: "systemEvent", text: "after" },
    expected: { kind: "systemEvent", text: "after", toolsAllow: ["read", "cron"] },
  },
] satisfies MergeCase[];

const installDefaultMarkerCases = [
  {
    label: "systemEvent",
    existing: { kind: "systemEvent", text: "before" },
    patch: {
      kind: "systemEvent",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    },
    expected: {
      kind: "systemEvent",
      text: "before",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    },
  },
  {
    label: "command",
    existing: { kind: "command", argv: ["echo", "before"] },
    patch: { kind: "command", toolsAllow: ["read", "cron"], toolsAllowIsDefault: true },
    expected: {
      kind: "command",
      argv: ["echo", "before"],
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    },
  },
] satisfies MergeCase[];

describe("mergeCronPayload trigger tool caps", () => {
  it.each(preserveCases)(
    "preserves $label toolsAllow when omitted",
    ({ existing, patch, expected }) => {
      expect(mergeCronPayload(existing, patch)).toEqual(expected);
    },
  );

  it.each(updateCases)("updates $label toolsAllow", ({ existing, patch, expected }) => {
    expect(mergeCronPayload(existing, patch)).toEqual(expected);
  });

  it.each(clearCases)("clears $label toolsAllow", ({ existing, patch, expected }) => {
    expect(mergeCronPayload(existing, patch)).toEqual(expected);
  });

  it.each(kindChangeCases)(
    "preserves toolsAllow across $label",
    ({ existing, patch, expected }) => {
      expect(mergeCronPayload(existing, patch)).toEqual(expected);
    },
  );

  it.each(installDefaultMarkerCases)(
    "installs a newly stamped default marker on $label",
    ({ existing, patch, expected }) => {
      expect(mergeCronPayload(existing, patch)).toEqual(expected);
    },
  );

  it("clears default provenance when a stamped patch narrows the existing default", () => {
    expect(
      mergeCronPayload(
        {
          kind: "agentTurn",
          message: "before",
          toolsAllow: ["read", "cron"],
          toolsAllowIsDefault: true,
        },
        {
          kind: "agentTurn",
          toolsAllow: ["read"],
          toolsAllowIsDefault: true,
        },
      ),
    ).toEqual({ kind: "agentTurn", message: "before", toolsAllow: ["read"] });
  });

  it("clears toolsAllow explicitly across a kind change", () => {
    expect(
      mergeCronPayload(
        { kind: "systemEvent", text: "before", toolsAllow: ["read", "cron"] },
        { kind: "agentTurn", message: "after", toolsAllow: null },
      ),
    ).toEqual({ kind: "agentTurn", message: "after" });
  });

  it("treats undefined toolsAllow as omitted across a kind change", () => {
    expect(
      mergeCronPayload(
        { kind: "systemEvent", text: "before", toolsAllow: ["read", "cron"] },
        { kind: "agentTurn", message: "after", toolsAllow: undefined },
      ),
    ).toEqual({ kind: "agentTurn", message: "after", toolsAllow: ["read", "cron"] });
  });

  it("preserves default-cap provenance across a kind change", () => {
    expect(
      mergeCronPayload(
        {
          kind: "systemEvent",
          text: "before",
          toolsAllow: ["read", "cron"],
          toolsAllowIsDefault: true,
        },
        { kind: "agentTurn", message: "after" },
      ),
    ).toEqual({
      kind: "agentTurn",
      message: "after",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    });
  });
});
