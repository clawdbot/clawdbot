import { describe, expect, it } from "vitest";
import {
  readLiveModelCatalogBooleanField,
  readLiveModelCatalogPositiveSafeIntegerField,
  readLiveModelCatalogStringField,
} from "./provider-catalog-live-normalize.internal.js";

describe("live model catalog primitive fields", () => {
  it.each<[unknown, string | readonly string[], string | undefined]>([
    [{ primary: "  ", fallback: "  model-id  " }, ["primary", "fallback"], "model-id"],
    [{ value: 42 }, "value", undefined],
    [[{ value: "model-id" }], "value", undefined],
  ])("reads the first nonblank trimmed string from %j", (row, keys, expected) => {
    expect(readLiveModelCatalogStringField(row, keys)).toBe(expected);
  });

  it.each<[unknown, string | readonly string[], number | undefined]>([
    [{ primary: 0, fallback: 8 }, ["primary", "fallback"], 8],
    [{ value: -1 }, "value", undefined],
    [{ value: 1.5 }, "value", undefined],
    [{ value: Number.MAX_SAFE_INTEGER + 1 }, "value", undefined],
    [{ value: "8" }, "value", undefined],
  ])("accepts only positive safe integer fields from %j", (row, keys, expected) => {
    expect(readLiveModelCatalogPositiveSafeIntegerField(row, keys)).toBe(expected);
  });

  it.each<[unknown, string | readonly string[], boolean | undefined]>([
    [{ primary: "false", fallback: false }, ["primary", "fallback"], false],
    [{ value: true }, "value", true],
    [{ value: 1 }, "value", undefined],
  ])("accepts only strict Boolean fields from %j", (row, keys, expected) => {
    expect(readLiveModelCatalogBooleanField(row, keys)).toBe(expected);
  });
});
