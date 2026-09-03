import { describe, expect, it } from "vitest";
import { basenameFromAnyPath, extnameFromAnyPath, nameFromAnyPath } from "./file-name.js";

describe("filename extraction", () => {
  it.each([
    ".",
    "..",
    "folder/.",
    "folder/..",
    "./",
    "../",
    "C:\\folder\\.",
    "C:\\folder\\..",
    ".\\",
    "..\\",
  ])("treats navigation segment %j as a missing filename", (value) => {
    expect(basenameFromAnyPath(value)).toBe("");
    expect(nameFromAnyPath(value)).toBe("");
    expect(extnameFromAnyPath(value)).toBe("");
  });

  it.each([
    ["", "", "", ""],
    ["/", "", "", ""],
    ["C:\\", "", "", ""],
    ["../report.txt", "report.txt", "report", ".txt"],
    ["C:\\folder\\invoice.TXT", "invoice.TXT", "invoice", ".TXT"],
    ["folder\\nested/report.tar.gz", "report.tar.gz", "report.tar", ".gz"],
    ["...", "...", "..", "."],
    ["file..txt", "file..txt", "file.", ".txt"],
    [".gitignore", ".gitignore", ".gitignore", ""],
    ["写真.png", "写真.png", "写真", ".png"],
    ["folder/report.txt/", "report.txt", "report", ".txt"],
  ])("preserves filename components for %j", (value, base, name, extension) => {
    expect(basenameFromAnyPath(value)).toBe(base);
    expect(nameFromAnyPath(value)).toBe(name);
    expect(extnameFromAnyPath(value)).toBe(extension);
  });
});
