import { attachFooterText } from "./common.js";
import type {
  Action,
  CardAction,
  FlexBox,
  FlexBubble,
  FlexButton,
  FlexCarousel,
  FlexComponent,
  FlexImage,
  FlexText,
  ListItem,
} from "./types.js";

/**
 * Create an info card with title, body, and optional footer
 *
 * Editorial design: Clean hierarchy with accent bar, generous spacing,
 * and subtle background zones for visual separation.
 */
export function createInfoCard(title: string, body: string, footer?: string): FlexBubble {
  const bubble: FlexBubble = {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        // Title with accent bar
        {
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "box",
              layout: "vertical",
              contents: [],
              width: "4px",
              backgroundColor: "#06C755",
              cornerRadius: "2px",
            } as FlexBox,
            {
              type: "text",
              text: title,
              weight: "bold",
              size: "xl",
              color: "#111111",
              wrap: true,
              flex: 1,
              margin: "lg",
            } as FlexText,
          ],
        } as FlexBox,
        // Body text in subtle container
        {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "text",
              text: body,
              size: "md",
              color: "#444444",
              wrap: true,
              lineSpacing: "6px",
            } as FlexText,
          ],
          margin: "xl",
          paddingAll: "lg",
          backgroundColor: "#F8F9FA",
          cornerRadius: "lg",
        } as FlexBox,
      ],
      paddingAll: "xl",
      backgroundColor: "#FFFFFF",
    },
  };

  if (footer) {
    attachFooterText(bubble, footer);
  }

  return bubble;
}

/**
 * Create a list card with title and multiple items
 *
 * Editorial design: Numbered/bulleted list with clear visual hierarchy,
 * accent dots for each item, and generous spacing.
 */
export function createListCard(title: string, items: ListItem[]): FlexBubble {
  const itemContents: FlexComponent[] = items.slice(0, 8).map((item, index) => {
    const itemContents: FlexComponent[] = [
      {
        type: "text",
        text: item.title,
        size: "md",
        weight: "bold",
        color: "#1a1a1a",
        wrap: true,
      } as FlexText,
    ];

    if (item.subtitle) {
      itemContents.push({
        type: "text",
        text: item.subtitle,
        size: "sm",
        color: "#888888",
        wrap: true,
        margin: "xs",
      } as FlexText);
    }

    const itemBox: FlexBox = {
      type: "box",
      layout: "horizontal",
      contents: [
        // Accent dot
        {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "box",
              layout: "vertical",
              contents: [],
              width: "8px",
              height: "8px",
              backgroundColor: index === 0 ? "#06C755" : "#DDDDDD",
              cornerRadius: "4px",
            } as FlexBox,
          ],
          width: "20px",
          alignItems: "center",
          paddingTop: "sm",
        } as FlexBox,
        // Item content
        {
          type: "box",
          layout: "vertical",
          contents: itemContents,
          flex: 1,
        } as FlexBox,
      ],
      margin: index > 0 ? "lg" : undefined,
    };

    if (item.action) {
      itemBox.action = item.action;
    }

    return itemBox;
  });

  return {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: title,
          weight: "bold",
          size: "xl",
          color: "#111111",
          wrap: true,
        } as FlexText,
        {
          type: "separator",
          margin: "lg",
          color: "#EEEEEE",
        },
        {
          type: "box",
          layout: "vertical",
          contents: itemContents,
          margin: "lg",
        } as FlexBox,
      ],
      paddingAll: "xl",
      backgroundColor: "#FFFFFF",
    },
  };
}

/**
 * Create an image card with image, title, and optional body text
 */
export function createImageCard(
  imageUrl: string,
  title: string,
  body?: string,
  options?: {
    aspectRatio?: "1:1" | "1.51:1" | "1.91:1" | "4:3" | "16:9" | "20:13" | "2:1" | "3:1";
    aspectMode?: "cover" | "fit";
    action?: Action;
  },
): FlexBubble {
  const bubble: FlexBubble = {
    type: "bubble",
    hero: {
      type: "image",
      url: imageUrl,
      size: "full",
      aspectRatio: options?.aspectRatio ?? "20:13",
      aspectMode: options?.aspectMode ?? "cover",
      action: options?.action,
    } as FlexImage,
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: title,
          weight: "bold",
          size: "xl",
          wrap: true,
        } as FlexText,
      ],
      paddingAll: "lg",
    },
  };

  if (body && bubble.body) {
    bubble.body.contents.push({
      type: "text",
      text: body,
      size: "md",
      wrap: true,
      margin: "md",
      color: "#666666",
    } as FlexText);
  }

  return bubble;
}

/**
 * Create an action card with title, body, and action buttons
 */
export function createActionCard(
  title: string,
  body: string,
  actions: CardAction[],
  options?: {
    imageUrl?: string;
    aspectRatio?: "1:1" | "1.51:1" | "1.91:1" | "4:3" | "16:9" | "20:13" | "2:1" | "3:1";
  },
): FlexBubble {
  const bubble: FlexBubble = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: title,
          weight: "bold",
          size: "xl",
          wrap: true,
        } as FlexText,
        {
          type: "text",
          text: body,
          size: "md",
          wrap: true,
          margin: "md",
          color: "#666666",
        } as FlexText,
      ],
      paddingAll: "lg",
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: actions.slice(0, 4).map(
        (action, index) =>
          ({
            type: "button",
            action: action.action,
            style: index === 0 ? "primary" : "secondary",
            margin: index > 0 ? "sm" : undefined,
          }) as FlexButton,
      ),
      paddingAll: "md",
    },
  };

  if (options?.imageUrl) {
    bubble.hero = {
      type: "image",
      url: options.imageUrl,
      size: "full",
      aspectRatio: options.aspectRatio ?? "20:13",
      aspectMode: "cover",
    } as FlexImage;
  }

  return bubble;
}

/**
 * Create a carousel container from multiple bubbles
 * LINE allows max 12 bubbles in a carousel
 */
export function createCarousel(bubbles: FlexBubble[]): FlexCarousel {
  return {
    type: "carousel",
    contents: bubbles.slice(0, 12),
  };
}

/**
 * Create a notification bubble (for alerts, status updates)
 *
 * Editorial design: Bold status indicator with accent color,
 * clear typography, optional icon for context.
 */
export function createNotificationBubble(
  text: string,
  options?: {
    icon?: string;
    type?: "info" | "success" | "warning" | "error";
    title?: string;
  },
): FlexBubble {
  // Color based on notification type
  const colors = {
    info: { accent: "#3B82F6", bg: "#EFF6FF" },
    success: { accent: "#06C755", bg: "#F0FDF4" },
    warning: { accent: "#F59E0B", bg: "#FFFBEB" },
    error: { accent: "#EF4444", bg: "#FEF2F2" },
  };
  const typeColors = colors[options?.type ?? "info"];

  const contents: FlexComponent[] = [];

  // Accent bar
  contents.push({
    type: "box",
    layout: "vertical",
    contents: [],
    width: "4px",
    backgroundColor: typeColors.accent,
    cornerRadius: "2px",
  } as FlexBox);

  // Content section
  const textContents: FlexComponent[] = [];

  if (options?.title) {
    textContents.push({
      type: "text",
      text: options.title,
      size: "md",
      weight: "bold",
      color: "#111111",
      wrap: true,
    } as FlexText);
  }

  textContents.push({
    type: "text",
    text,
    size: options?.title ? "sm" : "md",
    color: options?.title ? "#666666" : "#333333",
    wrap: true,
    margin: options?.title ? "sm" : undefined,
  } as FlexText);

  contents.push({
    type: "box",
    layout: "vertical",
    contents: textContents,
    flex: 1,
    paddingStart: "lg",
  } as FlexBox);

  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "horizontal",
      contents,
      paddingAll: "xl",
      backgroundColor: typeColors.bg,
    },
  };
}
