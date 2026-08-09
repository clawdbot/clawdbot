import { describe, expect, it } from "vitest";
import { buildControlUiCatalogSessionUrl } from "./index.js";

describe("buildControlUiCatalogSessionUrl", () => {
  it.each([
    {
      label: "root base path",
      agentId: "main",
      basePath: undefined,
      expected: "/chat/main?catalog=beam&host=gateway&thread=beam-1",
    },
    {
      label: "nested base path and non-main agent",
      agentId: "research",
      basePath: "/admin/openclaw/",
      expected: "/admin/openclaw/chat/research?catalog=beam&host=gateway&thread=beam-1",
    },
  ])("builds a canonical URL for $label", ({ agentId, basePath, expected }) => {
    expect(
      buildControlUiCatalogSessionUrl({
        namespace: "chat",
        agentId,
        basePath,
        catalog: "beam",
        host: "gateway",
        thread: "beam-1",
      }),
    ).toBe(expected);
  });

  it("encodes reserved query characters", () => {
    expect(
      buildControlUiCatalogSessionUrl({
        namespace: "dashboard",
        agentId: "main",
        catalog: "claude & codex",
        host: "gateway:local/primary",
        thread: "thread?one=1&two=2",
      }),
    ).toBe(
      "/dashboard/main?catalog=claude+%26+codex&host=gateway%3Alocal%2Fprimary&thread=thread%3Fone%3D1%26two%3D2",
    );
  });

  it.each(["agentId", "catalog", "host", "thread"] as const)(
    "returns null when required $field is empty",
    (field) => {
      expect(
        buildControlUiCatalogSessionUrl({
          namespace: "chat",
          agentId: "main",
          catalog: "beam",
          host: "gateway",
          thread: "beam-1",
          [field]: " ",
        }),
      ).toBeNull();
    },
  );
});
