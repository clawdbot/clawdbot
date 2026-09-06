/**
 * Presentation limit adapters for channel outbound payloads.
 *
 * Splits text and reshapes portable controls to match per-channel limits.
 */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  renderMessagePresentationChartFallbackText,
  renderMessagePresentationControlFallbackLabel,
  renderMessagePresentationTableFallbackText,
  resolveMessagePresentationActionValue,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
} from "../../../interactive/payload.js";
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

const PRESENTATION_FALLBACK_CONTINUATION = Symbol.for(
  "openclaw.presentation.fallback-continuation",
);

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function truncateText(value: string, maxLength: number | undefined): string {
  const limit = positiveInteger(maxLength);
  if (!limit || value.length <= limit) {
    return value;
  }
  // A code point uses at most two UTF-16 units; later units cannot affect this prefix.
  return Array.from(value.slice(0, limit * 2))
    .slice(0, limit)
    .join("");
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
    return truncateUtf16Safe(value, limit);
  }
  return truncateText(value, limit);
}

function splitPresentationText(value: string, limits: TextLimits | undefined): string[] {
  const limit = positiveInteger(limits?.maxLength);
  if (!limit || truncatePresentationText(value, limits) === value) {
    return [value];
  }
  const chunks: string[] = [];
  let remaining = value;
  while (remaining) {
    const prefix = truncatePresentationText(remaining, limits);
    if (!prefix || prefix === remaining) {
      chunks.push(remaining);
      break;
    }
    // Keep complete fallback lines together when possible. Retain the newline
    // itself so concatenating the blocks reconstructs every authored character.
    const newlineIndex = prefix.lastIndexOf("\n");
    const splitIndex = newlineIndex > 0 ? newlineIndex + 1 : prefix.length;
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }
  return chunks;
}

function presentationTextBlocks(params: {
  blockType: "context" | "text";
  text: string;
  limits?: TextLimits;
  continuation?: boolean;
}): Array<{ type: "context" | "text"; text: string }> {
  return splitPresentationText(params.text, params.limits).map((text, index) => {
    const block = { type: params.blockType, text };
    if (index > 0 || params.continuation) {
      // Native fallback renderers must reassemble split fragments without inserting paragraph breaks.
      Object.defineProperty(block, PRESENTATION_FALLBACK_CONTINUATION, { value: true });
    }
    return block;
  });
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function fitsByteLimit(value: string | undefined, maxBytes: number | undefined): boolean {
  const limit = positiveInteger(maxBytes);
  return !value || !limit || utf8ByteLength(value) <= limit;
}

function fallbackListBlocks(params: {
  blockType: "context" | "text";
  heading: string;
  labels: readonly string[];
  limits?: TextLimits;
}): MessagePresentationBlock[] {
  const labels = normalizeStringEntries(params.labels);
  if (labels.length === 0) {
    return [];
  }
  // Action labels are operator-visible content; split like chart/table fallbacks instead of dropping them.
  return presentationTextBlocks({
    blockType: params.blockType,
    text: `${params.heading}:\n${labels.map((label) => `- ${label}`).join("\n")}`,
    limits: params.limits,
  });
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

function consumeSelectBudget(budget: ActionBudget, count = 1): void {
  if (budget.remainingActions !== undefined) {
    budget.remainingActions = Math.max(0, budget.remainingActions - count);
  }
  if (budget.remainingRows !== undefined) {
    budget.remainingRows = Math.max(0, budget.remainingRows - count);
  }
}

function adaptButton(
  button: MessagePresentationButton,
  limits: ActionLimits | undefined,
): MessagePresentationButton | undefined {
  const hasExplicitAction = button.action !== undefined;
  const action = resolveMessagePresentationButtonAction(button);
  if (!action) {
    return undefined;
  }
  const actionValue = resolveMessagePresentationActionValue(action);
  const actionFits = actionValue === undefined || fitsByteLimit(actionValue, limits?.maxValueBytes);
  const legacyValueFits = fitsByteLimit(button.value, limits?.maxValueBytes);
  if (
    (hasExplicitAction ? !actionFits : action.type === "callback" && !legacyValueFits) ||
    (button.disabled === true && limits?.supportsDisabled !== true)
  ) {
    return undefined;
  }
  const adapted: MessagePresentationButton = {
    ...button,
    label: truncateText(button.label, limits?.maxLabelLength),
  };
  if (!legacyValueFits) {
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
  textLimits?: TextLimits,
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
    .map((candidate) => renderMessagePresentationControlFallbackLabel(candidate.original));
  consumeButtonBudget(budget, buttons.length);
  const fallback = fallbackListBlocks({
    blockType: fallbackBlockType,
    heading: "Actions",
    labels: droppedLabels,
    limits: textLimits,
  });
  if (buttons.length === 0) {
    return fallback;
  }
  const blocks: MessagePresentationBlock[] = chunkButtons(buttons, limits?.maxActionsPerRow).map(
    (row) => ({
      type: "buttons",
      buttons: row,
    }),
  );
  blocks.push(...fallback);
  return blocks;
}

function adaptOption(
  option: MessagePresentationOption,
  limits: SelectLimits | undefined,
): MessagePresentationOption | undefined {
  const hasExplicitAction = option.action !== undefined;
  const action = resolveMessagePresentationOptionAction(option);
  if (!action) {
    return undefined;
  }
  const actionValue = resolveMessagePresentationActionValue(action);
  const actionFits = actionValue === undefined || fitsByteLimit(actionValue, limits?.maxValueBytes);
  const legacyValueFits = fitsByteLimit(option.value, limits?.maxValueBytes);
  if (hasExplicitAction ? !actionFits : !legacyValueFits) {
    return undefined;
  }
  const adapted: MessagePresentationOption = {
    ...option,
    label: truncateText(option.label, limits?.maxLabelLength),
  };
  if (!legacyValueFits) {
    delete adapted.value;
  }
  return adapted;
}

function adaptSelectBlock(
  block: Extract<MessagePresentationBlock, { type: "select" }>,
  limits: SelectLimits | undefined,
  budget: ActionBudget,
  fallbackBlockType: "context" | "text",
  textLimits?: TextLimits,
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
  const fallback = fallbackListBlocks({
    blockType: fallbackBlockType,
    heading: block.placeholder ?? "Options",
    labels: (canRenderSelect
      ? candidates.filter((candidate) => !candidate.adapted || !selected.has(candidate))
      : candidates
    ).map((candidate) => renderMessagePresentationControlFallbackLabel(candidate.original)),
    limits: textLimits,
  });
  if (!canRenderSelect) {
    return fallback;
  }
  consumeSelectBudget(budget);
  const blocks: MessagePresentationBlock[] = [
    {
      type: "select",
      ...(block.placeholder
        ? { placeholder: truncateText(block.placeholder, limits?.maxLabelLength) }
        : {}),
      options,
    },
  ];
  blocks.push(...fallback);
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
  let count = 0;
  for (const block of blocks) {
    // A valid maxOptions is at least one, so one accepted option reserves the slot.
    if (block.type === "select" && block.options.some((option) => adaptOption(option, limits))) {
      count += 1;
    }
  }
  return count;
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
  const reservationBudget = createActionBudget(params.limits);
  consumeSelectBudget(
    reservationBudget,
    countRenderableSelectBlocks(
      params.presentation.blocks,
      params.capabilities,
      params.selectLimits,
    ),
  );
  // Without a per-row size, row-only limits follow authored block order rather than preselecting buttons.
  const capacity =
    reservationBudget.remainingRows === 0 && reservationBudget.maxActionsPerRow === undefined
      ? reservationBudget.remainingActions
      : buttonCapacity(reservationBudget);
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

/**
 * Adapt a portable presentation to the target channel's advertised capabilities.
 *
 * Unsupported controls are downgraded to text/context fallback blocks where possible, and
 * controls honor channel limits while authored and fallback text retain every character.
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
  const titleBlocks = params.presentation.title
    ? presentationTextBlocks({
        blockType: "text",
        text: params.presentation.title,
        limits: limits?.text,
      })
    : [];
  const blocks: MessagePresentationBlock[] = titleBlocks.slice(1);
  for (const block of params.presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      blocks.push(
        ...presentationTextBlocks({
          blockType: block.type === "context" ? fallbackBlockType : "text",
          text: block.text,
          limits: limits?.text,
          continuation:
            Object.getOwnPropertyDescriptor(block, PRESENTATION_FALLBACK_CONTINUATION)?.value ===
            true,
        }),
      );
      continue;
    }
    if (block.type === "chart" && capabilities?.charts !== true) {
      blocks.push(
        ...presentationTextBlocks({
          blockType: fallbackBlockType,
          text: renderMessagePresentationChartFallbackText(block),
          limits: limits?.text,
        }),
      );
      continue;
    }
    if (block.type === "table" && capabilities?.tables !== true) {
      blocks.push(
        ...presentationTextBlocks({
          blockType: fallbackBlockType,
          text: renderMessagePresentationTableFallbackText(block),
          limits: limits?.text,
        }),
      );
      continue;
    }
    if (block.type === "buttons") {
      if (capabilities?.buttons === false) {
        blocks.push(
          ...fallbackListBlocks({
            blockType: fallbackBlockType,
            heading: "Actions",
            labels: block.buttons.map(renderMessagePresentationControlFallbackLabel),
            limits: limits?.text,
          }),
        );
        continue;
      }
      blocks.push(
        ...adaptButtonsBlock(
          block,
          limits?.actions,
          actionBudget,
          fallbackBlockType,
          buttonSelection,
          limits?.text,
        ),
      );
      continue;
    }
    if (block.type === "select") {
      if (capabilities?.selects === false) {
        blocks.push(
          ...fallbackListBlocks({
            blockType: fallbackBlockType,
            heading: block.placeholder ?? "Options",
            labels: block.options.map(renderMessagePresentationControlFallbackLabel),
            limits: limits?.text,
          }),
        );
        continue;
      }
      blocks.push(
        ...adaptSelectBlock(block, limits?.selects, actionBudget, fallbackBlockType, limits?.text),
      );
      continue;
    }
    if (block.type === "divider" && capabilities?.divider === false) {
      continue;
    }
    blocks.push(block);
  }
  return {
    ...params.presentation,
    ...(params.presentation.title ? { title: titleBlocks[0]?.text } : {}),
    blocks,
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
    capabilities?.limits?.text,
  );
  return block.flatMap((entry) => (entry.type === "buttons" ? entry.buttons : []));
}

/** Resolve an action page size that leaves room for reserved actions on the target channel. */
export function presentationPageSize(
  capabilities?: ChannelPresentationCapabilities,
  reservedActions = 0,
  maxPageSize = Number.POSITIVE_INFINITY,
): number {
  const capacity = buttonCapacity(createActionBudget(capabilities?.limits?.actions));
  const remaining = Math.max(0, (capacity ?? maxPageSize) - Math.max(0, reservedActions));
  return Math.max(1, Math.min(remaining || 1, maxPageSize));
}
