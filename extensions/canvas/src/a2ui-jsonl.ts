/**
 * A2UI JSONL helpers for Canvas text rendering and validation.
 */
import { A2uiMessageSchema as A2uiV09MessageSchema } from "@a2ui/web_core/v0_9";

const A2UI_V08_ACTION_KEYS = [
  "beginRendering",
  "surfaceUpdate",
  "dataModelUpdate",
  "deleteSurface",
] as const;
const A2UI_V09_ACTION_KEYS = [
  "createSurface",
  "updateComponents",
  "updateDataModel",
  "deleteSurface",
] as const;

/** A2UI message dialects recognized by the Canvas validator. */
type A2UIVersion = "v0.8" | "v0.9";

/** Builds a minimal A2UI JSONL payload that renders text in a single surface. */
export function buildA2UITextJsonl(text: string) {
  const surfaceId = "main";
  const rootId = "root";
  const textId = "text";
  const payloads = [
    {
      surfaceUpdate: {
        surfaceId,
        components: [
          {
            id: rootId,
            component: { Column: { children: { explicitList: [textId] } } },
          },
          {
            id: textId,
            component: {
              Text: { text: { literalString: text }, usageHint: "body" },
            },
          },
        ],
      },
    },
    { beginRendering: { surfaceId, root: rootId } },
  ];
  return payloads.map((payload) => JSON.stringify(payload)).join("\n");
}

/** Validates A2UI JSONL and returns the detected dialect/version metadata. */
function validateA2UIJsonl(jsonl: string) {
  const lines = jsonl.split(/\r?\n/);
  const errors: string[] = [];
  let sawV08 = false;
  let sawV09 = false;
  let messageCount = 0;
  const messages: unknown[] = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    messageCount += 1;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed) as unknown;
    } catch (err) {
      errors.push(`line ${idx + 1}: ${String(err)}`);
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      errors.push(`line ${idx + 1}: expected JSON object`);
      return;
    }
    const record = obj as Record<string, unknown>;
    const explicitVersion = record.version;
    // Bundled v0.8 is strict and unversioned; v0.9 identifies every message.
    if (explicitVersion === "v0.8") {
      errors.push(`line ${idx + 1}: A2UI v0.8 messages must not include a version field`);
      return;
    }
    if (explicitVersion !== undefined && explicitVersion !== "v0.9") {
      errors.push(`line ${idx + 1}: unsupported A2UI version: ${JSON.stringify(explicitVersion)}`);
      return;
    }
    const actionKeys = (
      explicitVersion === "v0.9" ? A2UI_V09_ACTION_KEYS : A2UI_V08_ACTION_KEYS
    ).filter((key) => key in record);
    if (actionKeys.length !== 1) {
      errors.push(
        `line ${idx + 1}: expected exactly one ${explicitVersion === "v0.9" ? "v0.9" : "v0.8"} action key`,
      );
      return;
    }
    const allowedTopLevelKeys = new Set(
      explicitVersion === "v0.9" ? ["version", actionKeys[0]] : [actionKeys[0]],
    );
    if (Object.keys(record).some((key) => !allowedTopLevelKeys.has(key))) {
      errors.push(`line ${idx + 1}: unexpected top-level A2UI field`);
      return;
    }
    const payload = record[actionKeys[0]!];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      errors.push(`line ${idx + 1}: action payload must be an object`);
      return;
    }
    if (explicitVersion === "v0.9") {
      const result = A2uiV09MessageSchema.safeParse(record);
      if (!result.success) {
        errors.push(
          `line ${idx + 1}: ${result.error.issues[0]?.message ?? "invalid v0.9 message"}`,
        );
        return;
      }
      sawV09 = true;
    } else {
      sawV08 = true;
    }
    messages.push(record);
  });

  if (messageCount === 0) {
    errors.push("no JSONL messages found");
  }
  if (sawV08 && sawV09) {
    errors.push("mixed A2UI v0.8 and v0.9 messages in one file");
  }
  if (errors.length > 0) {
    throw new Error(`Invalid A2UI JSONL:\n- ${errors.join("\n- ")}`);
  }

  const version: A2UIVersion = sawV09 ? "v0.9" : "v0.8";
  return { version, messageCount, messages };
}

/** Validates A2UI JSONL against the Canvas runtime's currently supported dialect. */
export function validateSupportedA2UIJsonl(jsonl: string) {
  return validateA2UIJsonl(jsonl);
}

/** Keeps native Canvas pushes on the renderer generation shipped by node clients. */
export function validateNativeA2UIJsonl(jsonl: string) {
  const parsed = validateA2UIJsonl(jsonl);
  if (parsed.version !== "v0.8") {
    throw new Error("OpenClaw currently supports v0.8 only for native Canvas pushes");
  }
  return parsed;
}
