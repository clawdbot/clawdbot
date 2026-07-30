import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateNodeInvokeInputEvent,
  validateNodeInvokeProgressParams,
  validateNodeInvokeRequestEvent,
  validateNodeInvokeResultParams,
} from "../index.js";

type LifecycleFixture = {
  version: number;
  request: { canonical: unknown; invalid: unknown };
  input: { canonical: unknown[]; invalid: unknown };
  progress: { canonical: unknown; invalid: unknown };
  results: { success: unknown; failure: unknown; invalid: unknown };
};

function loadLifecycleFixture(): LifecycleFixture {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "test", "fixtures", "node-invoke-lifecycle-contract.json"),
      "utf8",
    ),
  ) as LifecycleFixture;
}

describe("node protocol schemas", () => {
  it("matches the shared node invocation lifecycle corpus", () => {
    const fixture = loadLifecycleFixture();
    expect(fixture.version).toBe(1);
    expect(validateNodeInvokeRequestEvent(fixture.request.canonical)).toBe(true);
    expect(validateNodeInvokeRequestEvent(fixture.request.invalid)).toBe(false);
    for (const input of fixture.input.canonical) {
      expect(validateNodeInvokeInputEvent(input)).toBe(true);
    }
    expect(validateNodeInvokeInputEvent(fixture.input.invalid)).toBe(false);
    expect(validateNodeInvokeProgressParams(fixture.progress.canonical)).toBe(true);
    expect(validateNodeInvokeProgressParams(fixture.progress.invalid)).toBe(false);
    expect(validateNodeInvokeResultParams(fixture.results.success)).toBe(true);
    expect(validateNodeInvokeResultParams(fixture.results.failure)).toBe(true);
    expect(validateNodeInvokeResultParams(fixture.results.invalid)).toBe(false);
  });

  it("accepts bounded progress chunks and rejects extra fields", () => {
    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "stdout line",
      }),
    ).toBe(true);

    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "x".repeat(16 * 1024 + 1),
      }),
    ).toBe(false);

    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "stdout line",
        extra: "not allowed",
      }),
    ).toBe(false);
  });
});
