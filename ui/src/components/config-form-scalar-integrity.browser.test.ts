// Control UI tests cover scalar identity and nullable enum behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderNumberInput, renderSelect, renderTextInput } from "./config-form.node.scalar.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("config form scalar integrity", () => {
  it("keeps repeated number input identity arguments aligned", () => {
    const container = document.createElement("div");
    const renderValue = (controlIdentity: number[]) => {
      render(
        renderNumberInput({
          schema: { type: "integer" },
          value: 2,
          path: ["values", 0],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          sourceIdentity: 2,
          controlIdentity,
          onPatch: vi.fn(),
        }),
        container,
      );
    };

    renderValue([2]);
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "repeated number input",
    );
    renderValue([2, 4]);
    expect(container.querySelector("input[type='number']")).toBe(input);
    expect(input.value).toBe("2");
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it("keeps a focused in-flight edit through a snapshot identity refresh", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const renderValue = (value: string, sourceIdentity: unknown) => {
      render(
        renderTextInput({
          schema: { type: "string" },
          value,
          path: ["laboratory", "endpoint"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          sourceIdentity,
          inputType: "text",
          onPatch: vi.fn(),
        }),
        container,
      );
    };
    try {
      renderValue("local-api", { snapshot: 1 });
      const input = expectElement(
        container.querySelector<HTMLInputElement>("input[type='text']"),
        "endpoint input",
      );

      // Mid-typing window: the DOM holds text the model has not committed yet
      // (no input event dispatched). A background config refresh that only
      // changes the snapshot identity must not eat it while the field is
      // focused.
      input.focus();
      input.value = "form-api";
      renderValue("local-api", { snapshot: 2 });
      expect(input.value).toBe("form-api");

      // The blurred authoritative-reset contract stays intact.
      input.blur();
      renderValue("remote-api", { snapshot: 3 });
      expect(input.value).toBe("remote-api");
    } finally {
      container.remove();
    }
  });

  it("allows required nullable enums to select their null member", () => {
    const container = document.createElement("div");
    const nullablePatch = vi.fn();
    render(
      renderSelect({
        schema: {
          type: "string",
          nullable: true,
          enumIncludesNull: true,
        },
        value: "fixed",
        path: ["nullableMode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        isRequired: true,
        options: ["fixed", "other"],
        onPatch: nullablePatch,
      }),
      container,
    );
    const nullableSelect = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "required nullable enum",
    );
    const nullOption = expectElement(
      nullableSelect.querySelector<HTMLOptionElement>("option[value='__null__']"),
      "nullable enum null option",
    );
    expect(nullOption.disabled).toBe(false);
    expect(
      nullableSelect.querySelector<HTMLOptionElement>("option[value='__unset__']")?.disabled,
    ).toBe(true);
    nullableSelect.value = "__null__";
    nullableSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(nullablePatch).toHaveBeenCalledWith(["nullableMode"], null);

    const requiredPatch = vi.fn();
    render(
      renderSelect({
        schema: { type: "string" },
        value: "fixed",
        path: ["requiredMode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        isRequired: true,
        options: ["fixed", "other"],
        onPatch: requiredPatch,
      }),
      container,
    );
    const requiredSelect = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "required non-null enum",
    );
    expect(
      requiredSelect.querySelector<HTMLOptionElement>("option[value='__unset__']")?.disabled,
    ).toBe(true);
    requiredSelect.value = "__unset__";
    requiredSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(requiredSelect.value).toBe("0");
    expect(requiredPatch).not.toHaveBeenCalled();
  });

  it("keeps optional nullable enum unset distinct from explicit null", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const renderValue = (value: unknown) => {
      render(
        renderSelect({
          schema: {
            type: "string",
            nullable: true,
            enumIncludesNull: true,
          },
          value,
          path: ["mode"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          options: ["fixed", "other"],
          onPatch,
        }),
        container,
      );
    };

    renderValue(null);
    const select = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "optional nullable enum",
    );
    expect(select.value).toBe("__null__");
    select.value = "__unset__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["mode"], undefined);

    renderValue("fixed");
    select.value = "__null__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["mode"], null);
  });

  it("shows inherited defaults without turning them into stored overrides", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const onRemove = vi.fn();

    render(
      renderTextInput({
        schema: { type: "string", default: "balanced" },
        value: undefined,
        path: ["mode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        inputType: "text",
        onPatch,
        onRemove,
      }),
      container,
    );

    const textInput = expectElement(
      container.querySelector<HTMLInputElement>("input[type='text']"),
      "defaulted text input",
    );
    expect(textInput.value).toBe("");
    expect(textInput.placeholder).toBe("Default: balanced");
    expect(container.textContent).toContain("Using default: balanced");
    expect(onPatch).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();

    render(
      renderNumberInput({
        schema: { type: "integer", default: 3 },
        value: undefined,
        path: ["retries"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch,
        onRemove,
      }),
      container,
    );
    const numberInput = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "defaulted number input",
    );
    expect(numberInput.value).toBe("");
    expect(numberInput.placeholder).toBe("Default: 3");
    expect(container.textContent).toContain("Using default: 3");

    const arrowUp = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowUp",
    });
    numberInput.dispatchEvent(arrowUp);
    expect(arrowUp.defaultPrevented).toBe(true);
    expect(onPatch).toHaveBeenLastCalledWith(["retries"], 4);
  });

  it("shows the default description without a reset button on an overridden row", () => {
    const container = document.createElement("div");
    render(
      renderTextInput({
        schema: { type: "string", default: "balanced" },
        value: "custom",
        path: ["mode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        inputType: "text",
        onPatch: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).toContain("Default: balanced");
    expect(container.querySelector("button[aria-label='Reset to default']")).toBeNull();
  });

  it("restores scalar and select defaults through clearing and default selection", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const onRemove = vi.fn();

    render(
      renderNumberInput({
        schema: { type: "integer", default: 3 },
        value: 9,
        path: ["retries"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch,
        onRemove,
      }),
      container,
    );
    expect(container.textContent).toContain("Default: 3");
    const numberInput = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "number input",
    );
    numberInput.value = "";
    numberInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["retries"], undefined);
    expect(onRemove).not.toHaveBeenCalled();

    onPatch.mockClear();
    render(
      renderSelect({
        schema: { type: "string", default: "balanced" },
        value: "fast",
        path: ["mode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        options: ["balanced", "fast", "careful", "safe", "strict", "custom"],
        onPatch,
        onRemove,
      }),
      container,
    );
    const select = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "default-aware select",
    );
    expect(container.textContent).toContain("Default: balanced");
    expect(select.options[0]?.textContent?.trim()).toBe("Default: balanced");
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe("fast");
    select.value = "__unset__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onRemove).toHaveBeenCalledWith(["mode"]);
    expect(onPatch).not.toHaveBeenCalled();

    render(
      renderSelect({
        schema: { type: "string", default: "balanced" },
        value: undefined,
        path: ["mode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        options: ["balanced", "fast", "careful", "safe", "strict", "custom"],
        onPatch,
        onRemove,
      }),
      container,
    );
    expect(
      expectElement(
        container.querySelector<HTMLSelectElement>("select"),
        "inherited select",
      ).selectedOptions[0]?.textContent?.trim(),
    ).toBe("Default: balanced");
  });

  it("commits the valid branch type for constrained text unions", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    render(
      renderTextInput({
        schema: {
          anyOf: [
            { type: "string", const: "auto" },
            { type: "integer", minimum: 0 },
          ],
        },
        value: "auto",
        path: ["mode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        inputType: "text",
        onPatch,
      }),
      container,
    );
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='text']"),
      "constrained union input",
    );

    input.value = "42";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["mode"], 42);
    expect(input.getAttribute("aria-invalid")).toBe("false");

    input.value = "auto";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["mode"], "auto");

    onPatch.mockClear();
    input.value = "invalid";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("commits explicit boolean branches without retyping numeric strings", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    render(
      renderTextInput({
        schema: {
          anyOf: [{ type: "string" }, { type: "number" }, { const: false }],
        },
        value: "500mb",
        path: ["maxDiskBytes"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        inputType: "text",
        onPatch,
      }),
      container,
    );
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='text']"),
      "string-number-boolean union input",
    );

    input.value = "false";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["maxDiskBytes"], false);

    input.value = "true";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["maxDiskBytes"], "true");

    const identifier = "1048113311314608148";
    input.value = identifier;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["maxDiskBytes"], identifier);
  });

  it("preserves the current branch type in unconstrained primitive unions", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const schema = {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
    };
    const renderValue = (value: unknown, defaultValue?: unknown) => {
      render(
        renderTextInput({
          schema: defaultValue === undefined ? schema : { ...schema, default: defaultValue },
          value,
          path: ["providerOptions", "deepgram", "temperature"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          inputType: "text",
          onPatch,
        }),
        container,
      );
      return expectElement(
        container.querySelector<HTMLInputElement>("input[type='text']"),
        "mixed primitive union input",
      );
    };

    let input = renderValue(42);
    input.value = "43";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["providerOptions", "deepgram", "temperature"], 43);

    onPatch.mockClear();
    input = renderValue(1);
    input.value = "1.0000000000000001";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe("1.0000000000000001");

    onPatch.mockClear();
    input = renderValue("42");
    input.value = "43";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["providerOptions", "deepgram", "temperature"], "43");

    onPatch.mockClear();
    input = renderValue(undefined);
    input.value = "43";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["providerOptions", "deepgram", "temperature"], 43);

    onPatch.mockClear();
    input = renderValue(undefined, 42);
    input.value = "43";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["providerOptions", "deepgram", "temperature"], 43);

    onPatch.mockClear();
    input = renderValue(undefined, "42");
    input.value = "43";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["providerOptions", "deepgram", "temperature"], "43");

    onPatch.mockClear();
    input = renderValue("false");
    input.value = "true";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(
      ["providerOptions", "deepgram", "temperature"],
      "true",
    );

    onPatch.mockClear();
    input = renderValue(false);
    input.value = "true";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["providerOptions", "deepgram", "temperature"], true);

    onPatch.mockClear();
    const identifier = "1048113311314608148";
    input = renderValue(undefined);
    input.value = identifier;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(
      ["providerOptions", "deepgram", "temperature"],
      identifier,
    );
  });

  it.each([
    ["unset", undefined],
    ["number", 0],
  ] as const)(
    "keeps an initial %s branch stable while an identifier is typed",
    (_name, initial) => {
      const container = document.createElement("div");
      document.body.append(container);
      const identifier = "1048113311314608148";
      const schema = {
        anyOf: [{ type: "string", pattern: "^[0-9]{19}$" }, { type: "number" }],
      };
      const patches: unknown[] = [];
      let persisted: unknown = initial;
      let value: unknown = initial;

      const renderValue = () => {
        render(
          renderTextInput({
            schema,
            value,
            path: ["allowFrom"],
            hints: {},
            unsupported: new Set(),
            disabled: false,
            inputType: "text",
            onPatch: (_path, nextValue) => {
              patches.push(nextValue);
              persisted = nextValue;
              value = nextValue;
              // Model application immediately refreshes the rendered field.
              renderValue();
            },
          }),
          container,
        );
      };

      try {
        renderValue();
        let input = expectElement(
          container.querySelector<HTMLInputElement>("input[type='text']"),
          "incremental string-number input",
        );
        input.focus();
        input.value = "";
        for (const [index, digit] of Array.from(identifier).entries()) {
          input.value += digit;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          // A background refresh can land even when the prefix is not yet a
          // valid string branch; the focused edit must survive that repaint.
          renderValue();
          input = expectElement(
            container.querySelector<HTMLInputElement>("input[type='text']"),
            `incremental string-number input ${index + 1}`,
          );
        }

        expect(patches.length).toBeGreaterThan(1);
        expect(patches.slice(0, -1).every((candidate) => typeof candidate === "number")).toBe(true);
        expect(patches.at(-1)).toBe(identifier);
        expect(persisted).toBe(identifier);
        expect(value).toBe(identifier);
        expect(input.value).toBe(identifier);
        input.blur();
      } finally {
        container.remove();
      }
    },
  );

  it("does not commit a clear while a number input holds partial numeric text", () => {
    // Browsers report value === "" with validity.badInput while the user is
    // mid-keystroke ("0." on the way to "0.5"). Committing undefined here
    // deleted the stored value and wiped the input. jsdom never sets
    // badInput, so simulate the browser tuple explicitly.
    const container = document.createElement("div");
    const onPatch = vi.fn();
    render(
      renderNumberInput({
        schema: { type: "number" },
        value: 0,
        path: ["sampleRate"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch,
      }),
      container,
    );
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "partial numeric input",
    );
    Object.defineProperty(input, "validity", {
      value: { badInput: true },
      configurable: true,
    });
    Object.defineProperty(input, "value", {
      value: "",
      configurable: true,
      writable: true,
    });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onPatch).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");

    // A genuine clear (no badInput) still removes the optional override.
    Object.defineProperty(input, "validity", {
      value: { badInput: false },
      configurable: true,
    });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["sampleRate"], undefined);
  });

  it.each([
    ["unsafe integer", { type: "integer" }, "9007199254740993"],
    ["lossy decimal", { type: "number" }, "1.0000000000000001"],
    ["underflow", { type: "number" }, "1e-324"],
  ])("rejects %s text before a pure numeric input can round it", (_name, schema, raw) => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    render(
      renderNumberInput({
        schema,
        value: 0,
        path: ["numeric"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch,
      }),
      container,
    );
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "lossless number input",
    );

    input.value = raw;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe(raw);
  });

  it("accepts an exactly represented integer above the safe-integer range", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    render(
      renderNumberInput({
        schema: { type: "integer" },
        value: 0,
        path: ["numeric"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch,
      }),
      container,
    );
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "exact large number input",
    );

    input.value = "9007199254740992";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onPatch).toHaveBeenCalledWith(["numeric"], 9_007_199_254_740_992);
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it.each(["mixed", "number"] as const)(
    "renders an exact large integer as parser-valid text in a %s input",
    (kind) => {
      const container = document.createElement("div");
      const onPatch = vi.fn();
      const exactValue = Number("1000000000000000128");
      const params = {
        value: exactValue,
        path: ["numeric"],
        hints: {},
        unsupported: new Set<string>(),
        disabled: false,
        onPatch,
      };
      render(
        kind === "mixed"
          ? renderTextInput({
              ...params,
              schema: { anyOf: [{ type: "string" }, { type: "number" }] },
              inputType: "text",
            })
          : renderNumberInput({ ...params, schema: { type: "integer" } }),
        container,
      );
      const input = expectElement(
        container.querySelector<HTMLInputElement>(
          `input[type='${kind === "mixed" ? "text" : "number"}']`,
        ),
        `${kind} exact large number input`,
      );

      expect(input.value).toBe("1000000000000000128");
      input.dispatchEvent(new Event("input", { bubbles: true }));

      expect(onPatch).toHaveBeenCalledWith(["numeric"], exactValue);
      expect(input.getAttribute("aria-invalid")).toBe("false");
    },
  );

  it("conceals the default description while a sensitive value is concealed", () => {
    const container = document.createElement("div");

    render(
      renderTextInput({
        schema: { type: "string", default: "inherited" },
        value: "stored-secret",
        path: ["secret"],
        hints: { secret: { sensitive: true } },
        unsupported: new Set(),
        disabled: false,
        inputType: "text",
        revealSensitive: false,
        onPatch: vi.fn(),
        onRemove: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).not.toContain("inherited");
  });

  it("never reveals a server-redacted sentinel and keeps the input readonly", () => {
    const container = document.createElement("div");

    render(
      renderTextInput({
        schema: { type: "string" },
        value: "__OPENCLAW_REDACTED__",
        path: ["secret"],
        hints: { secret: { sensitive: true } },
        unsupported: new Set(),
        disabled: false,
        inputType: "text",
        // Even with reveal forced on, the sentinel is not the stored value;
        // showing it editable would let a stray edit overwrite the credential.
        revealSensitive: true,
        onToggleSensitivePath: vi.fn(),
        onPatch: vi.fn(),
        onRemove: vi.fn(),
      }),
      container,
    );

    const input = expectElement(
      container.querySelector<HTMLInputElement>("input"),
      "sentinel secret input",
    );
    expect(input.value).not.toContain("__OPENCLAW_REDACTED__");
    expect(input.readOnly).toBe(true);
    const eye = expectElement(
      container.querySelector<HTMLButtonElement>(".settings-secret__toggle"),
      "stored secret reveal toggle",
    );
    expect(eye.disabled).toBe(true);
    expect(eye.getAttribute("aria-label")).toBe(
      "Stored secrets are never sent to the browser; enter a new value to replace it",
    );
  });
});
