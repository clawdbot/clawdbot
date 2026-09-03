type InstallSmokeCandidatePayloadManifest = {
  files: Array<{
    name: string;
    role: "package" | "package-metadata" | "installer" | "cli-installer";
    sha256: string;
    size: number;
  }>;
  harnessRepository: string;
  harnessSha: string;
  packageVersion: string;
  repository: string;
  runAttempt: string;
  runId: string;
  schema: "openclaw.install-smoke-candidate-payload/v1";
  sourceArchiveSha256: string;
  targetSha: string;
};

type SealInstallSmokeCandidatePayloadOptions = {
  archivePath: string;
  harnessRepository: string;
  harnessSha: string;
  outputDir: string;
  packageDir: string;
  repository: string;
  runAttempt: string;
  runId: string;
  targetSha: string;
};

type VerifyInstallSmokeCandidatePayloadOptions = {
  expectedManifestSha256: string;
  expectedPackageVersion: string;
  expectedSourceArchiveSha256: string;
  harnessRepository: string;
  harnessSha: string;
  payloadDir: string;
  repository: string;
  runAttempt: string;
  runId: string;
  targetSha: string;
};

export function sealInstallSmokeCandidatePayload(
  options: SealInstallSmokeCandidatePayloadOptions,
): Promise<InstallSmokeCandidatePayloadManifest>;

export function verifyInstallSmokeCandidatePayload(
  options: VerifyInstallSmokeCandidatePayloadOptions,
): Promise<InstallSmokeCandidatePayloadManifest>;
