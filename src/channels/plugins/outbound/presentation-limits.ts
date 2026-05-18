import type {
  MessagePresentation,
  MessagePresentationBlock,
  MessagePresentationButton,
  MessagePresentationOption,
} from "../../../interactive/payload.js";
import type { ChannelPresentationCapabilities } from "../outbound.types.js";

type ActionLimits = NonNullable<NonNullable<ChannelPresentationCapabilities["limits"]>["actions"]>;
type SelectLimits = NonNullable<NonNullable<ChannelPresentationCapabilities["limits"]>["selects"]>;
type TextLimits = NonNullable<NonNullable<ChannelPresentationCapabilities["limits"]>["text"]>;
type ActionBudget = {
  remainingActions?: number;
  remainingRows?: number;
  maxActionsPerRow?: number;
};
type ButtonCandidate = {
  original: MessagePresentationButton;
  adapted?: MessagePresentationButton;
};
type SelectCandidate = {
  original: MessagePresentationOption;
  adapted?: MessagePresentationOption;
};
type ButtonSelection = ReadonlySet<MessagePresentationButton> | undefined;

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function truncateText(value: string, maxLength: number | undefined): string {
  const limit = positiveInteger(maxLength);
  if (!limit) {
    return value;
  }
  const chars = Array.from(value);
  return chars.length > limit ? chars.slice(0, limit).join("") : value;
}

function truncateUtf8Bytes(value: string, limit: number): string {
  let bytes = 0;
  let result = "";
  for (const char of value) {
    const nextBytes = utf8ByteLength(char);
    if (bytes + nextBytes > limit) {
      break;
    }
    bytes += nextBytes;
    result += char;
  }
  return result;
}

function truncatePresentationText(value: string, limits: TextLimits | undefined): string {
  const limit = positiveInteger(limits?.maxLength);
  if (!limit) {
    return value;
  }
  if (limits?.encoding === "utf8-bytes") {
    return truncateUtf8Bytes(value, limit);
  }
  if (limits?.encoding === "utf16-units") {
    return value.length > limit ? value.slice(0, limit) : value;
  }
  const chars = Array.from(value);
  return chars.length > limit ? chars.slice(0, limit).join("") : value;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function fitsByteLimit(value: string | undefined, maxBytes: number | undefined): boolean {
  const limit = positiveInteger(maxBytes);
  return !value || !limit || utf8ByteLength(value) <= limit;
}

function fallbackListBlock(params: {
  blockType: "context" | "text";
  heading: string;
  labels: readonly string[];
  maxLabelLength?: number;
}): MessagePresentationBlock | undefined {
  const labels = params.labels
    .map((label) => truncateText(label, params.maxLabelLength).trim())
    .filter(Boolean);
  return labels.length > 0
    ? {
        type: params.blockType,
        text: `${params.heading}:\n${labels.map((label) => `- ${label}`).join("\n")}`,
      }
    : undefined;
}

function buttonFallbackLabel(
  button: MessagePresentationButton,
  maxLabelLength: number | undefined,
): string {
  const label = truncateText(button.label, maxLabelLength);
  const target = button.url ?? button.webApp?.url ?? button.web_app?.url;
  return target ? `${label}: ${target}` : label;
}

function actionCapacity(limits: ActionLimits | undefined): number | undefined {
  const maxActions = positiveInteger(limits?.maxActions);
  const maxRows = positiveInteger(limits?.maxRows);
  const maxActionsPerRow = positiveInteger(limits?.maxActionsPerRow);
  const rowCapacity = maxRows && maxActionsPerRow ? maxRows * maxActionsPerRow : undefined;
  if (maxActions && rowCapacity) {
    return Math.min(maxActions, rowCapacity);
  }
  return maxActions ?? rowCapacity;
}

function buttonCapacityAfterReservedSelects(
  limits: ActionLimits | undefined,
  reservedSelects: number,
): number | undefined {
  const maxActions = positiveInteger(limits?.maxActions);
  const maxRows = positiveInteger(limits?.maxRows);
  const maxActionsPerRow = positiveInteger(limits?.maxActionsPerRow);
  const remainingActions =
    maxActions === undefined ? undefined : Math.max(0, maxActions - reservedSelects);
  const remainingRows = maxRows === undefined ? undefined : Math.max(0, maxRows - reservedSelects);
  const rowCapacity =
    remainingRows !== undefined && maxActionsPerRow !== undefined
      ? remainingRows * maxActionsPerRow
      : undefined;
  if (remainingActions !== undefined && rowCapacity !== undefined) {
    return Math.min(remainingActions, rowCapacity);
  }
  return remainingActions ?? rowCapacity;
}

function createActionBudget(limits: ActionLimits | undefined): ActionBudget {
  return {
    remainingActions: positiveInteger(limits?.maxActions),
    remainingRows: positiveInteger(limits?.maxRows),
    maxActionsPerRow: positiveInteger(limits?.maxActionsPerRow),
  };
}

function buttonCapacity(budget: ActionBudget): number | undefined {
  if (budget.remainingActions === 0 || budget.remainingRows === 0) {
    return 0;
  }
  const rowCapacity =
    budget.remainingRows && budget.maxActionsPerRow
      ? budget.remainingRows * budget.maxActionsPerRow
      : undefined;
  if (budget.remainingActions !== undefined && rowCapacity !== undefined) {
    return Math.min(budget.remainingActions, rowCapacity);
  }
  return budget.remainingActions ?? rowCapacity;
}

function consumeButtonBudget(budget: ActionBudget, count: number): void {
  if (count <= 0) {
    return;
  }
  if (budget.remainingActions !== undefined) {
    budget.remainingActions = Math.max(0, budget.remainingActions - count);
  }
  if (budget.remainingRows !== undefined) {
    const perRow = budget.maxActionsPerRow ?? count;
    budget.remainingRows = Math.max(0, budget.remainingRows - Math.ceil(count / perRow));
  }
}

function chunkButtons(
  buttons: readonly MessagePresentationButton[],
  maxActionsPerRow: number | undefined,
): MessagePresentationButton[][] {
  const rowSize = positiveInteger(maxActionsPerRow);
  if (!rowSize) {
    return buttons.length > 0 ? [[...buttons]] : [];
  }
  const rows: MessagePresentationButton[][] = [];
  for (let index = 0; index < buttons.length; index += rowSize) {
    rows.push(buttons.slice(index, index + rowSize));
  }
  return rows;
}

function hasActionSlotBudget(budget: ActionBudget): boolean {
  return budget.remainingActions !== 0 && budget.remainingRows !== 0;
}

function consumeSelectBudget(budget: ActionBudget): void {
  if (budget.remainingActions !== undefined) {
    budget.remainingActions = Math.max(0, budget.remainingActions - 1);
  }
  if (budget.remainingRows !== undefined) {
    budget.remainingRows = Math.max(0, budget.remainingRows - 1);
  }
}

function adaptButton(
  button: MessagePresentationButton,
  limits: ActionLimits | undefined,
): MessagePresentationButton | undefined {
  const hasLinkTarget = Boolean(button.url || button.webApp || button.web_app);
  const valueFits = fitsByteLimit(button.value, limits?.maxValueBytes);
  if (
    (!valueFits && !hasLinkTarget) ||
    (button.disabled === true && limits?.supportsDisabled !== true)
  ) {
    return undefined;
  }
  const adapted: MessagePresentationButton = {
    ...button,
    label: truncateText(button.label, limits?.maxLabelLength),
  };
  if (!valueFits) {
    delete adapted.value;
  }
  if (limits?.supportsStyles === false) {
    delete adapted.style;
  }
  return adapted;
}

function adaptButtonsBlock(
  block: Extract<MessagePresentationBlock, { type: "buttons" }>,
  limits: ActionLimits | undefined,
  budget: ActionBudget,
  fallbackBlockType: "context" | "text",
  buttonSelection: ButtonSelection,
): MessagePresentationBlock[] {
  const capacity = buttonCapacity(budget);
  const candidates: ButtonCandidate[] = block.buttons.map((button) => ({
    original: button,
    adapted: adaptButton(button, limits),
  }));
  const renderableCandidates = candidates.filter(
    (candidate): candidate is ButtonCandidate & { adapted: MessagePresentationButton } =>
      Boolean(candidate.adapted),
  );
  const eligibleCandidates = buttonSelection
    ? renderableCandidates.filter((candidate) => buttonSelection.has(candidate.original))
    : renderableCandidates;
  const selectedCandidates =
    capacity !== undefined && eligibleCandidates.length > capacity
      ? eligibleCandidates
          .map((candidate, index) => ({ candidate, index }))
          .toSorted((left, right) => {
            const priorityDelta =
              (right.candidate.adapted.priority ?? 0) - (left.candidate.adapted.priority ?? 0);
            return priorityDelta || left.index - right.index;
          })
          .slice(0, capacity)
          .map((entry) => entry.candidate)
      : eligibleCandidates;
  const selected = new Set<ButtonCandidate>(selectedCandidates);
  const buttons = selectedCandidates.map((candidate) => candidate.adapted);
  const droppedLabels = candidates
    .filter((candidate) => !candidate.adapted || !selected.has(candidate))
    .map((candidate) => buttonFallbackLabel(candidate.original, limits?.maxLabelLength));
  consumeButtonBudget(budget, buttons.length);
  const fallback = fallbackListBlock({
    blockType: fallbackBlockType,
    heading: "Actions",
    labels: droppedLabels,
  });
  if (buttons.length === 0) {
    return fallback ? [fallback] : [];
  }
  const blocks: MessagePresentationBlock[] = chunkButtons(buttons, limits?.maxActionsPerRow).map(
    (row) => ({
      type: "buttons",
      buttons: row,
    }),
  );
  if (fallback) {
    blocks.push(fallback);
  }
  return blocks;
}

function appendAdaptedButtonsBlock(
  blocks: MessagePresentationBlock[],
  block: Extract<MessagePresentationBlock, { type: "buttons" }>,
  limits: ActionLimits | undefined,
  budget: ActionBudget,
  fallbackBlockType: "context" | "text",
  buttonSelection: ButtonSelection,
): void {
  blocks.push(...adaptButtonsBlock(block, limits, budget, fallbackBlockType, buttonSelection));
}

function adaptOption(
  option: MessagePresentationOption,
  limits: SelectLimits | undefined,
): MessagePresentationOption | undefined {
  if (!fitsByteLimit(option.value, limits?.maxValueBytes)) {
    return undefined;
  }
  return {
    ...option,
    label: truncateText(option.label, limits?.maxLabelLength),
  };
}

function adaptSelectBlock(
  block: Extract<MessagePresentationBlock, { type: "select" }>,
  limits: SelectLimits | undefined,
  budget: ActionBudget,
  fallbackBlockType: "context" | "text",
): MessagePresentationBlock[] {
  const candidates: SelectCandidate[] = block.options.map((option) => ({
    original: option,
    adapted: adaptOption(option, limits),
  }));
  const renderableCandidates = candidates.filter(
    (candidate): candidate is SelectCandidate & { adapted: MessagePresentationOption } =>
      Boolean(candidate.adapted),
  );
  const maxOptions = positiveInteger(limits?.maxOptions);
  const selectedCandidates = maxOptions
    ? renderableCandidates.slice(0, maxOptions)
    : renderableCandidates;
  const selected = new Set<SelectCandidate>(selectedCandidates);
  const options = selectedCandidates.map((candidate) => candidate.adapted);
  const canRenderSelect = options.length > 0 && hasActionSlotBudget(budget);
  const fallback = fallbackListBlock({
    blockType: fallbackBlockType,
    heading: block.placeholder ?? "Options",
    labels: (canRenderSelect
      ? candidates.filter((candidate) => !candidate.adapted || !selected.has(candidate))
      : candidates
    ).map((candidate) => candidate.original.label),
    maxLabelLength: limits?.maxLabelLength,
  });
  if (!canRenderSelect) {
    return fallback ? [fallback] : [];
  }
  consumeSelectBudget(budget);
  const blocks: MessagePresentationBlock[] = [
    {
      type: "select",
      placeholder: truncateText(block.placeholder ?? "", limits?.maxLabelLength) || undefined,
      options,
    },
  ];
  if (fallback) {
    blocks.push(fallback);
  }
  return blocks;
}

function countRenderableSelectBlocks(
  blocks: readonly MessagePresentationBlock[],
  capabilities: ChannelPresentationCapabilities | undefined,
  limits: SelectLimits | undefined,
): number {
  if (capabilities?.selects === false) {
    return 0;
  }
  return blocks.filter((block) => {
    if (block.type !== "select") {
      return false;
    }
    const maxOptions = positiveInteger(limits?.maxOptions);
    const renderableOptions = block.options
      .map((option) => adaptOption(option, limits))
      .filter(Boolean)
      .slice(0, maxOptions ?? undefined);
    return renderableOptions.length > 0;
  }).length;
}

function createGlobalButtonSelection(params: {
  presentation: MessagePresentation;
  capabilities: ChannelPresentationCapabilities | undefined;
  limits: ActionLimits | undefined;
  selectLimits: SelectLimits | undefined;
}): ButtonSelection {
  if (params.capabilities?.buttons === false) {
    return undefined;
  }
  const reservedSelectSlots = countRenderableSelectBlocks(
    params.presentation.blocks,
    params.capabilities,
    params.selectLimits,
  );
  const capacity = buttonCapacityAfterReservedSelects(params.limits, reservedSelectSlots);
  if (capacity === undefined) {
    return undefined;
  }
  const candidates = params.presentation.blocks.flatMap((block) => {
    if (block.type !== "buttons") {
      return [];
    }
    return block.buttons
      .map((button) => ({
        original: button,
        adapted: adaptButton(button, params.limits),
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          original: MessagePresentationButton;
          adapted: MessagePresentationButton;
        } => Boolean(candidate.adapted),
      );
  });
  if (candidates.length <= capacity) {
    return undefined;
  }
  return new Set(
    candidates
      .map((candidate, index) => ({ candidate, index }))
      .toSorted((left, right) => {
        const priorityDelta =
          (right.candidate.adapted.priority ?? 0) - (left.candidate.adapted.priority ?? 0);
        return priorityDelta || left.index - right.index;
      })
      .slice(0, capacity)
      .map((entry) => entry.candidate.original),
  );
}

function adaptTextBlock(
  block: MessagePresentationBlock,
  limits: TextLimits | undefined,
): MessagePresentationBlock {
  if (block.type === "text" || block.type === "context") {
    return {
      ...block,
      text: truncatePresentationText(block.text, limits),
    };
  }
  return block;
}

/**
 * Adapt a portable presentation to the target channel's advertised capabilities.
 *
 * Unsupported controls are downgraded to text/context fallback blocks where possible, and
 * labels, values, rows, options, styles, disabled state, and text are clipped to channel limits.
 */
export function adaptMessagePresentationForChannel(params: {
  presentation: MessagePresentation;
  capabilities?: ChannelPresentationCapabilities;
}): MessagePresentation {
  const capabilities = params.capabilities;
  const limits = params.capabilities?.limits;
  const actionBudget = createActionBudget(limits?.actions);
  const fallbackBlockType = capabilities?.context === false ? "text" : "context";
  const buttonSelection = createGlobalButtonSelection({
    presentation: params.presentation,
    capabilities,
    limits: limits?.actions,
    selectLimits: limits?.selects,
  });
  const blocks: MessagePresentationBlock[] = [];
  for (const block of params.presentation.blocks) {
    if (block.type === "buttons") {
      if (capabilities?.buttons === false) {
        const fallback = fallbackListBlock({
          blockType: fallbackBlockType,
          heading: "Actions",
          labels: block.buttons.map((button) =>
            buttonFallbackLabel(button, limits?.actions?.maxLabelLength),
          ),
        });
        if (fallback) {
          blocks.push(fallback);
        }
        continue;
      }
      appendAdaptedButtonsBlock(
        blocks,
        block,
        limits?.actions,
        actionBudget,
        fallbackBlockType,
        buttonSelection,
      );
      continue;
    }
    if (block.type === "select") {
      if (capabilities?.selects === false) {
        const fallback = fallbackListBlock({
          blockType: fallbackBlockType,
          heading: block.placeholder ?? "Options",
          labels: block.options.map((option) => option.label),
          maxLabelLength: limits?.selects?.maxLabelLength,
        });
        if (fallback) {
          blocks.push(fallback);
        }
        continue;
      }
      blocks.push(...adaptSelectBlock(block, limits?.selects, actionBudget, fallbackBlockType));
      continue;
    }
    if (block.type === "context" && capabilities?.context === false) {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "divider" && capabilities?.divider === false) {
      continue;
    }
    blocks.push(block);
  }
  return {
    ...params.presentation,
    ...(params.presentation.title
      ? { title: truncatePresentationText(params.presentation.title, limits?.text) }
      : {}),
    blocks: blocks.map((block) => adaptTextBlock(block, limits?.text)),
  };
}

/** Return the subset of buttons that can still be rendered under action limits. */
export function applyPresentationActionLimits(
  buttons: readonly MessagePresentationButton[],
  capabilities?: ChannelPresentationCapabilities,
): MessagePresentationButton[] {
  const block = adaptButtonsBlock(
    { type: "buttons", buttons: [...buttons] },
    capabilities?.limits?.actions,
    createActionBudget(capabilities?.limits?.actions),
    capabilities?.context === false ? "text" : "context",
    undefined,
  );
  return block.flatMap((entry) => (entry.type === "buttons" ? entry.buttons : []));
}

/** Resolve an action page size that leaves room for reserved actions on the target channel. */
export function presentationPageSize(
  capabilities?: ChannelPresentationCapabilities,
  reservedActions = 0,
  maxPageSize = Number.POSITIVE_INFINITY,
): number {
  const capacity = actionCapacity(capabilities?.limits?.actions);
  const remaining = Math.max(0, (capacity ?? maxPageSize) - Math.max(0, reservedActions));
  return Math.max(1, Math.min(remaining || 1, maxPageSize));
}
