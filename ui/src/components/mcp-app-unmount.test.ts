import { LitElement, html, nothing } from "lit";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpAppUnmountGate } from "./mcp-app-unmount.ts";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const targetTag = `test-mcp-app-unmount-target-${crypto.randomUUID()}`;
const ownerTag = `test-mcp-app-unmount-owner-${crypto.randomUUID()}`;
const siblingOwnerTag = `test-mcp-app-unmount-sibling-owner-${crypto.randomUUID()}`;
const staticTargetTag = unsafeStatic(targetTag);
const teardown = vi.fn<() => Promise<void>>();

class TestMcpAppUnmountTarget extends HTMLElement {
  restartCalls = 0;

  restartAfterTeardown() {
    this.restartCalls += 1;
  }

  teardown() {
    return teardown();
  }
}

class TestMcpAppUnmountOwner extends LitElement {
  key = "initial";
  private readonly gate = new McpAppUnmountGate(this, targetTag);

  show(key: string) {
    this.key = key;
    this.requestUpdate();
  }

  override render() {
    const value =
      this.key === "initial"
        ? staticHtml`<${staticTargetTag}></${staticTargetTag}><span data-value="initial">initial</span>`
        : html`<span data-value=${this.key}>${this.key}</span>`;
    return this.gate.render(this.key, value, () => [this.renderRoot]);
  }
}

class TestMcpAppUnmountSiblingOwner extends LitElement {
  private includeLeaving = true;
  private readonly gate = new McpAppUnmountGate(this, targetTag);

  removeLeaving() {
    this.includeLeaving = false;
    this.requestUpdate();
  }

  override render() {
    const value = staticHtml`
      ${
        this.includeLeaving
          ? staticHtml`<div class="leaving"><${staticTargetTag}></${staticTargetTag}></div>`
          : nothing
      }
      <${staticTargetTag} class="retained"></${staticTargetTag}>
    `;
    return this.gate.render(this.includeLeaving ? "both" : "retained", value, () =>
      this.renderRoot.querySelectorAll(".leaving"),
    );
  }
}

customElements.define(targetTag, TestMcpAppUnmountTarget);
customElements.define(ownerTag, TestMcpAppUnmountOwner);
customElements.define(siblingOwnerTag, TestMcpAppUnmountSiblingOwner);

afterEach(() => {
  document.body.replaceChildren();
  teardown.mockReset();
});

describe("McpAppUnmountGate", () => {
  it("keeps the old subtree connected and coalesces replacements until teardown resolves", async () => {
    const pending = deferred();
    teardown.mockReturnValue(pending.promise);
    const owner = document.createElement(ownerTag) as TestMcpAppUnmountOwner;
    document.body.append(owner);
    await owner.updateComplete;

    const target = owner.shadowRoot!.querySelector(targetTag)!;
    owner.show("intermediate");
    await owner.updateComplete;
    expect(teardown).toHaveBeenCalledOnce();
    expect(target.isConnected).toBe(true);
    expect(owner.shadowRoot!.querySelector("[data-value='initial']")).not.toBeNull();

    owner.show("latest");
    await owner.updateComplete;
    expect(teardown).toHaveBeenCalledOnce();
    expect(owner.shadowRoot!.querySelector("[data-value='latest']")).toBeNull();

    pending.resolve();
    await expect
      .poll(() => owner.shadowRoot!.querySelector("[data-value='latest']"))
      .not.toBeNull();
    expect(owner.shadowRoot!.querySelector(targetTag)).toBeNull();
    expect(owner.shadowRoot!.querySelector("[data-value='intermediate']")).toBeNull();
  });

  it("restarts the original target when a pending transition rebounds", async () => {
    const pending = deferred();
    teardown.mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const owner = document.createElement(ownerTag) as TestMcpAppUnmountOwner;
    document.body.append(owner);
    await owner.updateComplete;
    const original = owner.shadowRoot!.querySelector<TestMcpAppUnmountTarget>(targetTag)!;

    owner.show("intermediate");
    await owner.updateComplete;
    owner.show("initial");
    await owner.updateComplete;
    expect(original.isConnected).toBe(true);

    pending.resolve();
    await expect.poll(() => original.restartCalls).toBe(1);
    expect(owner.shadowRoot!.querySelector(targetTag)).toBe(original);
    expect(teardown).toHaveBeenCalledOnce();
  });

  it("preserves retained siblings while removing a torn-down target", async () => {
    const pending = deferred();
    teardown.mockReturnValue(pending.promise);
    const owner = document.createElement(siblingOwnerTag) as TestMcpAppUnmountSiblingOwner;
    document.body.append(owner);
    await owner.updateComplete;
    const leaving = owner.shadowRoot!.querySelector<TestMcpAppUnmountTarget>(
      `.leaving ${targetTag}`,
    )!;
    const retained = owner.shadowRoot!.querySelector<TestMcpAppUnmountTarget>(".retained")!;

    owner.removeLeaving();
    await owner.updateComplete;
    expect(leaving.isConnected).toBe(true);
    expect(retained.isConnected).toBe(true);

    pending.resolve();
    await expect.poll(() => owner.shadowRoot!.querySelector(".leaving")).toBeNull();
    expect(owner.shadowRoot!.querySelector(".retained")).toBe(retained);
    expect(retained.restartCalls).toBe(0);
    expect(teardown).toHaveBeenCalledOnce();
  });
});
