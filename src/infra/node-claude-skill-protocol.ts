import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { SkillResourceDeliverySchema } from "../../packages/gateway-protocol/src/schema/skill-resources.js";

export const NODE_CLAUDE_SKILLS_CAPABILITY = "claude-cli-skills-v1";
// An 8 MiB bundle can expand sixfold as JSON control-character escapes. The
// canonical resource verifier still enforces the decoded 8 MiB aggregate limit.
export const NODE_CLAUDE_SKILLS_MESSAGE_BYTES = 64 * 1024 * 1024;
export const NODE_CLAUDE_WORKSHOP_CALL_BYTES = NODE_CLAUDE_SKILLS_MESSAGE_BYTES;
export const NODE_CLAUDE_WORKSHOP_RESULT_BYTES = 128 * 1024;
const closed = { additionalProperties: false };
const callId = Type.String({ minLength: 1, maxLength: 128 });

const NodeClaudeSkillInitSchema = Type.Object(
  {
    type: Type.Literal("init"),
    resources: Type.Optional(SkillResourceDeliverySchema),
    workshop: Type.Optional(
      Type.Object(
        {
          description: Type.String({ maxLength: 4096 }),
          inputSchema: Type.Record(Type.String(), Type.Unknown()),
        },
        closed,
      ),
    ),
  },
  closed,
);
export type NodeClaudeSkillInit = Static<typeof NodeClaudeSkillInitSchema>;

export const NodeClaudeSkillUpstreamSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("stdout"), text: Type.String({ maxLength: 1024 * 1024 }) },
    closed,
  ),
  Type.Object({ type: Type.Literal("workshop"), id: callId, arguments: Type.Unknown() }, closed),
]);
export const NodeClaudeSkillResultSchema = Type.Object(
  {
    type: Type.Literal("result"),
    id: callId,
    result: Type.Unknown(),
  },
  closed,
);

export function encodeNodeClaudeSkillMessage(value: unknown, maxBytes: number): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > maxBytes) {
    throw new Error("Claude node skill message exceeds its bounded transport limit.");
  }
  return bytes;
}

export function decodeNodeClaudeSkillInit(bytes: Uint8Array): NodeClaudeSkillInit {
  if (bytes.byteLength > NODE_CLAUDE_SKILLS_MESSAGE_BYTES) {
    throw new Error("Claude node skill initialization exceeds its transport limit.");
  }
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!Value.Check(NodeClaudeSkillInitSchema, value)) {
    throw new Error("Invalid Claude node skill initialization.");
  }
  if (value.workshop) {
    encodeNodeClaudeSkillMessage(value.workshop, 16 * 1024);
  }
  return value;
}
