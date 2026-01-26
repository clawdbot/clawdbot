import type { messagingApi } from "@line/bot-sdk";

// Re-export types for convenience
type FlexContainer = messagingApi.FlexContainer;
type FlexBubble = messagingApi.FlexBubble;
type FlexCarousel = messagingApi.FlexCarousel;
type FlexBox = messagingApi.FlexBox;
type FlexText = messagingApi.FlexText;
type FlexImage = messagingApi.FlexImage;
type FlexButton = messagingApi.FlexButton;
type FlexComponent = messagingApi.FlexComponent;
type Action = messagingApi.Action;

export interface ListItem {
  title: string;
  subtitle?: string;
  action?: Action;
}

export interface CardAction {
  label: string;
  action: Action;
}

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
    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: footer,
          size: "xs",
          color: "#AAAAAA",
          wrap: true,
          align: "center",
        } as FlexText,
      ],
      paddingAll: "lg",
      backgroundColor: "#FAFAFA",
    };
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
    (bubble.body as FlexBox).contents.push({
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

/**
 * Create a receipt/summary card (for orders, transactions, data tables)
 *
 * Editorial design: Clean table layout with alternating row backgrounds,
 * prominent total section, and clear visual hierarchy.
 */
export function createReceiptCard(params: {
  title: string;
  subtitle?: string;
  items: Array<{ name: string; value: string; highlight?: boolean }>;
  total?: { label: string; value: string };
  footer?: string;
}): FlexBubble {
  const { title, subtitle, items, total, footer } = params;

  const itemRows: FlexComponent[] = items.slice(0, 12).map(
    (item, index) =>
      ({
        type: "box",
        layout: "horizontal",
        contents: [
          {
            type: "text",
            text: item.name,
            size: "sm",
            color: item.highlight ? "#111111" : "#666666",
            weight: item.highlight ? "bold" : "regular",
            flex: 3,
            wrap: true,
          } as FlexText,
          {
            type: "text",
            text: item.value,
            size: "sm",
            color: item.highlight ? "#06C755" : "#333333",
            weight: item.highlight ? "bold" : "regular",
            flex: 2,
            align: "end",
            wrap: true,
          } as FlexText,
        ],
        paddingAll: "md",
        backgroundColor: index % 2 === 0 ? "#FFFFFF" : "#FAFAFA",
      }) as FlexBox,
  );

  // Header section
  const headerContents: FlexComponent[] = [
    {
      type: "text",
      text: title,
      weight: "bold",
      size: "xl",
      color: "#111111",
      wrap: true,
    } as FlexText,
  ];

  if (subtitle) {
    headerContents.push({
      type: "text",
      text: subtitle,
      size: "sm",
      color: "#888888",
      margin: "sm",
      wrap: true,
    } as FlexText);
  }

  const bodyContents: FlexComponent[] = [
    {
      type: "box",
      layout: "vertical",
      contents: headerContents,
      paddingBottom: "lg",
    } as FlexBox,
    {
      type: "separator",
      color: "#EEEEEE",
    },
    {
      type: "box",
      layout: "vertical",
      contents: itemRows,
      margin: "md",
      cornerRadius: "md",
      borderWidth: "light",
      borderColor: "#EEEEEE",
    } as FlexBox,
  ];

  // Total section with emphasis
  if (total) {
    bodyContents.push({
      type: "box",
      layout: "horizontal",
      contents: [
        {
          type: "text",
          text: total.label,
          size: "lg",
          weight: "bold",
          color: "#111111",
          flex: 2,
        } as FlexText,
        {
          type: "text",
          text: total.value,
          size: "xl",
          weight: "bold",
          color: "#06C755",
          flex: 2,
          align: "end",
        } as FlexText,
      ],
      margin: "xl",
      paddingAll: "lg",
      backgroundColor: "#F0FDF4",
      cornerRadius: "lg",
    } as FlexBox);
  }

  const bubble: FlexBubble = {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      contents: bodyContents,
      paddingAll: "xl",
      backgroundColor: "#FFFFFF",
    },
  };

  if (footer) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: footer,
          size: "xs",
          color: "#AAAAAA",
          wrap: true,
          align: "center",
        } as FlexText,
      ],
      paddingAll: "lg",
      backgroundColor: "#FAFAFA",
    };
  }

  return bubble;
}

/**
 * Create a calendar event card (for meetings, appointments, reminders)
 *
 * Editorial design: Date as hero, strong typographic hierarchy,
 * color-blocked zones, full text wrapping for readability.
 */
export function createEventCard(params: {
  title: string;
  date: string;
  time?: string;
  location?: string;
  description?: string;
  calendar?: string;
  isAllDay?: boolean;
  action?: Action;
}): FlexBubble {
  const { title, date, time, location, description, calendar, isAllDay, action } = params;

  // Hero date block - the most important information
  const dateBlock: FlexBox = {
    type: "box",
    layout: "vertical",
    contents: [
      {
        type: "text",
        text: date.toUpperCase(),
        size: "sm",
        weight: "bold",
        color: "#06C755",
        wrap: true,
      } as FlexText,
      {
        type: "text",
        text: isAllDay ? "ALL DAY" : (time ?? ""),
        size: "xxl",
        weight: "bold",
        color: "#111111",
        wrap: true,
        margin: "xs",
      } as FlexText,
    ],
    paddingBottom: "lg",
    borderWidth: "none",
  };

  // If no time and not all day, hide the time display
  if (!time && !isAllDay) {
    dateBlock.contents = [
      {
        type: "text",
        text: date,
        size: "xl",
        weight: "bold",
        color: "#111111",
        wrap: true,
      } as FlexText,
    ];
  }

  // Event title with accent bar
  const titleBlock: FlexBox = {
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
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: title,
            size: "lg",
            weight: "bold",
            color: "#1a1a1a",
            wrap: true,
          } as FlexText,
          ...(calendar
            ? [
                {
                  type: "text",
                  text: calendar,
                  size: "xs",
                  color: "#888888",
                  margin: "sm",
                  wrap: true,
                } as FlexText,
              ]
            : []),
        ],
        flex: 1,
        paddingStart: "lg",
      } as FlexBox,
    ],
    paddingTop: "lg",
    paddingBottom: "lg",
    borderWidth: "light",
    borderColor: "#EEEEEE",
  };

  const bodyContents: FlexComponent[] = [dateBlock, titleBlock];

  // Details section (location + description) in subtle background
  const hasDetails = location || description;
  if (hasDetails) {
    const detailItems: FlexComponent[] = [];

    if (location) {
      detailItems.push({
        type: "box",
        layout: "horizontal",
        contents: [
          {
            type: "text",
            text: "📍",
            size: "sm",
            flex: 0,
          } as FlexText,
          {
            type: "text",
            text: location,
            size: "sm",
            color: "#444444",
            margin: "md",
            flex: 1,
            wrap: true,
          } as FlexText,
        ],
        alignItems: "flex-start",
      } as FlexBox);
    }

    if (description) {
      detailItems.push({
        type: "text",
        text: description,
        size: "sm",
        color: "#666666",
        wrap: true,
        margin: location ? "lg" : "none",
      } as FlexText);
    }

    bodyContents.push({
      type: "box",
      layout: "vertical",
      contents: detailItems,
      margin: "lg",
      paddingAll: "lg",
      backgroundColor: "#F8F9FA",
      cornerRadius: "lg",
    } as FlexBox);
  }

  return {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      contents: bodyContents,
      paddingAll: "xl",
      backgroundColor: "#FFFFFF",
      action,
    },
  };
}

/**
 * Create a calendar agenda card showing multiple events
 *
 * Editorial timeline design: Time-focused left column with event details
 * on the right. Visual accent bars indicate event priority/recency.
 */
export function createAgendaCard(params: {
  title: string;
  subtitle?: string;
  events: Array<{
    title: string;
    time?: string;
    location?: string;
    calendar?: string;
    isNow?: boolean;
  }>;
  footer?: string;
}): FlexBubble {
  const { title, subtitle, events, footer } = params;

  // Header with title and optional subtitle
  const headerContents: FlexComponent[] = [
    {
      type: "text",
      text: title,
      weight: "bold",
      size: "xl",
      color: "#111111",
      wrap: true,
    } as FlexText,
  ];

  if (subtitle) {
    headerContents.push({
      type: "text",
      text: subtitle,
      size: "sm",
      color: "#888888",
      margin: "sm",
      wrap: true,
    } as FlexText);
  }

  // Event timeline items
  const eventItems: FlexComponent[] = events.slice(0, 6).map((event, index) => {
    const isActive = event.isNow || index === 0;
    const accentColor = isActive ? "#06C755" : "#E5E5E5";

    // Time column (fixed width)
    const timeColumn: FlexBox = {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: event.time ?? "—",
          size: "sm",
          weight: isActive ? "bold" : "regular",
          color: isActive ? "#06C755" : "#666666",
          align: "end",
          wrap: true,
        } as FlexText,
      ],
      width: "65px",
      justifyContent: "flex-start",
    };

    // Accent dot
    const dotColumn: FlexBox = {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "box",
          layout: "vertical",
          contents: [],
          width: "10px",
          height: "10px",
          backgroundColor: accentColor,
          cornerRadius: "5px",
        } as FlexBox,
      ],
      width: "24px",
      alignItems: "center",
      justifyContent: "flex-start",
      paddingTop: "xs",
    };

    // Event details column
    const detailContents: FlexComponent[] = [
      {
        type: "text",
        text: event.title,
        size: "md",
        weight: "bold",
        color: "#1a1a1a",
        wrap: true,
      } as FlexText,
    ];

    // Secondary info line
    const secondaryParts: string[] = [];
    if (event.location) secondaryParts.push(event.location);
    if (event.calendar) secondaryParts.push(event.calendar);

    if (secondaryParts.length > 0) {
      detailContents.push({
        type: "text",
        text: secondaryParts.join(" · "),
        size: "xs",
        color: "#888888",
        wrap: true,
        margin: "xs",
      } as FlexText);
    }

    const detailColumn: FlexBox = {
      type: "box",
      layout: "vertical",
      contents: detailContents,
      flex: 1,
    };

    return {
      type: "box",
      layout: "horizontal",
      contents: [timeColumn, dotColumn, detailColumn],
      margin: index > 0 ? "xl" : undefined,
      alignItems: "flex-start",
    } as FlexBox;
  });

  const bodyContents: FlexComponent[] = [
    {
      type: "box",
      layout: "vertical",
      contents: headerContents,
      paddingBottom: "lg",
    } as FlexBox,
    {
      type: "separator",
      color: "#EEEEEE",
    },
    {
      type: "box",
      layout: "vertical",
      contents: eventItems,
      paddingTop: "xl",
    } as FlexBox,
  ];

  const bubble: FlexBubble = {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      contents: bodyContents,
      paddingAll: "xl",
      backgroundColor: "#FFFFFF",
    },
  };

  if (footer) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: footer,
          size: "xs",
          color: "#AAAAAA",
          align: "center",
          wrap: true,
        } as FlexText,
      ],
      paddingAll: "lg",
      backgroundColor: "#FAFAFA",
    };
  }

  return bubble;
}

/**
 * Create a media player card for Sonos, Spotify, Apple Music, etc.
 *
 * Editorial design: Album art hero with gradient overlay for text,
 * prominent now-playing indicator, refined playback controls.
 */
export function createMediaPlayerCard(params: {
  title: string;
  subtitle?: string;
  source?: string;
  imageUrl?: string;
  isPlaying?: boolean;
  progress?: string;
  controls?: {
    previous?: { data: string };
    play?: { data: string };
    pause?: { data: string };
    next?: { data: string };
  };
  extraActions?: Array<{ label: string; data: string }>;
}): FlexBubble {
  const { title, subtitle, source, imageUrl, isPlaying, progress, controls, extraActions } = params;

  // Track info section
  const trackInfo: FlexComponent[] = [
    {
      type: "text",
      text: title,
      weight: "bold",
      size: "xl",
      color: "#111111",
      wrap: true,
    } as FlexText,
  ];

  if (subtitle) {
    trackInfo.push({
      type: "text",
      text: subtitle,
      size: "md",
      color: "#666666",
      wrap: true,
      margin: "sm",
    } as FlexText);
  }

  // Status row with source and playing indicator
  const statusItems: FlexComponent[] = [];

  if (isPlaying !== undefined) {
    statusItems.push({
      type: "box",
      layout: "horizontal",
      contents: [
        {
          type: "box",
          layout: "vertical",
          contents: [],
          width: "8px",
          height: "8px",
          backgroundColor: isPlaying ? "#06C755" : "#CCCCCC",
          cornerRadius: "4px",
        } as FlexBox,
        {
          type: "text",
          text: isPlaying ? "Now Playing" : "Paused",
          size: "xs",
          color: isPlaying ? "#06C755" : "#888888",
          weight: "bold",
          margin: "sm",
        } as FlexText,
      ],
      alignItems: "center",
    } as FlexBox);
  }

  if (source) {
    statusItems.push({
      type: "text",
      text: source,
      size: "xs",
      color: "#AAAAAA",
      margin: statusItems.length > 0 ? "lg" : undefined,
    } as FlexText);
  }

  if (progress) {
    statusItems.push({
      type: "text",
      text: progress,
      size: "xs",
      color: "#888888",
      align: "end",
      flex: 1,
    } as FlexText);
  }

  const bodyContents: FlexComponent[] = [
    {
      type: "box",
      layout: "vertical",
      contents: trackInfo,
    } as FlexBox,
  ];

  if (statusItems.length > 0) {
    bodyContents.push({
      type: "box",
      layout: "horizontal",
      contents: statusItems,
      margin: "lg",
      alignItems: "center",
    } as FlexBox);
  }

  const bubble: FlexBubble = {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      contents: bodyContents,
      paddingAll: "xl",
      backgroundColor: "#FFFFFF",
    },
  };

  // Album art hero
  if (imageUrl) {
    bubble.hero = {
      type: "image",
      url: imageUrl,
      size: "full",
      aspectRatio: "1:1",
      aspectMode: "cover",
    } as FlexImage;
  }

  // Control buttons in footer
  if (controls || extraActions?.length) {
    const footerContents: FlexComponent[] = [];

    // Main playback controls with refined styling
    if (controls) {
      const controlButtons: FlexComponent[] = [];

      if (controls.previous) {
        controlButtons.push({
          type: "button",
          action: {
            type: "postback",
            label: "⏮",
            data: controls.previous.data,
          },
          style: "secondary",
          flex: 1,
          height: "sm",
        } as FlexButton);
      }

      if (controls.play) {
        controlButtons.push({
          type: "button",
          action: {
            type: "postback",
            label: "▶",
            data: controls.play.data,
          },
          style: isPlaying ? "secondary" : "primary",
          flex: 1,
          height: "sm",
          margin: controls.previous ? "md" : undefined,
        } as FlexButton);
      }

      if (controls.pause) {
        controlButtons.push({
          type: "button",
          action: {
            type: "postback",
            label: "⏸",
            data: controls.pause.data,
          },
          style: isPlaying ? "primary" : "secondary",
          flex: 1,
          height: "sm",
          margin: controlButtons.length > 0 ? "md" : undefined,
        } as FlexButton);
      }

      if (controls.next) {
        controlButtons.push({
          type: "button",
          action: {
            type: "postback",
            label: "⏭",
            data: controls.next.data,
          },
          style: "secondary",
          flex: 1,
          height: "sm",
          margin: controlButtons.length > 0 ? "md" : undefined,
        } as FlexButton);
      }

      if (controlButtons.length > 0) {
        footerContents.push({
          type: "box",
          layout: "horizontal",
          contents: controlButtons,
        } as FlexBox);
      }
    }

    // Extra actions
    if (extraActions?.length) {
      footerContents.push({
        type: "box",
        layout: "horizontal",
        contents: extraActions.slice(0, 2).map(
          (action, index) =>
            ({
              type: "button",
              action: {
                type: "postback",
                label: action.label.slice(0, 15),
                data: action.data,
              },
              style: "secondary",
              flex: 1,
              height: "sm",
              margin: index > 0 ? "md" : undefined,
            }) as FlexButton,
        ),
        margin: "md",
      } as FlexBox);
    }

    if (footerContents.length > 0) {
      bubble.footer = {
        type: "box",
        layout: "vertical",
        contents: footerContents,
        paddingAll: "lg",
        backgroundColor: "#FAFAFA",
      };
    }
  }

  return bubble;
}

/**
 * Create an Apple TV remote card with a D-pad and control rows.
 */
export function createAppleTvRemoteCard(params: {
  deviceName: string;
  status?: string;
  actionData: {
    up: string;
    down: string;
    left: string;
    right: string;
    select: string;
    menu: string;
    home: string;
    play: string;
    pause: string;
    volumeUp: string;
    volumeDown: string;
    mute: string;
  };
}): FlexBubble {
  const { deviceName, status, actionData } = params;

  const headerContents: FlexComponent[] = [
    {
      type: "text",
      text: deviceName,
      weight: "bold",
      size: "xl",
      color: "#111111",
      wrap: true,
    } as FlexText,
  ];

  if (status) {
    headerContents.push({
      type: "text",
      text: status,
      size: "sm",
      color: "#666666",
      wrap: true,
      margin: "sm",
    } as FlexText);
  }

  const makeButton = (
    label: string,
    data: string,
    style: "primary" | "secondary" = "secondary",
  ): FlexButton => ({
    type: "button",
    action: {
      type: "postback",
      label,
      data,
    },
    style,
    height: "sm",
    flex: 1,
  });

  const dpadRows: FlexComponent[] = [
    {
      type: "box",
      layout: "horizontal",
      contents: [{ type: "filler" }, makeButton("↑", actionData.up), { type: "filler" }],
    } as FlexBox,
    {
      type: "box",
      layout: "horizontal",
      contents: [
        makeButton("←", actionData.left),
        makeButton("OK", actionData.select, "primary"),
        makeButton("→", actionData.right),
      ],
      margin: "md",
    } as FlexBox,
    {
      type: "box",
      layout: "horizontal",
      contents: [{ type: "filler" }, makeButton("↓", actionData.down), { type: "filler" }],
      margin: "md",
    } as FlexBox,
  ];

  const menuRow: FlexComponent = {
    type: "box",
    layout: "horizontal",
    contents: [makeButton("Menu", actionData.menu), makeButton("Home", actionData.home)],
    margin: "lg",
  } as FlexBox;

  const playbackRow: FlexComponent = {
    type: "box",
    layout: "horizontal",
    contents: [makeButton("Play", actionData.play), makeButton("Pause", actionData.pause)],
    margin: "md",
  } as FlexBox;

  const volumeRow: FlexComponent = {
    type: "box",
    layout: "horizontal",
    contents: [
      makeButton("Vol +", actionData.volumeUp),
      makeButton("Mute", actionData.mute),
      makeButton("Vol -", actionData.volumeDown),
    ],
    margin: "md",
  } as FlexBox;

  return {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "box",
          layout: "vertical",
          contents: headerContents,
        } as FlexBox,
        {
          type: "separator",
          margin: "lg",
          color: "#EEEEEE",
        },
        ...dpadRows,
        menuRow,
        playbackRow,
        volumeRow,
      ],
      paddingAll: "xl",
      backgroundColor: "#FFFFFF",
    },
  };
}

/**
 * Create a device control card for Apple TV, smart home devices, etc.
 *
 * Editorial design: Device-focused header with status indicator,
 * clean control grid with clear visual hierarchy.
 */
export function createDeviceControlCard(params: {
  deviceName: string;
  deviceType?: string;
  status?: string;
  isOnline?: boolean;
  imageUrl?: string;
  controls: Array<{
    label: string;
    icon?: string;
    data: string;
    style?: "primary" | "secondary";
  }>;
}): FlexBubble {
  const { deviceName, deviceType, status, isOnline, imageUrl, controls } = params;

  // Device header with status indicator
  const headerContents: FlexComponent[] = [
    {
      type: "box",
      layout: "horizontal",
      contents: [
        // Status dot
        {
          type: "box",
          layout: "vertical",
          contents: [],
          width: "10px",
          height: "10px",
          backgroundColor: isOnline !== false ? "#06C755" : "#FF5555",
          cornerRadius: "5px",
        } as FlexBox,
        {
          type: "text",
          text: deviceName,
          weight: "bold",
          size: "xl",
          color: "#111111",
          wrap: true,
          flex: 1,
          margin: "md",
        } as FlexText,
      ],
      alignItems: "center",
    } as FlexBox,
  ];

  if (deviceType) {
    headerContents.push({
      type: "text",
      text: deviceType,
      size: "sm",
      color: "#888888",
      margin: "sm",
    } as FlexText);
  }

  if (status) {
    headerContents.push({
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: status,
          size: "sm",
          color: "#444444",
          wrap: true,
        } as FlexText,
      ],
      margin: "lg",
      paddingAll: "md",
      backgroundColor: "#F8F9FA",
      cornerRadius: "md",
    } as FlexBox);
  }

  const bubble: FlexBubble = {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      contents: headerContents,
      paddingAll: "xl",
      backgroundColor: "#FFFFFF",
    },
  };

  if (imageUrl) {
    bubble.hero = {
      type: "image",
      url: imageUrl,
      size: "full",
      aspectRatio: "16:9",
      aspectMode: "cover",
    } as FlexImage;
  }

  // Control buttons in refined grid layout (2 per row)
  if (controls.length > 0) {
    const rows: FlexComponent[] = [];
    const limitedControls = controls.slice(0, 6);

    for (let i = 0; i < limitedControls.length; i += 2) {
      const rowButtons: FlexComponent[] = [];

      for (let j = i; j < Math.min(i + 2, limitedControls.length); j++) {
        const ctrl = limitedControls[j];
        const buttonLabel = ctrl.icon ? `${ctrl.icon} ${ctrl.label}` : ctrl.label;

        rowButtons.push({
          type: "button",
          action: {
            type: "postback",
            label: buttonLabel.slice(0, 18),
            data: ctrl.data,
          },
          style: ctrl.style ?? "secondary",
          flex: 1,
          height: "sm",
          margin: j > i ? "md" : undefined,
        } as FlexButton);
      }

      // If odd number of controls in last row, add spacer
      if (rowButtons.length === 1) {
        rowButtons.push({
          type: "filler",
        });
      }

      rows.push({
        type: "box",
        layout: "horizontal",
        contents: rowButtons,
        margin: i > 0 ? "md" : undefined,
      } as FlexBox);
    }

    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: rows,
      paddingAll: "lg",
      backgroundColor: "#FAFAFA",
    };
  }

  return bubble;
}

/**
 * Wrap a FlexContainer in a FlexMessage
 */
export function toFlexMessage(altText: string, contents: FlexContainer): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText,
    contents,
  };
}

// Re-export the types for consumers
export type {
  FlexContainer,
  FlexBubble,
  FlexCarousel,
  FlexBox,
  FlexText,
  FlexImage,
  FlexButton,
  FlexComponent,
  Action,
};
