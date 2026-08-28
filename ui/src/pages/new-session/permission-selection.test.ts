import { describe, expect, it, vi } from "vitest";
import { NewSessionPermissionSelection } from "./permission-selection.ts";

describe("NewSessionPermissionSelection", () => {
  it("publishes user mutations without treating recovery as a mutation", () => {
    const requestUpdate = vi.fn();
    const onMutation = vi.fn();
    const selection = new NewSessionPermissionSelection(requestUpdate);
    selection.setMutationCallback(onMutation);

    selection.restore("guarded");
    expect(selection.value).toBe("guarded");
    expect(onMutation).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();

    selection.set("full");
    expect(selection.value).toBe("full");
    expect(onMutation).toHaveBeenCalledOnce();
    expect(requestUpdate).toHaveBeenCalledOnce();
  });
});
