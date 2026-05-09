import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { renderDebug, type DebugProps } from "./debug.ts";

function createProps(overrides: Partial<DebugProps> = {}): DebugProps {
  return {
    loading: false,
    status: null,
    health: null,
    models: [],
    heartbeat: null,
    eventLog: [],
    methods: [],
    callMethod: "",
    callParams: "{}",
    callResult: null,
    callError: null,
    onCallMethodChange: () => undefined,
    onCallParamsChange: () => undefined,
    onRefresh: () => undefined,
    onCall: () => undefined,
    ...overrides,
  };
}

describe("renderDebug", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    await i18n.setLocale("en");
    vi.unstubAllGlobals();
  });

  it("keeps the security audit command styled as monospace", async () => {
    await i18n.setLocale("zh-CN");
    const container = document.createElement("div");

    render(
      renderDebug(
        createProps({
          status: {
            securityAudit: {
              summary: {
                critical: 0,
                warn: 1,
                info: 2,
              },
            },
          },
        }),
      ),
      container,
    );

    const command = container.querySelector<HTMLElement>(".callout .mono");
    if (!command) {
      throw new Error("expected debug security audit command");
    }
    expect(command.textContent).toBe("openclaw security audit --deep");
    expect(container.textContent).toContain("安全审计");
  });
});
