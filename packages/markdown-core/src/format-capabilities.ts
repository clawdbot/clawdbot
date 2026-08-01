export type FormatConstruct =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "spoiler"
  | "codeInline"
  | "codeBlock"
  | "codeLanguage"
  | "linkLabel"
  | "heading"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "table"
  | "blockquote"
  | "image"
  | "mention";

export type ConstructSupport = "native" | "fallback" | "strip";

/** Static formatting capabilities declared by an outbound channel. */
export type FormatCapabilityProfile = {
  mechanism: "markdown" | "html" | "ranges" | "blocks" | "plain";
  constructs: Record<FormatConstruct, ConstructSupport>;
  chunk: {
    limit: number;
    unit: "chars" | "utf16" | "bytes";
    hardCap?: number;
  };
};

const NATIVE_FORMAT_CONSTRUCTS = {
  bold: "native",
  italic: "native",
  underline: "native",
  strikethrough: "native",
  spoiler: "native",
  codeInline: "native",
  codeBlock: "native",
  codeLanguage: "native",
  linkLabel: "native",
  heading: "native",
  bulletList: "native",
  orderedList: "native",
  taskList: "native",
  table: "native",
  blockquote: "native",
  image: "native",
  mention: "native",
} as const satisfies FormatCapabilityProfile["constructs"];

type DefinedConstructs<Overrides extends Partial<FormatCapabilityProfile["constructs"]>> = {
  [Construct in FormatConstruct]: Construct extends keyof Overrides
    ? Overrides[Construct]
    : "native";
};

type DefinedChunk<Chunk extends FormatCapabilityProfile["chunk"]> = Omit<
  FormatCapabilityProfile["chunk"],
  "unit"
> & { unit: Chunk["unit"] };

/** Defines a channel profile with native support as the default for each construct. */
function defineFormatProfile<
  const Mechanism extends FormatCapabilityProfile["mechanism"],
  const Overrides extends Partial<FormatCapabilityProfile["constructs"]> = Record<never, never>,
  const Chunk extends FormatCapabilityProfile["chunk"] = FormatCapabilityProfile["chunk"],
>(profile: {
  mechanism: Mechanism;
  constructs?: Overrides & Record<Exclude<keyof Overrides, FormatConstruct>, never>;
  chunk: Chunk;
}): {
  mechanism: Mechanism;
  constructs: DefinedConstructs<Overrides>;
  chunk: DefinedChunk<Chunk>;
} {
  return {
    ...profile,
    constructs: { ...NATIVE_FORMAT_CONSTRUCTS, ...profile.constructs },
  } as {
    mechanism: Mechanism;
    constructs: DefinedConstructs<Overrides>;
    chunk: DefinedChunk<Chunk>;
  };
}

/** Runtime helpers for defining static channel formatting capabilities. */
export const FormatCapabilityProfile = { define: defineFormatProfile };
