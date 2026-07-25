type QaEvidenceGalleryStatus = "pass" | "fail" | "blocked" | "skipped";

type QaEvidenceCoverageView = {
  id: string;
  role: string;
};

export type QaEvidenceProducerContextFile = {
  href: string;
  path: string;
  preview: string | null;
};

export type QaEvidenceMatrixCellView = {
  artifactKinds: string[];
  artifactPaths: string[];
  coverageIds: string[];
  runner: {
    availability: string | null;
    command: string | null;
    lane: string | null;
    workflow: string | null;
  } | null;
  stage: string;
  status: string;
  surface: string;
  testId: string | null;
  title: string | null;
};

export type QaEvidenceArtifactView = {
  exists: boolean;
  error: string | null;
  href: string | null;
  kind: string;
  mediaKind: "image" | "video" | "json" | "text" | "file";
  path: string;
  preview: string | null;
  source: string;
};

export type QaEvidenceGalleryEntryView = {
  artifacts: QaEvidenceArtifactView[];
  coverage: QaEvidenceCoverageView[];
  failureReason: string | null;
  id: string;
  kind: string;
  sourcePath: string | null;
  status: QaEvidenceGalleryStatus;
  title: string;
};

export type QaEvidenceProducerContext = {
  commands: QaEvidenceProducerContextFile | null;
  kind: "ux-matrix";
  manifest:
    | (QaEvidenceProducerContextFile & {
        path: string;
        runStatus: string | null;
        runId: string | null;
      })
    | null;
  matrix: {
    cells: QaEvidenceMatrixCellView[];
    counts: Record<string, number>;
    path: string;
    stages: string[];
    surfaces: string[];
  } | null;
  preflight: {
    adbDevices: QaEvidenceProducerContextFile | null;
    memory: QaEvidenceProducerContextFile | null;
  };
  releaseLedger: (QaEvidenceProducerContextFile & { counts: Record<string, number> }) | null;
  rootPath: string;
  scorecard: QaEvidenceProducerContextFile | null;
};

export type QaEvidenceGalleryModel = {
  counts: Record<QaEvidenceGalleryStatus, number>;
  entries: QaEvidenceGalleryEntryView[];
  evidenceMode: string;
  evidencePath: string;
  generatedAt: string;
  profile: string | null;
  producerContext: QaEvidenceProducerContext | null;
  schemaVersion: number;
};
