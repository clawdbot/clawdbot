/**
 * A2UI JSONL helpers for Canvas text rendering and validation.
 */
const A2UI_ACTION_KEYS = [
  "beginRendering",
  "surfaceUpdate",
  "dataModelUpdate",
  "deleteSurface",
  "createSurface",
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
    const actionKeys = A2UI_ACTION_KEYS.filter((key) => key in record);
    if (actionKeys.length !== 1) {
      errors.push(
        `line ${idx + 1}: expected exactly one action key (${A2UI_ACTION_KEYS.join(", ")})`,
      );
      return;
    }
    // v0.9 requires an explicit version, but keep recognizing legacy
    // createSurface payloads so older generators still fail closed.
    if (explicitVersion === "v0.9" || actionKeys[0] === "createSurface") {
      sawV09 = true;
    } else {
      sawV08 = true;
    }
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
  return { version, messageCount };
}

/** Validates A2UI JSONL against the Canvas runtime's currently supported dialect. */
export function validateSupportedA2UIJsonl(jsonl: string) {
  const result = validateA2UIJsonl(jsonl);
  if (result.version !== "v0.8") {
    throw new Error("Detected unsupported A2UI v0.9 JSONL. OpenClaw currently supports v0.8 only.");
  }
  return result;
}
