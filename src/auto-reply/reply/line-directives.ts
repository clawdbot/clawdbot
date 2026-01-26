import type { ReplyPayload } from "../types.js";
import type { LineChannelData } from "../../line/types.js";
import {
  createMediaPlayerCard,
  createEventCard,
  createAgendaCard,
  createDeviceControlCard,
  createAppleTvRemoteCard,
} from "../../line/flex-templates.js";

/**
 * Parse LINE-specific directives from text and extract them into ReplyPayload fields.
 *
 * Supported directives:
 * - [[quick_replies: option1, option2, option3]]
 * - [[location: title | address | latitude | longitude]]
 * - [[confirm: question | yes_label | no_label]]
 * - [[buttons: title | text | btn1:data1, btn2:data2]]
 * - [[media_player: title | artist | source | imageUrl | playing/paused]]
 * - [[event: title | date | time | location | description]]
 * - [[agenda: title | event1_title:event1_time, event2_title:event2_time, ...]]
 * - [[device: name | type | status | ctrl1:data1, ctrl2:data2]]
 * - [[appletv_remote: name | status]]
 *
 * Returns the modified payload with directives removed from text and fields populated.
 */
export function parseLineDirectives(payload: ReplyPayload): ReplyPayload {
  let text = payload.text;
  if (!text) return payload;

  const result: ReplyPayload = { ...payload };
  const lineData: LineChannelData = {
    ...(result.channelData?.line as LineChannelData | undefined),
  };
  const toSlug = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "device";
  const lineActionData = (action: string, extras?: Record<string, string>): string => {
    const base = [`line.action=${encodeURIComponent(action)}`];
    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        base.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
    }
    return base.join("&");
  };

  // Parse [[quick_replies: option1, option2, option3]]
  const quickRepliesMatch = text.match(/\[\[quick_replies:\s*([^\]]+)\]\]/i);
  if (quickRepliesMatch) {
    const options = quickRepliesMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (options.length > 0) {
      lineData.quickReplies = [...(lineData.quickReplies || []), ...options];
    }
    text = text.replace(quickRepliesMatch[0], "").trim();
  }

  // Parse [[location: title | address | latitude | longitude]]
  const locationMatch = text.match(/\[\[location:\s*([^\]]+)\]\]/i);
  if (locationMatch && !lineData.location) {
    const parts = locationMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 4) {
      const [title, address, latStr, lonStr] = parts;
      const latitude = parseFloat(latStr);
      const longitude = parseFloat(lonStr);
      if (!isNaN(latitude) && !isNaN(longitude)) {
        lineData.location = {
          title: title || "Location",
          address: address || "",
          latitude,
          longitude,
        };
      }
    }
    text = text.replace(locationMatch[0], "").trim();
  }

  // Parse [[confirm: question | yes_label | no_label]] or [[confirm: question | yes_label:yes_data | no_label:no_data]]
  const confirmMatch = text.match(/\[\[confirm:\s*([^\]]+)\]\]/i);
  if (confirmMatch && !lineData.templateMessage) {
    const parts = confirmMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 3) {
      const [question, yesPart, noPart] = parts;

      // Parse yes_label:yes_data format
      const [yesLabel, yesData] = yesPart.includes(":")
        ? yesPart.split(":").map((s) => s.trim())
        : [yesPart, yesPart.toLowerCase()];

      const [noLabel, noData] = noPart.includes(":")
        ? noPart.split(":").map((s) => s.trim())
        : [noPart, noPart.toLowerCase()];

      lineData.templateMessage = {
        type: "confirm",
        text: question,
        confirmLabel: yesLabel,
        confirmData: yesData,
        cancelLabel: noLabel,
        cancelData: noData,
        altText: question,
      };
    }
    text = text.replace(confirmMatch[0], "").trim();
  }

  // Parse [[buttons: title | text | btn1:data1, btn2:data2]]
  const buttonsMatch = text.match(/\[\[buttons:\s*([^\]]+)\]\]/i);
  if (buttonsMatch && !lineData.templateMessage) {
    const parts = buttonsMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 3) {
      const [title, bodyText, actionsStr] = parts;

      const actions = actionsStr.split(",").map((actionStr) => {
        const trimmed = actionStr.trim();
        // Find first colon delimiter, ignoring URLs without a label.
        const colonIndex = (() => {
          const index = trimmed.indexOf(":");
          if (index === -1) return -1;
          const lower = trimmed.toLowerCase();
          if (lower.startsWith("http://") || lower.startsWith("https://")) return -1;
          return index;
        })();

        let label: string;
        let data: string;

        if (colonIndex === -1) {
          label = trimmed;
          data = trimmed;
        } else {
          label = trimmed.slice(0, colonIndex).trim();
          data = trimmed.slice(colonIndex + 1).trim();
        }

        // Detect action type
        if (data.startsWith("http://") || data.startsWith("https://")) {
          return { type: "uri" as const, label, uri: data };
        }
        if (data.includes("=")) {
          return { type: "postback" as const, label, data };
        }
        return { type: "message" as const, label, data: data || label };
      });

      if (actions.length > 0) {
        lineData.templateMessage = {
          type: "buttons",
          title,
          text: bodyText,
          actions: actions.slice(0, 4), // LINE limit
          altText: `${title}: ${bodyText}`,
        };
      }
    }
    text = text.replace(buttonsMatch[0], "").trim();
  }

  // Parse [[media_player: title | artist | source | imageUrl | playing/paused]]
  const mediaPlayerMatch = text.match(/\[\[media_player:\s*([^\]]+)\]\]/i);
  if (mediaPlayerMatch && !lineData.flexMessage) {
    const parts = mediaPlayerMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 1) {
      const [title, artist, source, imageUrl, statusStr] = parts;
      const isPlaying = statusStr?.toLowerCase() === "playing";

      // LINE requires HTTPS URLs for images - skip local/HTTP URLs
      const validImageUrl = imageUrl?.startsWith("https://") ? imageUrl : undefined;

      const deviceKey = toSlug(source || title || "media");
      const card = createMediaPlayerCard({
        title: title || "Unknown Track",
        subtitle: artist || undefined,
        source: source || undefined,
        imageUrl: validImageUrl,
        isPlaying: statusStr ? isPlaying : undefined,
        controls: {
          previous: { data: lineActionData("previous", { "line.device": deviceKey }) },
          play: { data: lineActionData("play", { "line.device": deviceKey }) },
          pause: { data: lineActionData("pause", { "line.device": deviceKey }) },
          next: { data: lineActionData("next", { "line.device": deviceKey }) },
        },
      });

      lineData.flexMessage = {
        altText: `🎵 ${title}${artist ? ` - ${artist}` : ""}`,
        contents: card,
      };
    }
    text = text.replace(mediaPlayerMatch[0], "").trim();
  }

  // Parse [[event: title | date | time | location | description]]
  const eventMatch = text.match(/\[\[event:\s*([^\]]+)\]\]/i);
  if (eventMatch && !lineData.flexMessage) {
    const parts = eventMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 2) {
      const [title, date, time, location, description] = parts;

      const card = createEventCard({
        title: title || "Event",
        date: date || "TBD",
        time: time || undefined,
        location: location || undefined,
        description: description || undefined,
      });

      lineData.flexMessage = {
        altText: `📅 ${title} - ${date}${time ? ` ${time}` : ""}`,
        contents: card,
      };
    }
    text = text.replace(eventMatch[0], "").trim();
  }

  // Parse [[appletv_remote: name | status]]
  const appleTvMatch = text.match(/\[\[appletv_remote:\s*([^\]]+)\]\]/i);
  if (appleTvMatch && !lineData.flexMessage) {
    const parts = appleTvMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 1) {
      const [deviceName, status] = parts;
      const deviceKey = toSlug(deviceName || "apple_tv");

      const card = createAppleTvRemoteCard({
        deviceName: deviceName || "Apple TV",
        status: status || undefined,
        actionData: {
          up: lineActionData("up", { "line.device": deviceKey }),
          down: lineActionData("down", { "line.device": deviceKey }),
          left: lineActionData("left", { "line.device": deviceKey }),
          right: lineActionData("right", { "line.device": deviceKey }),
          select: lineActionData("select", { "line.device": deviceKey }),
          menu: lineActionData("menu", { "line.device": deviceKey }),
          home: lineActionData("home", { "line.device": deviceKey }),
          play: lineActionData("play", { "line.device": deviceKey }),
          pause: lineActionData("pause", { "line.device": deviceKey }),
          volumeUp: lineActionData("volume_up", { "line.device": deviceKey }),
          volumeDown: lineActionData("volume_down", { "line.device": deviceKey }),
          mute: lineActionData("mute", { "line.device": deviceKey }),
        },
      });

      lineData.flexMessage = {
        altText: `📺 ${deviceName || "Apple TV"} Remote`,
        contents: card,
      };
    }
    text = text.replace(appleTvMatch[0], "").trim();
  }

  // Parse [[agenda: title | event1_title:event1_time, event2_title:event2_time, ...]]
  const agendaMatch = text.match(/\[\[agenda:\s*([^\]]+)\]\]/i);
  if (agendaMatch && !lineData.flexMessage) {
    const parts = agendaMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 2) {
      const [title, eventsStr] = parts;

      const events = eventsStr.split(",").map((eventStr) => {
        const trimmed = eventStr.trim();
        const colonIdx = trimmed.lastIndexOf(":");
        if (colonIdx > 0) {
          return {
            title: trimmed.slice(0, colonIdx).trim(),
            time: trimmed.slice(colonIdx + 1).trim(),
          };
        }
        return { title: trimmed };
      });

      const card = createAgendaCard({
        title: title || "Agenda",
        events,
      });

      lineData.flexMessage = {
        altText: `📋 ${title} (${events.length} events)`,
        contents: card,
      };
    }
    text = text.replace(agendaMatch[0], "").trim();
  }

  // Parse [[device: name | type | status | ctrl1:data1, ctrl2:data2]]
  const deviceMatch = text.match(/\[\[device:\s*([^\]]+)\]\]/i);
  if (deviceMatch && !lineData.flexMessage) {
    const parts = deviceMatch[1].split("|").map((s) => s.trim());
    if (parts.length >= 1) {
      const [deviceName, deviceType, status, controlsStr] = parts;

      const deviceKey = toSlug(deviceName || "device");
      const controls = controlsStr
        ? controlsStr.split(",").map((ctrlStr) => {
            const [label, data] = ctrlStr.split(":").map((s) => s.trim());
            const action = data || label.toLowerCase().replace(/\s+/g, "_");
            return { label, data: lineActionData(action, { "line.device": deviceKey }) };
          })
        : [];

      const card = createDeviceControlCard({
        deviceName: deviceName || "Device",
        deviceType: deviceType || undefined,
        status: status || undefined,
        controls,
      });

      lineData.flexMessage = {
        altText: `📱 ${deviceName}${status ? `: ${status}` : ""}`,
        contents: card,
      };
    }
    text = text.replace(deviceMatch[0], "").trim();
  }

  // Clean up multiple whitespace/newlines
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  result.text = text || undefined;
  if (Object.keys(lineData).length > 0) {
    result.channelData = { ...result.channelData, line: lineData };
  }
  return result;
}

/**
 * Check if text contains any LINE directives
 */
export function hasLineDirectives(text: string): boolean {
  return /\[\[(quick_replies|location|confirm|buttons|media_player|event|agenda|device|appletv_remote):/i.test(
    text,
  );
}
