import { Type, type Static } from "typebox";
import { SkillLibraryFileSchema, SKILL_LIBRARY_MAX_FILES } from "./skill-library.js";

/** Portable, bounded skill resources; paths are relative to a worker-owned resource directory. */
export const SkillResourceDeliverySchema = Type.Object(
  {
    version: Type.Literal(1),
    skills: Type.Array(
      Type.Object(
        {
          sourcePath: Type.Optional(Type.String({ maxLength: 4096 })),
          modelVisible: Type.Optional(Type.Boolean()),
          name: Type.String({ minLength: 1, maxLength: 128 }),
          displayName: Type.Optional(Type.String({ maxLength: 256 })),
          description: Type.String({ maxLength: 1024 }),
          revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          files: Type.Array(SkillLibraryFileSchema, { maxItems: SKILL_LIBRARY_MAX_FILES }),
        },
        { additionalProperties: false },
      ),
      // Aggregate transport holds the default catalog (up to 150) plus up to 64 managed pins.
      // This does not expand the existing total byte or model-context budgets.
      { maxItems: 256 },
    ),
  },
  { additionalProperties: false },
);
export type SkillResourceDelivery = Static<typeof SkillResourceDeliverySchema>;
export const SKILL_RESOURCE_PROTOCOL_FEATURE = "skill-resources-v1";
