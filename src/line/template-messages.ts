import type { messagingApi } from "@line/bot-sdk";

type TemplateMessage = messagingApi.TemplateMessage;
type ConfirmTemplate = messagingApi.ConfirmTemplate;
type ButtonsTemplate = messagingApi.ButtonsTemplate;
type CarouselTemplate = messagingApi.CarouselTemplate;
type CarouselColumn = messagingApi.CarouselColumn;
type ImageCarouselTemplate = messagingApi.ImageCarouselTemplate;
type ImageCarouselColumn = messagingApi.ImageCarouselColumn;
type Action = messagingApi.Action;

/**
 * Create a confirm template (yes/no style dialog)
 */
export function createConfirmTemplate(
  text: string,
  confirmAction: Action,
  cancelAction: Action,
  altText?: string,
): TemplateMessage {
  const template: ConfirmTemplate = {
    type: "confirm",
    text: text.slice(0, 240), // LINE limit
    actions: [confirmAction, cancelAction],
  };

  return {
    type: "template",
    altText: altText?.slice(0, 400) ?? text.slice(0, 400),
    template,
  };
}

/**
 * Create a button template with title, text, and action buttons
 */
export function createButtonTemplate(
  title: string,
  text: string,
  actions: Action[],
  options?: {
    thumbnailImageUrl?: string;
    imageAspectRatio?: "rectangle" | "square";
    imageSize?: "cover" | "contain";
    imageBackgroundColor?: string;
    defaultAction?: Action;
    altText?: string;
  },
): TemplateMessage {
  const hasThumbnail = Boolean(options?.thumbnailImageUrl?.trim());
  const textLimit = hasThumbnail ? 160 : 60;
  const template: ButtonsTemplate = {
    type: "buttons",
    title: title.slice(0, 40), // LINE limit
    text: text.slice(0, textLimit), // LINE limit (60 if no thumbnail, 160 with thumbnail)
    actions: actions.slice(0, 4), // LINE limit: max 4 actions
    thumbnailImageUrl: options?.thumbnailImageUrl,
    imageAspectRatio: options?.imageAspectRatio ?? "rectangle",
    imageSize: options?.imageSize ?? "cover",
    imageBackgroundColor: options?.imageBackgroundColor,
    defaultAction: options?.defaultAction,
  };

  return {
    type: "template",
    altText: options?.altText?.slice(0, 400) ?? `${title}: ${text}`.slice(0, 400),
    template,
  };
}

/**
 * Create a carousel template with multiple columns
 */
export function createTemplateCarousel(
  columns: CarouselColumn[],
  options?: {
    imageAspectRatio?: "rectangle" | "square";
    imageSize?: "cover" | "contain";
    altText?: string;
  },
): TemplateMessage {
  const template: CarouselTemplate = {
    type: "carousel",
    columns: columns.slice(0, 10), // LINE limit: max 10 columns
    imageAspectRatio: options?.imageAspectRatio ?? "rectangle",
    imageSize: options?.imageSize ?? "cover",
  };

  return {
    type: "template",
    altText: options?.altText?.slice(0, 400) ?? "View carousel",
    template,
  };
}

/**
 * Create a carousel column for use with createTemplateCarousel
 */
export function createCarouselColumn(params: {
  title?: string;
  text: string;
  actions: Action[];
  thumbnailImageUrl?: string;
  imageBackgroundColor?: string;
  defaultAction?: Action;
}): CarouselColumn {
  return {
    title: params.title?.slice(0, 40),
    text: params.text.slice(0, 120), // LINE limit
    actions: params.actions.slice(0, 3), // LINE limit: max 3 actions per column
    thumbnailImageUrl: params.thumbnailImageUrl,
    imageBackgroundColor: params.imageBackgroundColor,
    defaultAction: params.defaultAction,
  };
}

/**
 * Create an image carousel template (simpler, image-focused carousel)
 */
export function createImageCarousel(
  columns: ImageCarouselColumn[],
  altText?: string,
): TemplateMessage {
  const template: ImageCarouselTemplate = {
    type: "image_carousel",
    columns: columns.slice(0, 10), // LINE limit: max 10 columns
  };

  return {
    type: "template",
    altText: altText?.slice(0, 400) ?? "View images",
    template,
  };
}

/**
 * Create an image carousel column for use with createImageCarousel
 */
export function createImageCarouselColumn(imageUrl: string, action: Action): ImageCarouselColumn {
  return {
    imageUrl,
    action,
  };
}

// ============================================================================
// Action Helpers (same as rich-menu but re-exported for convenience)
// ============================================================================

/**
 * Create a message action (sends text when tapped)
 */
export function messageAction(label: string, text?: string): Action {
  return {
    type: "message",
    label: label.slice(0, 20),
    text: text ?? label,
  };
}

/**
 * Create a URI action (opens a URL when tapped)
 */
export function uriAction(label: string, uri: string): Action {
  return {
    type: "uri",
    label: label.slice(0, 20),
    uri,
  };
}

/**
 * Create a postback action (sends data to webhook when tapped)
 */
export function postbackAction(label: string, data: string, displayText?: string): Action {
  return {
    type: "postback",
    label: label.slice(0, 20),
    data: data.slice(0, 300),
    displayText: displayText?.slice(0, 300),
  };
}

/**
 * Create a datetime picker action
 */
export function datetimePickerAction(
  label: string,
  data: string,
  mode: "date" | "time" | "datetime",
  options?: {
    initial?: string;
    max?: string;
    min?: string;
  },
): Action {
  return {
    type: "datetimepicker",
    label: label.slice(0, 20),
    data: data.slice(0, 300),
    mode,
    initial: options?.initial,
    max: options?.max,
    min: options?.min,
  };
}

// ============================================================================
// Convenience Builders
// ============================================================================

/**
 * Create a simple yes/no confirmation dialog
 */
export function createYesNoConfirm(
  question: string,
  options?: {
    yesText?: string;
    noText?: string;
    yesData?: string;
    noData?: string;
    altText?: string;
  },
): TemplateMessage {
  const yesAction: Action = options?.yesData
    ? postbackAction(options.yesText ?? "Yes", options.yesData, options.yesText ?? "Yes")
    : messageAction(options?.yesText ?? "Yes");

  const noAction: Action = options?.noData
    ? postbackAction(options.noText ?? "No", options.noData, options.noText ?? "No")
    : messageAction(options?.noText ?? "No");

  return createConfirmTemplate(question, yesAction, noAction, options?.altText);
}

/**
 * Create a button menu with simple text buttons
 */
export function createButtonMenu(
  title: string,
  text: string,
  buttons: Array<{ label: string; text?: string }>,
  options?: {
    thumbnailImageUrl?: string;
    altText?: string;
  },
): TemplateMessage {
  const actions = buttons.slice(0, 4).map((btn) => messageAction(btn.label, btn.text));

  return createButtonTemplate(title, text, actions, {
    thumbnailImageUrl: options?.thumbnailImageUrl,
    altText: options?.altText,
  });
}

/**
 * Create a button menu with URL links
 */
export function createLinkMenu(
  title: string,
  text: string,
  links: Array<{ label: string; url: string }>,
  options?: {
    thumbnailImageUrl?: string;
    altText?: string;
  },
): TemplateMessage {
  const actions = links.slice(0, 4).map((link) => uriAction(link.label, link.url));

  return createButtonTemplate(title, text, actions, {
    thumbnailImageUrl: options?.thumbnailImageUrl,
    altText: options?.altText,
  });
}

/**
 * Create a simple product/item carousel
 */
export function createProductCarousel(
  products: Array<{
    title: string;
    description: string;
    imageUrl?: string;
    price?: string;
    actionLabel?: string;
    actionUrl?: string;
    actionData?: string;
  }>,
  altText?: string,
): TemplateMessage {
  const columns = products.slice(0, 10).map((product) => {
    const actions: Action[] = [];

    // Add main action
    if (product.actionUrl) {
      actions.push(uriAction(product.actionLabel ?? "View", product.actionUrl));
    } else if (product.actionData) {
      actions.push(postbackAction(product.actionLabel ?? "Select", product.actionData));
    } else {
      actions.push(messageAction(product.actionLabel ?? "Select", product.title));
    }

    return createCarouselColumn({
      title: product.title,
      text: product.price
        ? `${product.description}\n${product.price}`.slice(0, 120)
        : product.description,
      thumbnailImageUrl: product.imageUrl,
      actions,
    });
  });

  return createTemplateCarousel(columns, { altText });
}

// ============================================================================
// ReplyPayload Conversion
// ============================================================================

import type { LineTemplateMessagePayload } from "./types.js";

/**
 * Convert a TemplateMessagePayload from ReplyPayload to a LINE TemplateMessage
 */
export function buildTemplateMessageFromPayload(
  payload: LineTemplateMessagePayload,
): TemplateMessage | null {
  switch (payload.type) {
    case "confirm": {
      const confirmAction = payload.confirmData.startsWith("http")
        ? uriAction(payload.confirmLabel, payload.confirmData)
        : payload.confirmData.includes("=")
          ? postbackAction(payload.confirmLabel, payload.confirmData, payload.confirmLabel)
          : messageAction(payload.confirmLabel, payload.confirmData);

      const cancelAction = payload.cancelData.startsWith("http")
        ? uriAction(payload.cancelLabel, payload.cancelData)
        : payload.cancelData.includes("=")
          ? postbackAction(payload.cancelLabel, payload.cancelData, payload.cancelLabel)
          : messageAction(payload.cancelLabel, payload.cancelData);

      return createConfirmTemplate(payload.text, confirmAction, cancelAction, payload.altText);
    }

    case "buttons": {
      const actions: Action[] = payload.actions.slice(0, 4).map((action) => {
        if (action.type === "uri" && action.uri) {
          return uriAction(action.label, action.uri);
        }
        if (action.type === "postback" && action.data) {
          return postbackAction(action.label, action.data, action.label);
        }
        // Default to message action
        return messageAction(action.label, action.data ?? action.label);
      });

      return createButtonTemplate(payload.title, payload.text, actions, {
        thumbnailImageUrl: payload.thumbnailImageUrl,
        altText: payload.altText,
      });
    }

    case "carousel": {
      const columns: CarouselColumn[] = payload.columns.slice(0, 10).map((col) => {
        const colActions: Action[] = col.actions.slice(0, 3).map((action) => {
          if (action.type === "uri" && action.uri) {
            return uriAction(action.label, action.uri);
          }
          if (action.type === "postback" && action.data) {
            return postbackAction(action.label, action.data, action.label);
          }
          return messageAction(action.label, action.data ?? action.label);
        });

        return createCarouselColumn({
          title: col.title,
          text: col.text,
          thumbnailImageUrl: col.thumbnailImageUrl,
          actions: colActions,
        });
      });

      return createTemplateCarousel(columns, { altText: payload.altText });
    }

    default:
      return null;
  }
}

// Re-export types
export type {
  TemplateMessage,
  ConfirmTemplate,
  ButtonsTemplate,
  CarouselTemplate,
  CarouselColumn,
  ImageCarouselTemplate,
  ImageCarouselColumn,
  Action,
};
