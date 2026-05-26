import { describe, expect, it } from "vitest";
import { resolveDiagnosticModelContentCapturePolicy } from "./diagnostic-llm-content.js";

describe("resolveDiagnosticModelContentCapturePolicy", () => {
  it("requires diagnostics, otel, traces, and explicit content capture", () => {
    expect(resolveDiagnosticModelContentCapturePolicy({}).anyModelContent).toBe(false);
    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: { enabled: false, otel: { enabled: true, captureContent: true } },
      }).anyModelContent,
    ).toBe(false);
    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: {
          enabled: true,
          otel: { enabled: true, traces: false, captureContent: true },
        },
      }).anyModelContent,
    ).toBe(false);
    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: { enabled: true, otel: { enabled: true, captureContent: true } },
      }),
    ).toMatchObject({
      inputMessages: true,
      outputMessages: true,
      systemPrompt: false,
      toolDefinitions: true,
      anyModelContent: true,
    });
    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: { otel: { enabled: true, captureContent: true } },
      }),
    ).toMatchObject({
      inputMessages: true,
      outputMessages: true,
      systemPrompt: false,
      toolDefinitions: true,
      anyModelContent: true,
    });
  });

  it("uses the object form for system prompt capture", () => {
    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            captureContent: {
              enabled: true,
              inputMessages: true,
              outputMessages: false,
              systemPrompt: true,
              toolDefinitions: true,
            },
          },
        },
      }),
    ).toMatchObject({
      inputMessages: true,
      outputMessages: false,
      systemPrompt: true,
      toolDefinitions: true,
      anyModelContent: true,
    });
  });

  it("gates tool definitions independently from input messages", () => {
    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            captureContent: {
              enabled: true,
              inputMessages: true,
              toolDefinitions: false,
            },
          },
        },
      }),
    ).toMatchObject({
      inputMessages: true,
      toolDefinitions: false,
      anyModelContent: true,
    });

    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            captureContent: {
              enabled: true,
              inputMessages: false,
              toolDefinitions: true,
            },
          },
        },
      }),
    ).toMatchObject({
      inputMessages: false,
      toolDefinitions: true,
      anyModelContent: true,
    });
  });
});
