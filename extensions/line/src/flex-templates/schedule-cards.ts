import { attachFooterText } from "./common.js";
import type { Action, FlexBox, FlexBubble, FlexComponent, FlexText } from "./types.js";

function buildTitleSubtitleHeader(params: { title: string; subtitle?: string }): FlexComponent[] {
  const { title, subtitle } = params;
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

  return headerContents;
}

function buildCardHeaderSections(headerContents: FlexComponent[]): FlexComponent[] {
  return [
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
  ];
}

function createMegaBubbleWithFooter(params: {
  bodyContents: FlexComponent[];
  footer?: string;
}): FlexBubble {
  const bubble: FlexBubble = {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      contents: params.bodyContents,
      paddingAll: "xl",
      backgroundColor: "#FFFFFF",
    },
  };

  if (params.footer) {
    attachFooterText(bubble, params.footer);
  }

  return bubble;
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
  const headerContents = buildTitleSubtitleHeader({ title, subtitle });

  const bodyContents: FlexComponent[] = [
    ...buildCardHeaderSections(headerContents),
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

  return createMegaBubbleWithFooter({ bodyContents, footer });
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
  const headerContents = buildTitleSubtitleHeader({ title, subtitle });

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
    if (event.location) {
      secondaryParts.push(event.location);
    }
    if (event.calendar) {
      secondaryParts.push(event.calendar);
    }

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
    ...buildCardHeaderSections(headerContents),
    {
      type: "box",
      layout: "vertical",
      contents: eventItems,
      paddingTop: "xl",
    } as FlexBox,
  ];

  return createMegaBubbleWithFooter({ bodyContents, footer });
}
