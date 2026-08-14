import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeMeetExportBundle } from "./cli-export.js";
import type { GoogleMeetArtifactsResult, GoogleMeetAttendanceResult } from "./meet-api.js";

const emptyArtifacts: GoogleMeetArtifactsResult = {
  conferenceRecords: [],
  artifacts: [],
};

const emptyAttendance: GoogleMeetAttendanceResult = {
  conferenceRecords: [],
  attendance: [],
};

describe("Google Meet export publication", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-export-publication-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps an existing bundle member when replacement fails", async () => {
    const outputDir = path.join(tempDir, "bundle");
    const summaryPath = path.join(outputDir, "summary.md");
    fs.mkdirSync(outputDir);
    fs.writeFileSync(summaryPath, "previous summary\n");
    const priorBytes = fs.readFileSync(summaryPath);

    vi.spyOn(fsp, "writeFile").mockImplementationOnce(async (file) => {
      expect(typeof file).toBe("string");
      fs.writeFileSync(file as string, "partial replacement");
      throw new Error("injected write failure");
    });

    await expect(
      writeMeetExportBundle({
        outputDir,
        artifacts: emptyArtifacts,
        attendance: emptyAttendance,
      }),
    ).rejects.toThrow("injected write failure");

    expect(fs.readFileSync(summaryPath)).toEqual(priorBytes);
    expect(fs.readdirSync(outputDir)).toEqual(["summary.md"]);
  });

  it("keeps an existing ZIP when replacement fails", async () => {
    const outputDir = path.join(tempDir, "bundle");
    const zipPath = `${outputDir}.zip`;
    const priorZip = await new JSZip()
      .file("previous.txt", "previous export")
      .generateAsync({ type: "nodebuffer" });
    fs.writeFileSync(zipPath, priorZip);
    const realWriteFile = fsp.writeFile;

    vi.spyOn(fsp, "writeFile").mockImplementation(async (...args) => {
      const [file, data] = args;
      if (Buffer.isBuffer(data)) {
        expect(typeof file).toBe("string");
        fs.writeFileSync(file as string, "partial replacement");
        throw new Error("injected ZIP write failure");
      }
      await Reflect.apply(realWriteFile, fsp, args);
    });

    await expect(
      writeMeetExportBundle({
        outputDir,
        artifacts: emptyArtifacts,
        attendance: emptyAttendance,
        zip: true,
      }),
    ).rejects.toThrow("injected ZIP write failure");

    expect(fs.readFileSync(zipPath)).toEqual(priorZip);
    expect(fs.readdirSync(tempDir).toSorted()).toEqual(["bundle", "bundle.zip"]);
  });
});
