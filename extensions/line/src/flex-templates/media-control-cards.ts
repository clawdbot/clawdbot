import type {
  FlexBox,
  FlexBubble,
  FlexButton,
  FlexComponent,
  FlexImage,
  FlexText,
} from "./types.js";

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
