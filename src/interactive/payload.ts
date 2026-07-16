// Interactive payload helpers normalize structured interactive UI payloads.
import { asOptionalRecord as toRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isWellFormedApprovalId } from "../../packages/gateway-protocol/src/schema/approval-id.js";

export type InteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";

/** Visual tone for a portable message presentation. */
export type MessagePresentationTone = "info" | "success" | "warning" | "danger" | "neutral";

/** Button style hint for renderers that support styled actions. */
export type MessagePresentationButtonStyle = InteractiveButtonStyle;

/** Portable typed action behind a button or select option. */
export type MessagePresentationAction =
  | {
      /** Run a core/plugin slash command through the target channel's native command path. */
      type: "command";
      command: string;
    }
  | {
      /** Opaque callback value interpreted by the target channel/plugin. */
      type: "callback";
      value: string;
    }
  | {
      /** Resolve one durable operator approval without exposing transport callback data. */
      type: "approval";
      approvalId: string;
      approvalKind: "exec" | "plugin";
      decision: "allow-once" | "allow-always" | "deny";
    }
  | {
      /** Open a normal external link. */
      type: "url";
      url: string;
    }
  | {
      /** Launch a channel-native web app. */
      type: "web-app";
      /** External web app URL for channels that launch web apps by URL. */
      url: string;
      /** OpenClaw hosted-widget ID whose launch mechanics are owned by the channel. */
      widgetId?: string;
    }
  | {
      /** Launch a channel-native web app. */
      type: "web-app";
      /** External web app URL for channels that launch web apps by URL. */
      url?: string;
      /** OpenClaw hosted-widget ID whose launch mechanics are owned by the channel. */
      widgetId: string;
    };

/** Portable action control rendered as a button or link by channel adapters. */
export type MessagePresentationButton = {
  /** User-visible button label. */
  label: string;
  /** Typed action sent when the button is pressed. */
  action?: MessagePresentationAction;
  /**
   * Legacy opaque callback value sent when the button is pressed.
   * Prefer action for new presentation controls.
   * @deprecated Use action.
   */
  value?: string;
  /** @deprecated Use an action with type "url". */
  url?: string;
  /** @deprecated Use an action with type "web-app". */
  webApp?: {
    url: string;
  };
  /**
   * @deprecated Use an action with type "web-app". Accepted for legacy JSON payloads only.
   */
  web_app?: {
    url: string;
  };
  /** Higher-priority buttons are kept first when channel limits require truncation. */
  priority?: number;
  /** Disable the button when the target channel supports disabled controls. */
  disabled?: boolean;
  /** Keep this action available after a successful interaction when the target channel supports it. */
  reusable?: boolean;
  /** Optional visual style hint; unsupported channels ignore or normalize it. */
  style?: InteractiveButtonStyle;
};

/** Portable select/menu option. */
export type MessagePresentationOption = {
  /** User-visible option label. */
  label: string;
  /** Typed action sent when the option is selected. */
  action?: Extract<MessagePresentationAction, { type: "command" | "callback" }>;
  /** @deprecated Use action. */
  value?: string;
};

export function resolveMessagePresentationActionValue(
  action: MessagePresentationAction | undefined,
): string | undefined {
  if (action?.type === "command") {
    return action.command;
  }
  if (action?.type === "callback") {
    return action.value;
  }
  return undefined;
}

export function resolveMessagePresentationControlValue(control: {
  action?: MessagePresentationAction;
  value?: string;
}): string | undefined {
  if (control.action !== undefined) {
    const action = normalizePresentationAction(control.action);
    return action ? resolveMessagePresentationActionValue(action) : undefined;
  }
  return control.value;
}

/** Resolve a canonical button action, including deprecated boundary inputs. */
export function resolveMessagePresentationButtonAction(
  button: Pick<MessagePresentationButton, "action" | "url" | "value" | "webApp" | "web_app">,
): MessagePresentationAction | undefined {
  if (button.action !== undefined) {
    return normalizePresentationAction(button.action);
  }
  if (button.url) {
    return { type: "url", url: button.url };
  }
  const webAppUrl = button.webApp?.url ?? button.web_app?.url;
  if (webAppUrl) {
    return { type: "web-app", url: webAppUrl };
  }
  return button.value ? { type: "callback", value: button.value } : undefined;
}

/** Resolve a canonical select action, including the deprecated value input. */
export function resolveMessagePresentationOptionAction(
  option: Pick<MessagePresentationOption, "action" | "value">,
): Extract<MessagePresentationAction, { type: "command" | "callback" }> | undefined {
  if (option.action !== undefined) {
    const action = normalizePresentationAction(option.action);
    return action?.type === "command" || action?.type === "callback" ? action : undefined;
  }
  return option.value ? { type: "callback", value: option.value } : undefined;
}

/**
 * @deprecated Use MessagePresentationButton.
 */
export type InteractiveReplyButton = MessagePresentationButton;

/**
 * @deprecated Use MessagePresentationOption.
 */
export type InteractiveReplyOption = MessagePresentationOption;

/**
 * @deprecated Use MessagePresentationTextBlock.
 */
export type InteractiveReplyTextBlock = {
  type: "text";
  text: string;
};

/**
 * @deprecated Use MessagePresentationButtonsBlock.
 */
type InteractiveReplyButtonsBlock = {
  type: "buttons";
  buttons: InteractiveReplyButton[];
};

/**
 * @deprecated Use MessagePresentationSelectBlock.
 */
export type InteractiveReplySelectBlock = {
  type: "select";
  placeholder?: string;
  options: InteractiveReplyOption[];
};

/**
 * @deprecated Use MessagePresentationBlock.
 */
export type InteractiveReplyBlock =
  | InteractiveReplyTextBlock
  | InteractiveReplyButtonsBlock
  | InteractiveReplySelectBlock;

/**
 * @deprecated Use MessagePresentation.
 */
export type InteractiveReply = {
  blocks: InteractiveReplyBlock[];
};

export type MessagePresentationTextBlock = {
  type: "text";
  /** Primary markdown-ish text rendered in the message body. */
  text: string;
};

export type MessagePresentationContextBlock = {
  type: "context";
  /** Lower-emphasis contextual text, or normal text on channels without context support. */
  text: string;
};

export type MessagePresentationDividerBlock = {
  type: "divider";
};

export type MessagePresentationButtonsBlock = {
  type: "buttons";
  /** Button row candidates; core may split or truncate them for channel limits. */
  buttons: MessagePresentationButton[];
};

export type MessagePresentationSelectBlock = {
  type: "select";
  /** Optional prompt shown above or inside the select control. */
  placeholder?: string;
  /** Menu options; core may truncate them for channel limits. */
  options: MessagePresentationOption[];
};

export type MessagePresentationChartSegment = {
  /** Category label shown in the chart legend. */
  label: string;
  /** Positive segment magnitude. */
  value: number;
};

export type MessagePresentationChartSeries = {
  /** Unique series name shown in the chart legend. */
  name: string;
  /** One finite value for each chart category, in category order. */
  values: number[];
};

export type MessagePresentationChartBlock =
  | {
      type: "chart";
      chartType: "pie";
      /** Short chart heading. */
      title: string;
      segments: MessagePresentationChartSegment[];
    }
  | {
      type: "chart";
      chartType: "bar" | "area" | "line";
      /** Short chart heading. */
      title: string;
      /** Ordered categories shared by every series. */
      categories: string[];
      series: MessagePresentationChartSeries[];
      xLabel?: string;
      yLabel?: string;
    };

/** Scalar cell value supported by portable table presentations. */
export type MessagePresentationTableCell = string | number;

/** Portable table rendered natively where supported and linearly elsewhere. */
export type MessagePresentationTableBlock = {
  type: "table";
  /** Short table heading used by native renderers and fallback text. */
  caption: string;
  /** Unique ordered column labels shared by every row. */
  headers: string[];
  /** Rows whose width exactly matches the header count. */
  rows: MessagePresentationTableCell[][];
  /** Optional column whose cells should be rendered as row headers. */
  rowHeaderColumnIndex?: number;
};

export type MessagePresentationInteractiveBlock =
  | MessagePresentationButtonsBlock
  | MessagePresentationSelectBlock;

export type MessagePresentationBlock =
  | MessagePresentationTextBlock
  | MessagePresentationContextBlock
  | MessagePresentationDividerBlock
  | MessagePresentationButtonsBlock
  | MessagePresentationSelectBlock
  | MessagePresentationChartBlock
  | MessagePresentationTableBlock;

export type MessagePresentation = {
  /** Optional short heading rendered before blocks when the channel supports it. */
  title?: string;
  /** Optional severity/status tone for renderers that support toned presentations. */
  tone?: MessagePresentationTone;
  /** Ordered portable blocks rendered or downgraded by the target channel adapter. */
  blocks: MessagePresentationBlock[];
};

export type ReplyPayloadDeliveryPin = {
  enabled: boolean;
  notify?: boolean;
  required?: boolean;
};

export type ReplyPayloadDelivery = {
  pin?: boolean | ReplyPayloadDeliveryPin;
};

function normalizeButtonStyle(value: unknown): InteractiveButtonStyle | undefined {
  const style = normalizeOptionalLowercaseString(value);
  return style === "primary" || style === "secondary" || style === "success" || style === "danger"
    ? style
    : undefined;
}

function normalizePresentationTone(value: unknown): MessagePresentationTone | undefined {
  const tone = normalizeOptionalLowercaseString(value);
  return tone === "info" ||
    tone === "success" ||
    tone === "warning" ||
    tone === "danger" ||
    tone === "neutral"
    ? tone
    : undefined;
}

function normalizePresentationAction(raw: unknown): MessagePresentationAction | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const type = normalizeOptionalLowercaseString(record.type);
  if (type === "command") {
    const command = normalizeOptionalString(record.command);
    return command ? { type: "command", command } : undefined;
  }
  if (type === "callback") {
    const value = normalizeOptionalString(record.value);
    return value ? { type: "callback", value } : undefined;
  }
  if (type === "approval") {
    if (record.type !== "approval") {
      return undefined;
    }
    const approvalId = record.approvalId;
    const approvalKind = record.approvalKind;
    const decision = record.decision;
    if (
      typeof approvalId !== "string" ||
      !isWellFormedApprovalId(approvalId) ||
      (approvalKind !== "exec" && approvalKind !== "plugin") ||
      (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny")
    ) {
      return undefined;
    }
    return { type: "approval", approvalId, approvalKind, decision };
  }
  if (type === "url") {
    const url = normalizeOptionalString(record.url);
    return url ? { type: "url", url } : undefined;
  }
  if (type === "web-app") {
    const url = normalizeOptionalString(record.url);
    const widgetId = normalizeOptionalString(record.widgetId);
    if (url) {
      return { type: "web-app", url, ...(widgetId ? { widgetId } : {}) };
    }
    return widgetId ? { type: "web-app", widgetId } : undefined;
  }
  return undefined;
}

function normalizeButton(raw: unknown): InteractiveReplyButton | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const label = normalizeOptionalString(record.label) ?? normalizeOptionalString(record.text);
  const value =
    normalizeOptionalString(record.value) ??
    normalizeOptionalString(record.callbackData) ??
    normalizeOptionalString(record.callback_data);
  const url = normalizeOptionalString(record.url);
  const webAppRecord = toRecord(record.webApp) ?? toRecord(record.web_app);
  const webAppUrl = normalizeOptionalString(webAppRecord?.url);
  const action =
    record.action !== undefined ? normalizePresentationAction(record.action) : undefined;
  if (
    !label ||
    (record.action !== undefined && !action) ||
    (!action && !value && !url && !webAppUrl)
  ) {
    return undefined;
  }
  const priority =
    typeof record.priority === "number" && Number.isFinite(record.priority)
      ? record.priority
      : undefined;
  return {
    label,
    ...(action ? { action } : {}),
    ...(value ? { value } : {}),
    ...(url ? { url } : {}),
    ...(webAppUrl ? { webApp: { url: webAppUrl } } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(record.disabled === true ? { disabled: true } : {}),
    ...(record.reusable === true ? { reusable: true } : {}),
    style: normalizeButtonStyle(record.style),
  };
}

function normalizeOption(raw: unknown): InteractiveReplyOption | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const label = normalizeOptionalString(record.label) ?? normalizeOptionalString(record.text);
  const value = normalizeOptionalString(record.value);
  const normalizedAction =
    record.action !== undefined ? normalizePresentationAction(record.action) : undefined;
  const action =
    normalizedAction?.type === "command" || normalizedAction?.type === "callback"
      ? normalizedAction
      : undefined;
  if (!label || (record.action !== undefined && !action) || (!action && !value)) {
    return undefined;
  }
  return { label, ...(action ? { action } : {}), ...(value ? { value } : {}) };
}

function normalizeList<T>(value: unknown, normalizeEntry: (entry: unknown) => T | undefined): T[] {
  return Array.isArray(value)
    ? value.map((entry) => normalizeEntry(entry)).filter((entry): entry is T => Boolean(entry))
    : [];
}

function normalizeInteractiveBlock(raw: unknown): InteractiveReplyBlock | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const type = normalizeOptionalLowercaseString(record.type);
  if (type === "text") {
    const text = normalizeOptionalString(record.text);
    return text ? { type: "text", text } : undefined;
  }
  if (type === "buttons") {
    const buttons = normalizeList(record.buttons, normalizeButton);
    return buttons.length > 0 ? { type: "buttons", buttons } : undefined;
  }
  if (type === "select") {
    const options = normalizeList(record.options, normalizeOption);
    return options.length > 0
      ? {
          type: "select",
          placeholder: normalizeOptionalString(record.placeholder),
          options,
        }
      : undefined;
  }
  return undefined;
}

function normalizeChartSegments(value: unknown): MessagePresentationChartSegment[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const segments = value.map((entry) => {
    const record = toRecord(entry);
    const label = normalizeOptionalString(record?.label);
    const segmentValue = record?.value;
    return label && typeof segmentValue === "number" && Number.isFinite(segmentValue)
      ? { label, value: segmentValue }
      : undefined;
  });
  return segments.every((segment): segment is MessagePresentationChartSegment =>
    Boolean(segment && segment.value > 0),
  )
    ? segments
    : undefined;
}

function normalizeChartCategories(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const categories = value.map((entry) => normalizeOptionalString(entry));
  if (categories.some((entry) => !entry)) {
    return undefined;
  }
  const normalized = categories as string[];
  return new Set(normalized).size === normalized.length ? normalized : undefined;
}

function normalizeChartSeries(params: {
  value: unknown;
  categoryCount: number;
}): MessagePresentationChartSeries[] | undefined {
  if (!Array.isArray(params.value) || params.value.length === 0) {
    return undefined;
  }
  const series = params.value.map((entry) => {
    const record = toRecord(entry);
    const name = normalizeOptionalString(record?.name);
    const values = record?.values;
    if (
      !name ||
      !Array.isArray(values) ||
      values.length !== params.categoryCount ||
      !values.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      return undefined;
    }
    return { name, values: values as number[] };
  });
  if (
    !series.every((entry): entry is MessagePresentationChartSeries => Boolean(entry)) ||
    new Set(series.map((entry) => entry.name)).size !== series.length
  ) {
    return undefined;
  }
  return series;
}

function normalizeChartBlock(
  record: Record<string, unknown>,
): MessagePresentationChartBlock | undefined {
  const title = normalizeOptionalString(record.title);
  const chartType = normalizeOptionalLowercaseString(record.chartType);
  if (!title) {
    return undefined;
  }
  if (chartType === "pie") {
    const segments = normalizeChartSegments(record.segments);
    return segments ? { type: "chart", chartType, title, segments } : undefined;
  }
  if (chartType !== "bar" && chartType !== "area" && chartType !== "line") {
    return undefined;
  }
  const categories = normalizeChartCategories(record.categories);
  if (!categories) {
    return undefined;
  }
  const series = normalizeChartSeries({ value: record.series, categoryCount: categories.length });
  if (!series) {
    return undefined;
  }
  const xLabel = normalizeOptionalString(record.xLabel);
  const yLabel = normalizeOptionalString(record.yLabel);
  return {
    type: "chart",
    chartType,
    title,
    categories,
    series,
    ...(xLabel ? { xLabel } : {}),
    ...(yLabel ? { yLabel } : {}),
  };
}

function normalizeTableBlock(
  record: Record<string, unknown>,
): MessagePresentationTableBlock | undefined {
  const caption = normalizeOptionalString(record.caption);
  if (!caption || !Array.isArray(record.headers) || record.headers.length === 0) {
    return undefined;
  }
  const headers = record.headers.map((header) => normalizeOptionalString(header));
  if (
    !headers.every((header): header is string => Boolean(header)) ||
    new Set(headers).size !== headers.length ||
    !Array.isArray(record.rows) ||
    record.rows.length === 0
  ) {
    return undefined;
  }
  const rows = record.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== headers.length) {
      return undefined;
    }
    const cells = row.map((cell) => {
      if (typeof cell === "number") {
        return Number.isFinite(cell) ? cell : undefined;
      }
      return normalizeOptionalString(cell);
    });
    return cells.every((cell): cell is MessagePresentationTableCell => cell !== undefined)
      ? cells
      : undefined;
  });
  if (!rows.every((row): row is MessagePresentationTableCell[] => Boolean(row))) {
    return undefined;
  }
  const rowHeaderColumnIndex = record.rowHeaderColumnIndex;
  if (
    rowHeaderColumnIndex !== undefined &&
    (typeof rowHeaderColumnIndex !== "number" ||
      !Number.isInteger(rowHeaderColumnIndex) ||
      rowHeaderColumnIndex < 0 ||
      rowHeaderColumnIndex >= headers.length)
  ) {
    return undefined;
  }
  return {
    type: "table",
    caption,
    headers,
    rows,
    ...(typeof rowHeaderColumnIndex === "number" ? { rowHeaderColumnIndex } : {}),
  };
}

/**
 * @deprecated Use normalizeMessagePresentation.
 */
export function normalizeInteractiveReply(raw: unknown): InteractiveReply | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const blocks = normalizeList(record.blocks, normalizeInteractiveBlock);
  return blocks.length > 0 ? { blocks } : undefined;
}

function normalizePresentationBlock(raw: unknown): MessagePresentationBlock | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const type = normalizeOptionalLowercaseString(record.type);
  if (type === "text" || type === "context") {
    const text = normalizeOptionalString(record.text);
    return text ? { type, text } : undefined;
  }
  if (type === "divider") {
    return { type: "divider" };
  }
  if (type === "buttons") {
    const buttons = normalizeList(record.buttons, normalizeButton);
    return buttons.length > 0 ? { type: "buttons", buttons } : undefined;
  }
  if (type === "select") {
    const options = normalizeList(record.options, normalizeOption);
    return options.length > 0
      ? {
          type: "select",
          placeholder: normalizeOptionalString(record.placeholder),
          options,
        }
      : undefined;
  }
  if (type === "chart") {
    return normalizeChartBlock(record);
  }
  if (type === "table") {
    return normalizeTableBlock(record);
  }
  return undefined;
}

export function normalizeMessagePresentation(raw: unknown): MessagePresentation | undefined {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }
  const blocks = normalizeList(record.blocks, normalizePresentationBlock);
  const title = normalizeOptionalString(record.title);
  if (!title && blocks.length === 0) {
    return undefined;
  }
  return {
    ...(title ? { title } : {}),
    tone: normalizePresentationTone(record.tone),
    blocks,
  };
}

/**
 * @deprecated Use hasMessagePresentationBlocks.
 */
export function hasInteractiveReplyBlocks(value: unknown): value is InteractiveReply {
  return Boolean(normalizeInteractiveReply(value));
}

export function hasMessagePresentationBlocks(value: unknown): value is MessagePresentation {
  return Boolean(normalizeMessagePresentation(value));
}

/**
 * @deprecated Avoid producing InteractiveReply payloads; send MessagePresentation directly.
 */
export function presentationToInteractiveReply(
  presentation: MessagePresentation,
): InteractiveReply | undefined {
  const blocks: InteractiveReplyBlock[] = [];
  if (presentation.title) {
    blocks.push({ type: "text", text: presentation.title });
  }
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "buttons") {
      const buttons = block.buttons
        .filter((button) => resolveMessagePresentationButtonAction(button))
        .map((button) => {
          const interactiveButton: InteractiveReplyButton = {
            label: button.label,
            style: button.style,
          };
          if (button.action) {
            interactiveButton.action = button.action;
            const actionValue = resolveMessagePresentationActionValue(button.action);
            if (actionValue) {
              interactiveButton.value = actionValue;
            } else if (button.action.type === "url") {
              interactiveButton.url = button.action.url;
            } else if (button.action.type === "web-app" && button.action.url) {
              interactiveButton.webApp = { url: button.action.url };
            }
          } else {
            if (button.value) {
              interactiveButton.value = button.value;
            }
            if (button.url) {
              interactiveButton.url = button.url;
            }
            const webApp = button.webApp ?? button.web_app;
            if (webApp) {
              interactiveButton.webApp = webApp;
            }
          }
          if (button.priority !== undefined) {
            interactiveButton.priority = button.priority;
          }
          if (button.disabled === true) {
            interactiveButton.disabled = true;
          }
          if (button.reusable === true) {
            interactiveButton.reusable = true;
          }
          return interactiveButton;
        });
      if (buttons.length > 0) {
        blocks.push({ type: "buttons", buttons });
      }
      continue;
    }
    if (block.type === "chart") {
      blocks.push({ type: "text", text: renderMessagePresentationChartFallbackText(block) });
      continue;
    }
    if (block.type === "table") {
      blocks.push({ type: "text", text: renderMessagePresentationTableFallbackText(block) });
      continue;
    }
    if (block.type === "select") {
      blocks.push({
        type: "select",
        placeholder: block.placeholder,
        options: block.options.map((option) => {
          const interactiveOption: InteractiveReplyOption = {
            label: option.label,
          };
          if (option.action !== undefined) {
            const action = resolveMessagePresentationOptionAction(option);
            if (action) {
              interactiveOption.action = action;
              const actionValue = resolveMessagePresentationActionValue(action);
              if (actionValue) {
                interactiveOption.value = actionValue;
              }
            }
          } else if (option.value) {
            interactiveOption.value = option.value;
          }
          return interactiveOption;
        }),
      });
    }
  }
  return blocks.length > 0 ? { blocks } : undefined;
}

export function isMessagePresentationInteractiveBlock(
  block: MessagePresentationBlock,
): block is MessagePresentationInteractiveBlock {
  return block.type === "buttons" || block.type === "select";
}

/**
 * @deprecated Avoid producing InteractiveReply payloads; send MessagePresentation directly.
 */
export function presentationToInteractiveControlsReply(
  presentation: MessagePresentation,
): InteractiveReply | undefined {
  return presentationToInteractiveReply({
    blocks: presentation.blocks.filter(isMessagePresentationInteractiveBlock),
  });
}

/**
 * @deprecated Legacy bridge for old InteractiveReply payloads. New producers should send MessagePresentation.
 */
export function interactiveReplyToPresentation(
  interactive: InteractiveReply,
): MessagePresentation | undefined {
  const blocks = interactive.blocks.map((block): MessagePresentationBlock => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "buttons") {
      return { type: "buttons", buttons: block.buttons };
    }
    return {
      type: "select",
      placeholder: block.placeholder,
      options: block.options,
    };
  });
  return blocks.length > 0 ? { blocks } : undefined;
}

/**
 * Render presentation blocks as plain-text fallback for channels that do not
 * support native interactive controls.
 *
 * Text and context blocks are rendered as-is. Buttons with a `command`-typed
 * action render as `label: \`command\`` so the value is copyable. URL and web
 * app actions include their user-facing URL. Approval, callback, legacy value,
 * and select actions render label-only to keep transport data private. Disabled
 * buttons render label-only regardless of action type.
 *
 * Downstream consumers should not claim a manual command is available unless
 * they verify one was actually rendered.
 *
 * Exported through the plugin SDK for channel adapters.
 */
export function renderMessagePresentationChartFallbackText(
  block: MessagePresentationChartBlock,
): string {
  const lines = [`${block.title} (${block.chartType} chart)`];
  if (block.chartType === "pie") {
    lines.push(...block.segments.map((segment) => `- ${segment.label}: ${String(segment.value)}`));
    return lines.join("\n");
  }
  if (block.xLabel) {
    lines.push(`X axis: ${block.xLabel}`);
  }
  if (block.yLabel) {
    lines.push(`Y axis: ${block.yLabel}`);
  }
  lines.push(
    ...block.series.map(
      (series) =>
        `- ${series.name}: ${block.categories
          .map((category, index) => `${category}: ${String(series.values[index])}`)
          .join("; ")}`,
    ),
  );
  return lines.join("\n");
}

function renderTableFallbackValue(value: MessagePresentationTableCell): string {
  return String(value).replace(/\s+/g, " ").trim();
}

export function renderMessagePresentationTableFallbackText(
  block: MessagePresentationTableBlock,
): string {
  const headers = block.headers.map(renderTableFallbackValue);
  const lines = [`${renderTableFallbackValue(block.caption)} (table)`];
  lines.push(
    ...block.rows.map(
      (row) =>
        `- ${row
          .map((cell, index) => `${headers[index]}: ${renderTableFallbackValue(cell)}`)
          .join("; ")}`,
    ),
  );
  return lines.join("\n");
}

export function renderMessagePresentationFallbackText(params: {
  presentation?: MessagePresentation;
  emptyFallback?: string | null;
  text?: string | null;
}): string {
  const lines: string[] = [];
  const text = normalizeOptionalString(params.text);
  if (text) {
    lines.push(text);
  }
  const presentation = params.presentation;
  if (!presentation) {
    return lines.join("\n\n");
  }
  if (presentation.title) {
    lines.push(presentation.title);
  }
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      lines.push(block.text);
      continue;
    }
    if (block.type === "buttons") {
      const labels = block.buttons
        .map((button) => {
          if (button.disabled) {
            return button.label;
          }
          const action = resolveMessagePresentationButtonAction(button);
          if (action?.type === "url" || (action?.type === "web-app" && action.url)) {
            return `${button.label}: ${action.url}`;
          }
          if (action?.type === "command") {
            return `${button.label}: \`${action.command}\``;
          }
          return button.label;
        })
        .filter(Boolean);
      if (labels.length > 0) {
        lines.push(labels.map((label) => `- ${label}`).join("\n"));
      }
      continue;
    }
    if (block.type === "chart") {
      lines.push(renderMessagePresentationChartFallbackText(block));
      continue;
    }
    if (block.type === "table") {
      lines.push(renderMessagePresentationTableFallbackText(block));
      continue;
    }
    if (block.type === "select") {
      const labels = block.options.map((option) => option.label).filter(Boolean);
      if (labels.length > 0) {
        const heading = block.placeholder ? `${block.placeholder}:` : "Options:";
        lines.push(`${heading}\n${labels.map((label) => `- ${label}`).join("\n")}`);
      }
    }
  }
  const rendered = lines.join("\n\n");
  return rendered || normalizeOptionalString(params.emptyFallback) || "";
}

export function hasReplyChannelData(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0,
  );
}

export function hasReplyContent(params: {
  text?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: ReadonlyArray<string | null | undefined>;
  interactive?: unknown;
  presentation?: unknown;
  hasChannelData?: boolean;
  extraContent?: boolean;
}): boolean {
  const text = normalizeOptionalString(params.text);
  const mediaUrl = normalizeOptionalString(params.mediaUrl);
  return Boolean(
    text ||
    mediaUrl ||
    params.mediaUrls?.some((entry) => Boolean(normalizeOptionalString(entry))) ||
    hasMessagePresentationBlocks(params.presentation) ||
    hasInteractiveReplyBlocks(params.interactive) ||
    params.hasChannelData ||
    params.extraContent,
  );
}

export function hasReplyPayloadContent(
  payload: {
    text?: string | null;
    mediaUrl?: string | null;
    mediaUrls?: ReadonlyArray<string | null | undefined>;
    interactive?: unknown;
    presentation?: unknown;
    channelData?: unknown;
    location?: unknown;
  },
  options?: {
    trimText?: boolean;
    hasChannelData?: boolean;
    extraContent?: boolean;
  },
): boolean {
  return hasReplyContent({
    text: options?.trimText ? payload.text?.trim() : payload.text,
    mediaUrl: payload.mediaUrl,
    mediaUrls: payload.mediaUrls,
    interactive: payload.interactive,
    presentation: payload.presentation,
    hasChannelData: options?.hasChannelData ?? hasReplyChannelData(payload.channelData),
    extraContent: options?.extraContent ?? payload.location != null,
  });
}

/**
 * @deprecated Use renderMessagePresentationFallbackText with MessagePresentation.
 */
export function resolveInteractiveTextFallback(params: {
  text?: string;
  interactive?: InteractiveReply;
}): string | undefined {
  const text = normalizeOptionalString(params.text);
  if (text) {
    return params.text;
  }
  const interactiveText = (params.interactive?.blocks ?? [])
    .filter((block): block is InteractiveReplyTextBlock => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return interactiveText || params.text;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
