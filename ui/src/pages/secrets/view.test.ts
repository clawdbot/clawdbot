import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { renderSecretsStore } from "./view.ts";

type SecretsStoreViewProps = Parameters<typeof renderSecretsStore>[0];

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
});

function mount(
  entries: SecretStoreEntry[],
  overrides: Partial<SecretsStoreViewProps> = {},
): HTMLElement {
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  const noop = vi.fn();
  const props: SecretsStoreViewProps = {
    entries,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    canList: true,
    canSet: true,
    canDelete: true,
    dialogMode: null,
    draft: { name: "", value: "", kind: "env" },
    formError: null,
    bulkOpen: false,
    bulkRaw: "",
    bulkAutoDetect: true,
    bulkSecretCount: 0,
    bulkEntryCount: 0,
    bulkInvalidNames: [],
    onRefresh: noop,
    onOpenAdd: noop,
    onOpenEdit: noop,
    onCloseDialog: noop,
    onDraftNameChange: noop,
    onDraftValueChange: noop,
    onDraftSecretChange: noop,
    onSubmitDraft: noop,
    onOpenBulk: noop,
    onCloseBulk: noop,
    onBulkRawChange: noop,
    onBulkAutoDetectChange: noop,
    onSubmitBulk: noop,
    onDelete: noop,
  };
  render(renderSecretsStore({ ...props, ...overrides }), container);
  return container;
}

describe("secrets store view", () => {
  it("never renders a secret value even when hostile input carries one", () => {
    const secret = {
      name: "SERVICE_API_KEY",
      kind: "secret",
      value: "must-never-render",
      scopeKind: "team",
      scopeId: "",
      createdAtMs: 1,
      updatedAtMs: 2,
      updatedBy: "Operator",
    } as unknown as SecretStoreEntry;
    const env: SecretStoreEntry = {
      name: "SERVICE_URL",
      kind: "env",
      value: "https://service.test",
      scopeKind: "team",
      scopeId: "",
      createdAtMs: 1,
      updatedAtMs: 2,
      updatedBy: "Operator",
    };
    const container = mount([secret, env]);

    expect(container.innerHTML).not.toContain("must-never-render");
    expect(container.textContent).toContain("••••••••");
    expect(container.textContent).toContain("https://service.test");
  });

  it("hides mutation controls when the gateway does not advertise them", () => {
    const container = mount([], { canSet: false, canDelete: false });

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Secrets");
  });
});
