import { z } from "zod";

const InstallSourceSchema = z.union([
  z.literal("npm"),
  z.literal("archive"),
  z.literal("path"),
  z.literal("clawhub"),
  z.literal("git"),
]);

const PluginInstallSourceSchema = z.union([InstallSourceSchema, z.literal("marketplace")]);

export const InstallRecordShape = {
  source: InstallSourceSchema,
  spec: z.string().optional(),
  sourcePath: z.string().optional(),
  installPath: z.string().optional(),
  version: z.string().optional(),
  resolvedName: z.string().optional(),
  resolvedVersion: z.string().optional(),
  resolvedSpec: z.string().optional(),
  integrity: z.string().optional(),
  shasum: z.string().optional(),
  resolvedAt: z.string().optional(),
  installedAt: z.string().optional(),
  clawhubUrl: z.string().optional(),
  clawhubPackage: z.string().optional(),
  clawhubFamily: z.union([z.literal("code-plugin"), z.literal("bundle-plugin")]).optional(),
  clawhubChannel: z
    .union([z.literal("official"), z.literal("community"), z.literal("private")])
    .optional(),
  clawpackSha256: z.string().optional(),
  clawpackSpecVersion: z.number().int().nonnegative().optional(),
  clawpackManifestSha256: z.string().optional(),
  clawpackSize: z.number().int().nonnegative().optional(),
  gitUrl: z.string().optional(),
  gitRef: z.string().optional(),
  gitCommit: z.string().optional(),
} as const;

export const PluginInstallRecordShape = {
  ...InstallRecordShape,
  source: PluginInstallSourceSchema,
  marketplaceName: z.string().optional(),
  marketplaceSource: z.string().optional(),
  marketplacePlugin: z.string().optional(),
} as const;
