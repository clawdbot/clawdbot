import { beforeEach, describe, expect, it } from "vitest";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "./diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "./diagnostic-otel-listener-provenance.js";
import { markHostPluginUsageDiagnosticEvent } from "./diagnostic-plugin-usage-provenance.js";

describe("diagnostic event plugin usage attribution", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("keeps host plugin attribution private and unforgeable", () => {
    const publicEvents: Array<{
      eventPluginId?: unknown;
      hostPluginId?: string;
      internal?: boolean;
      trusted: boolean;
    }> = [];
    const trustedEvents: Array<{
      eventPluginId?: unknown;
      privateHostPluginId?: unknown;
      internal?: boolean;
      trusted: boolean;
    }> = [];
    const otelEvents: Array<{
      eventPluginId?: unknown;
      hostPluginId?: string;
      internal?: boolean;
      trusted: boolean;
    }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      if (event.type === "model.usage") {
        publicEvents.push({
          eventPluginId: (event as typeof event & { pluginId?: unknown }).pluginId,
          hostPluginId: (metadata as typeof metadata & { hostPluginId?: string }).hostPluginId,
          internal: metadata.internal,
          trusted: metadata.trusted,
        });
      }
    });
    onTrustedInternalDiagnosticEvent((event, metadata, privateData) => {
      if (event.type === "model.usage") {
        trustedEvents.push({
          eventPluginId: (event as typeof event & { pluginId?: unknown }).pluginId,
          privateHostPluginId: (privateData as { hostPluginId?: unknown }).hostPluginId,
          internal: metadata.internal,
          trusted: metadata.trusted,
        });
      }
    });
    onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((event, metadata, privateData) => {
        if (event.type === "model.usage") {
          otelEvents.push({
            eventPluginId: (event as typeof event & { pluginId?: unknown }).pluginId,
            hostPluginId: (privateData as { hostPluginId?: string }).hostPluginId,
            internal: metadata.internal,
            trusted: metadata.trusted,
          });
        }
      }),
    );

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      usage: { input: 1 },
      pluginId: "public-emitter-spoof",
    } as Parameters<typeof emitTrustedDiagnosticEvent>[0] & { pluginId: string });
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.usage",
        usage: { input: 2 },
      },
      { hostPluginId: "private-data-spoof" } as Parameters<
        typeof emitTrustedDiagnosticEventWithPrivateData
      >[1] & { hostPluginId: string },
    );
    emitTrustedDiagnosticEvent(
      markHostPluginUsageDiagnosticEvent(
        {
          type: "model.usage",
          usage: { input: 3 },
        },
        "llm-task",
      ),
    );

    expect(publicEvents).toEqual([
      {
        eventPluginId: "public-emitter-spoof",
        hostPluginId: undefined,
        internal: undefined,
        trusted: true,
      },
      {
        eventPluginId: undefined,
        hostPluginId: undefined,
        internal: undefined,
        trusted: true,
      },
      {
        eventPluginId: undefined,
        hostPluginId: undefined,
        internal: true,
        trusted: true,
      },
    ]);
    expect(trustedEvents).toEqual([
      {
        eventPluginId: "public-emitter-spoof",
        privateHostPluginId: undefined,
        internal: undefined,
        trusted: true,
      },
      {
        eventPluginId: undefined,
        privateHostPluginId: undefined,
        internal: undefined,
        trusted: true,
      },
      {
        eventPluginId: undefined,
        privateHostPluginId: undefined,
        internal: true,
        trusted: true,
      },
    ]);
    expect(otelEvents).toEqual([
      {
        eventPluginId: "public-emitter-spoof",
        hostPluginId: undefined,
        internal: undefined,
        trusted: true,
      },
      {
        eventPluginId: undefined,
        hostPluginId: undefined,
        internal: undefined,
        trusted: true,
      },
      {
        eventPluginId: undefined,
        hostPluginId: "llm-task",
        internal: true,
        trusted: true,
      },
    ]);
  });

  it("scopes OTel attribution to one listener registration", () => {
    const observedHostPluginIds: Array<string | undefined> = [];
    const sharedListener = (
      event: Parameters<Parameters<typeof onTrustedInternalDiagnosticEvent>[0]>[0],
      _metadata: Parameters<Parameters<typeof onTrustedInternalDiagnosticEvent>[0]>[1],
      privateData: Parameters<Parameters<typeof onTrustedInternalDiagnosticEvent>[0]>[2],
    ) => {
      if (event.type === "model.usage") {
        observedHostPluginIds.push((privateData as { hostPluginId?: string }).hostPluginId);
      }
    };
    onTrustedInternalDiagnosticEvent(sharedListener);
    onTrustedInternalDiagnosticEvent(markTrustedOtelDiagnosticListener(sharedListener));

    emitTrustedDiagnosticEvent(
      markHostPluginUsageDiagnosticEvent(
        {
          type: "model.usage",
          usage: { input: 1 },
        },
        "llm-task",
      ),
    );

    expect(observedHostPluginIds).toEqual([undefined, "llm-task"]);
  });
});
