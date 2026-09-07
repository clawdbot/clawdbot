import { z } from "zod";

const date = z.string().refine((value) => Number.isFinite(Date.parse(value)));
export const userSchema = z.object({ login: z.string().min(1) });
export const collaboratorSchema = userSchema.extend({
  permissions: z
    .object({
      push: z.boolean().optional(),
      maintain: z.boolean().optional(),
      admin: z.boolean().optional(),
    })
    .optional(),
});
export const repoSchema = z.object({
  full_name: z.string().regex(/^[^/]+\/[^/]+$/),
  archived: z.boolean(),
  pushed_at: date.nullish(),
});
export const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  repository_url: z.string(),
  user: userSchema.nullable(),
  created_at: date,
  closed_at: date.nullish(),
  pull_request: z.object({ merged_at: date.nullish() }).optional(),
});
export const pullSchema = z.object({ merged_by: userSchema.nullable() });
export const commitSchema = z.object({
  sha: z.string(),
  html_url: z.string(),
  author: userSchema.nullable(),
  commit: z.object({ message: z.string(), committer: z.object({ date }).nullable() }),
});
export const searchCommitSchema = commitSchema.extend({
  repository: z.object({ full_name: z.string() }),
});
export const commentSchema = z.object({
  user: userSchema.nullable(),
  body: z.string().nullish(),
  created_at: date,
  html_url: z.string(),
});
export const advisorySchema = z.object({
  summary: z.string(),
  html_url: z.string(),
  published_at: date.nullish(),
  updated_at: date.nullish(),
  credits: z.array(z.object({ login: z.string().nullish(), user: userSchema.nullish() })).nullish(),
  publisher: userSchema.nullish(),
});
