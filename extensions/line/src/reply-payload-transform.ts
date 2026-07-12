// Line plugin module implements reply payload transform behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createAgendaCard,
  createAppleTvRemoteCard,
  createDeviceControlCard,
  createEventCard,
  createMediaPlayerCard,
} from "./flex-templates.js";
import type { LineChannelData } from "./types.js";

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
 */
export function parseLineDirectives(payload: ReplyPayload): ReplyPayload {
  let text = payload.text;
  if (!text) {
    return payload;
  }

  const result: ReplyPayload = { ...payload };
  const lineData: LineChannelData = {
    ...(result.channelData?.line as LineChannelData | undefined),
  };
  const toSlug = (value: string): string =>
    normalizeLowercaseStringOrEmpty(value)
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
  const parseConfirmAction = (part: string): { label: string; data: string } => {
    const colonIndex = part.indexOf(":");
    if (colonIndex === -1) {
      return { label: part, data: normalizeLowercaseStringOrEmpty(part) };
    }
    return {
      label: part.slice(0, colonIndex).trim(),
      data: part.slice(colonIndex + 1).trim(),
    };
  };

  const quickRepliesMatch = text.match(/\[\[quick_replies:\s*([^\]]+)\]\]/i);
  if (quickRepliesMatch) {
    const body = expectDefined(quickRepliesMatch[1], "quick replies directive body");
    const options = normalizeStringEntries(body.split(","));
    if (options.length > 0) {
      lineData.quickReplies = [...(lineData.quickReplies || []), ...options];
    }
    text = text.replace(quickRepliesMatch[0], "").trim();
  }

  const locationMatch = text.match(/\[\[location:\s*([^\]]+)\]\]/i);
  if (locationMatch && !lineData.location) {
    const body = expectDefined(locationMatch[1], "location directive body");
    const parts = body.split("|").map((s) => s.trim());
    if (parts.length >= 4) {
      const title = expectDefined(parts[0], "location title field");
      const address = expectDefined(parts[1], "location address field");
      const latStr = expectDefined(parts[2], "location latitude field");
      const lonStr = expectDefined(parts[3], "location longitude field");
      const latitude = parseStrictFiniteNumber(latStr);
      const longitude = parseStrictFiniteNumber(lonStr);
      if (latitude !== undefined && longitude !== undefined) {
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

  const confirmMatch = text.match(/\[\[confirm:\s*([^\]]+)\]\]/i);
  if (confirmMatch && !lineData.templateMessage) {
    const body = expectDefined(confirmMatch[1], "confirm directive body");
    const parts = body.split("|").map((s) => s.trim());
    if (parts.length >= 3) {
      const question = expectDefined(parts[0], "confirm question field");
      const yesPart = expectDefined(parts[1], "confirm yes field");
      const noPart = expectDefined(parts[2], "confirm no field");
      const yesAction = parseConfirmAction(yesPart);
      const noAction = parseConfirmAction(noPart);

      // LINE rejects a confirm template with an empty question or action label (HTTP 400),
      // dropping the whole message; skip the template when a required field is blank.
      if (question && yesAction.label && noAction.label) {
        lineData.templateMessage = {
          type: "confirm",
          text: question,
          confirmLabel: yesAction.label,
          confirmData: yesAction.data,
          cancelLabel: noAction.label,
          cancelData: noAction.data,
          altText: question,
        };
      }
    }
    text = text.replace(confirmMatch[0], "").trim();
  }

  const buttonsMatch = text.match(/\[\[buttons:\s*([^\]]+)\]\]/i);
  if (buttonsMatch && !lineData.templateMessage) {
    const body = expectDefined(buttonsMatch[1], "buttons directive body");
    const parts = body.split("|").map((s) => s.trim());
    if (parts.length >= 3) {
      const title = expectDefined(parts[0], "buttons title field");
      const bodyText = expectDefined(parts[1], "buttons text field");
      const actionsStr = expectDefined(parts[2], "buttons actions field");

      const actions = actionsStr
        .split(",")
        .map((actionStr) => {
          const trimmed = actionStr.trim();
          const colonIndex = (() => {
            const index = trimmed.indexOf(":");
            if (index === -1) {
              return -1;
            }
            const lower = normalizeLowercaseStringOrEmpty(trimmed);
            if (lower.startsWith("http://") || lower.startsWith("https://")) {
              return -1;
            }
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

          if (data.startsWith("http://") || data.startsWith("https://")) {
            return { type: "uri" as const, label, uri: data };
          }
          if (data.includes("=")) {
            return { type: "postback" as const, label, data };
          }
          return { type: "message" as const, label, data: data || label };
        })
        .filter((action) => action.label);

      // LINE accepts an omitted title but rejects an explicit empty title and requires text.
      // Omit the optional field so a valid text-only button template still reaches the user.
      if (actions.length > 0 && bodyText) {
        lineData.templateMessage = {
          type: "buttons",
          ...(title ? { title } : {}),
          text: bodyText,
          actions: actions.slice(0, 4),
          altText: title ? `${title}: ${bodyText}` : bodyText,
        };
      }
    }
    text = text.replace(buttonsMatch[0], "").trim();
  }

  const mediaPlayerMatch = text.match(/\[\[media_player:\s*([^\]]+)\]\]/i);
  if (mediaPlayerMatch && !lineData.flexMessage) {
    const body = expectDefined(mediaPlayerMatch[1], "media player directive body");
    const parts = body.split("|").map((s) => s.trim());
    if (parts.length >= 1) {
      const title = expectDefined(parts[0], "media player title field");
      const [, artist, source, imageUrl, statusStr] = parts;
      const isPlaying = normalizeLowercaseStringOrEmpty(statusStr) === "playing";
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

  const eventMatch = text.match(/\[\[event:\s*([^\]]+)\]\]/i);
  if (eventMatch && !lineData.flexMessage) {
    const body = expectDefined(eventMatch[1], "event directive body");
    const parts = body.split("|").map((s) => s.trim());
    if (parts.length >= 2) {
      const title = expectDefined(parts[0], "event title field");
      const date = expectDefined(parts[1], "event date field");
      const time = parts[2];
      const location = parts[3];
      const description = parts[4];

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

  const appleTvMatch = text.match(/\[\[appletv_remote:\s*([^\]]+)\]\]/i);
  if (appleTvMatch && !lineData.flexMessage) {
    const body = expectDefined(appleTvMatch[1], "Apple TV directive body");
    const parts = body.split("|").map((s) => s.trim());
    if (parts.length >= 1) {
      const deviceName = expectDefined(parts[0], "Apple TV device name field");
      const [, status] = parts;
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

  const agendaMatch = text.match(/\[\[agenda:\s*([^\]]+)\]\]/i);
  if (agendaMatch && !lineData.flexMessage) {
    const body = expectDefined(agendaMatch[1], "agenda directive body");
    const parts = body.split("|").map((s) => s.trim());
    if (parts.length >= 2) {
      const title = expectDefined(parts[0], "agenda title field");
      const eventsStr = expectDefined(parts[1], "agenda events field");
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

  const deviceMatch = text.match(/\[\[device:\s*([^\]]+)\]\]/i);
  if (deviceMatch && !lineData.flexMessage) {
    const body = expectDefined(deviceMatch[1], "device directive body");
    const parts = body.split("|").map((s) => s.trim());
    if (parts.length >= 1) {
      const deviceName = expectDefined(parts[0], "device name field");
      const [, deviceType, status, controlsStr] = parts;
      const deviceKey = toSlug(deviceName || "device");
      const controls = controlsStr
        ? controlsStr.split(",").map((ctrlStr) => {
            const controlParts = ctrlStr.split(":").map((s) => s.trim());
            const label = expectDefined(controlParts[0], "device control label");
            const data = controlParts[1];
            const action = data || normalizeLowercaseStringOrEmpty(label).replace(/\s+/g, "_");
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

  text = text.replace(/\n{3,}/g, "\n\n").trim();

  result.text = text || undefined;
  if (Object.keys(lineData).length > 0) {
    result.channelData = { ...result.channelData, line: lineData };
  }
  return result;
}

export function hasLineDirectives(text: string): boolean {
  return /\[\[(quick_replies|location|confirm|buttons|media_player|event|agenda|device|appletv_remote):/i.test(
    text,
  );
}
