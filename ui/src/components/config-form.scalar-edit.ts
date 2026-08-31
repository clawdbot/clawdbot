// Scalar edit sessions keep their initial primitive branch while focused rerenders apply patches.
type ScalarValueBranch = "string" | "number" | "boolean";

export type ScalarEditHint = {
  branch?: ScalarValueBranch;
};

type ScalarEditState = {
  edit?: ScalarEditHint;
  pathKey: string;
  presentationIdentity: string;
  rowIdentity: unknown;
};

const scalarEditState = new WeakMap<HTMLInputElement, ScalarEditState>();

export function scalarValueBranch(value: unknown): ScalarValueBranch | undefined {
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return undefined;
}

export function syncScalarEditIdentity(
  element: Element | undefined,
  rowIdentity: unknown,
  pathKey: string,
  presentationIdentity: string,
): void {
  if (!(element instanceof HTMLInputElement)) {
    return;
  }
  const previous = scalarEditState.get(element);
  const preserveEdit =
    previous?.edit !== undefined &&
    element.ownerDocument.activeElement === element &&
    Object.is(previous.rowIdentity, rowIdentity) &&
    previous.pathKey === pathKey &&
    previous.presentationIdentity === presentationIdentity;
  scalarEditState.set(element, {
    edit: preserveEdit ? previous.edit : undefined,
    pathKey,
    presentationIdentity,
    rowIdentity,
  });
}

export function beginScalarEdit(
  target: HTMLInputElement,
  initialBranch: ScalarValueBranch | undefined,
): ScalarEditHint {
  const state = scalarEditState.get(target);
  if (!state) {
    return { branch: initialBranch };
  }
  state.edit ??= { branch: initialBranch };
  return state.edit;
}

export function scalarEditHintForInput(
  target: HTMLInputElement,
  initialBranch: ScalarValueBranch | undefined,
): ScalarEditHint {
  return scalarEditState.get(target)?.edit ?? { branch: initialBranch };
}

export function finishScalarEdit(target: HTMLInputElement): void {
  const state = scalarEditState.get(target);
  if (state) {
    state.edit = undefined;
  }
}

export function finishScalarEditFromEvent(event: Event): void {
  if (event.currentTarget instanceof HTMLInputElement) {
    finishScalarEdit(event.currentTarget);
  }
}
