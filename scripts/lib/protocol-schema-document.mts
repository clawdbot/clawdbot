// Canonical published Gateway protocol schema document. The generator that
// writes protocol.schema.json and the verifier that inspects the packed tarball
// both build the envelope here; a second copy is how the shipped machine-readable
// contract drifts without any lane noticing.

export type ProtocolMethodMetadata = {
  name: string;
  scope: string;
  since?: string;
};

export type ProtocolSchemaDocument = {
  $id: string;
  $schema: string;
  definitions: Record<string, unknown>;
  description: string;
  discriminator: {
    mapping: Record<string, string>;
    propertyName: string;
  };
  methods: Record<string, { scope: string; since?: string }>;
  oneOf: { $ref: string }[];
  title: string;
};

/** Frame definitions every consumer of the published schema resolves by name. */
export const REQUIRED_PROTOCOL_DEFINITIONS = [
  "ConnectParams",
  "RequestFrame",
  "ResponseFrame",
  "EventFrame",
] as const;

// Frame order is part of the published contract: generated clients select the
// oneOf branch positionally before reading the discriminator, so req/res/event
// must stay in this order across regenerations.
const FRAME_DEFINITIONS_BY_TYPE = [
  ["req", "RequestFrame"],
  ["res", "ResponseFrame"],
  ["event", "EventFrame"],
] as const;

const definitionRef = (definition: string) => `#/definitions/${definition}`;
const FRAME_REFS = FRAME_DEFINITIONS_BY_TYPE.map(([, definition]) => definitionRef(definition));
const FRAME_DISCRIMINATOR_MAPPING = Object.fromEntries(
  FRAME_DEFINITIONS_BY_TYPE.map(([frameType, definition]) => [
    frameType,
    definitionRef(definition),
  ]),
);

/** Builds the JSON document published as protocol.schema.json. */
export function buildProtocolSchemaDocument(params: {
  methods: readonly ProtocolMethodMetadata[];
  schemas: Record<string, unknown>;
}): ProtocolSchemaDocument {
  const document = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://openclaw.ai/protocol.schema.json",
    title: "OpenClaw Gateway Protocol",
    description: "Handshake, request/response, and event frames for the Gateway WebSocket.",
    oneOf: FRAME_REFS.map((ref) => ({ $ref: ref })),
    discriminator: {
      propertyName: "type",
      mapping: FRAME_DISCRIMINATOR_MAPPING,
    },
    methods: Object.fromEntries(
      // Omit an absent `since` instead of carrying undefined so the document
      // equals the JSON the artifact ships.
      params.methods.map(({ name, scope, since }) => [
        name,
        since === undefined ? { scope } : { since, scope },
      ]),
    ),
    definitions: params.schemas,
  };
  // TypeBox schemas carry symbol keys that never reach JSON; cloning them away
  // lets the producer and the published-artifact verifier compare one document.
  return structuredClone(document) as ProtocolSchemaDocument;
}

/** Rejects a published document that lost the frame contract clients decode by. */
export function assertProtocolSchemaDocument(document: ProtocolSchemaDocument): void {
  const problems = REQUIRED_PROTOCOL_DEFINITIONS.filter(
    (definition) => !Object.hasOwn(document.definitions, definition),
  ).map((definition) => `definition ${definition} is missing`);
  if (JSON.stringify(document.oneOf.map((entry) => entry.$ref)) !== JSON.stringify(FRAME_REFS)) {
    problems.push(`frame oneOf must list ${FRAME_REFS.join(", ")}`);
  }
  if (
    JSON.stringify(document.discriminator.mapping) !== JSON.stringify(FRAME_DISCRIMINATOR_MAPPING)
  ) {
    problems.push(`type discriminator must map ${JSON.stringify(FRAME_DISCRIMINATOR_MAPPING)}`);
  }
  if (Object.keys(document.methods).length === 0) {
    problems.push("method metadata is empty");
  }
  if (problems.length > 0) {
    throw new Error(`published protocol schema contract violated: ${problems.join("; ")}`);
  }
}
