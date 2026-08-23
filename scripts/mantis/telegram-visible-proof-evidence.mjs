import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  commentText,
  fail,
  isRecord,
  readJson,
  stableStringify,
  validateScenarioDirectory,
  writeJson,
} from "./telegram-visible-proof-contract.mjs";
import {
  evaluateAssertion,
  materialTimingDifference,
  normalizeInvocations,
  normalizeVisibleEvents,
  summarizeVisibleEvents,
  visibleEvents,
} from "./telegram-visible-proof-events.mjs";

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function validateMediaSignature(file, name) {
  const header = fs.readFileSync(file).subarray(0, 16);
  if (name === "screenshot" && !header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    fail("Telegram screenshot is not a PNG.");
  }
  if (name === "previewGifCropped" && !header.subarray(0, 4).toString("ascii").startsWith("GIF8")) {
    fail("Telegram motion preview is not a GIF.");
  }
  if (name === "trimmedVideoCropped" && header.subarray(4, 8).toString("ascii") !== "ftyp") {
    fail("Telegram motion clip is not an MP4.");
  }
}

function laneError(message) {
  return {
    artifacts: {},
    error: message,
    expectationMet: false,
    events: [],
    facts: null,
    invocations: [],
    status: "fail",
  };
}

function loadLane({ factsFile, expectedLane, expectedSha, publishedRoot }) {
  try {
    if (!fs.existsSync(factsFile)) {
      return laneError(`Missing ${expectedLane} lane facts.`);
    }
    const facts = readJson(factsFile);
    if (!isRecord(facts) || facts.schemaVersion !== 2 || facts.lane !== expectedLane) {
      return laneError(`${expectedLane} lane facts are invalid.`);
    }
    const attestation = facts.sutAttestation;
    if (!isRecord(attestation) || attestation.lane !== expectedLane || attestation.sha !== expectedSha) {
      return laneError(`${expectedLane} SUT attestation does not match ${expectedSha}.`);
    }
    if (facts.status !== "complete") {
      return laneError(`${expectedLane} lane ended with ${facts.status}: ${facts.error ?? "no detail"}`);
    }
    if (!Array.isArray(facts.cleanupErrors) || facts.cleanupErrors.length > 0) {
      return laneError(`${expectedLane} lane cleanup was incomplete.`);
    }
    if (!isRecord(facts.observation) || facts.observation.truncated === true) {
      return laneError(`${expectedLane} visible observation is missing or truncated.`);
    }
    if (!Number.isInteger(facts.sendCount) || facts.sendCount < 1) {
      return laneError(`${expectedLane} scenario sent no Telegram message.`);
    }
    const records = isRecord(facts.artifacts) ? facts.artifacts : {};
    const required = ["previewGifCropped", "screenshot", "trimmedVideoCropped"];
    const artifacts = {};
    for (const name of required) {
      const record = records[name];
      if (!isRecord(record) || typeof record.file !== "string") {
        return laneError(`${expectedLane} lane is missing ${name}.`);
      }
      if (record.file !== path.basename(record.file)) {
        return laneError(`${expectedLane} artifact path is invalid.`);
      }
      const source = path.join(publishedRoot, expectedLane, record.file);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        return laneError(`${expectedLane} artifact ${record.file} is missing.`);
      }
      if (fs.statSync(source).size !== record.bytes || sha256File(source) !== record.sha256) {
        return laneError(`${expectedLane} artifact ${record.file} failed integrity validation.`);
      }
      if (record.bytes <= 10_000) {
        return laneError(`${expectedLane} artifact ${record.file} is too small.`);
      }
      validateMediaSignature(source, name);
      artifacts[name] = source;
    }
    return {
      artifacts,
      error: null,
      events: visibleEvents(facts.observation.events),
      facts,
      invocations: normalizeInvocations(facts.invocations),
      status: "pass",
    };
  } catch (error) {
    return laneError(`${expectedLane} lane validation failed: ${error.message}`);
  }
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

function laneArtifacts(outputDir, laneName, lane, artifacts) {
  if (lane.error) {
    return;
  }
  const prefix = laneName === "baseline" ? "before" : "after";
  const dir = path.join(outputDir, laneName);
  const gif = copyFile(lane.artifacts.previewGifCropped, path.join(dir, `${prefix}.gif`));
  const png = copyFile(lane.artifacts.screenshot, path.join(dir, `${prefix}.png`));
  const mp4 = copyFile(lane.artifacts.trimmedVideoCropped, path.join(dir, `${prefix}.mp4`));
  artifacts.push(
    {
      alt: laneName === "baseline" ? "Before on current main" : "After on this pull request",
      inline: true,
      kind: "timeline",
      label: laneName === "baseline" ? "Before — current main" : "After — this PR",
      lane: laneName,
      path: path.relative(outputDir, gif),
      required: true,
      targetPath: `${laneName}/${prefix}.gif`,
    },
    {
      alt: laneName === "baseline" ? "Final Telegram screenshot before" : "Final Telegram screenshot after",
      inline: true,
      kind: "desktopScreenshot",
      label: laneName === "baseline" ? "Before — final Telegram" : "After — final Telegram",
      lane: laneName,
      path: path.relative(outputDir, png),
      required: true,
      targetPath: `${laneName}/${prefix}.png`,
    },
    {
      kind: "motionClip",
      label: laneName === "baseline" ? "Before motion clip" : "After motion clip",
      lane: laneName,
      path: path.relative(outputDir, mp4),
      required: true,
      targetPath: `${laneName}/${prefix}.mp4`,
    },
  );
}

function laneComparison({ contract, lane, ref, results, sha }) {
  const expectationMet = !lane.error && results.every((result) => result.passed);
  return {
    detail: commentText(lane.error ?? summarizeVisibleEvents(lane.events), 1_000),
    expectationMet,
    expected: commentText(contract.description, 500),
    ref,
    sha,
    status: lane.error ? "fail" : expectationMet ? "pass" : "fail",
  };
}

export function evaluateVisibleProof(options) {
  const scenario = validateScenarioDirectory(options.scenarioDir);
  if (scenario.hash !== options.scenarioHash) {
    fail(`Scenario hash changed: expected ${options.scenarioHash}, got ${scenario.hash}.`);
  }
  fs.mkdirSync(options.outputDir, { recursive: true });
  const baseline = loadLane({
    expectedLane: "baseline",
    expectedSha: options.baselineSha,
    factsFile: options.baselineFacts,
    publishedRoot: options.publishedRoot,
  });
  const candidate = loadLane({
    expectedLane: "candidate",
    expectedSha: options.candidateSha,
    factsFile: options.candidateFacts,
    publishedRoot: options.publishedRoot,
  });

  const baselineResults = baseline.error
    ? scenario.assertions.baseline.expect.map(() => ({ passed: false, summary: baseline.error }))
    : scenario.assertions.baseline.expect.map((assertion) => evaluateAssertion(baseline.events, assertion));
  const candidateResults = candidate.error
    ? scenario.assertions.candidate.expect.map(() => ({ passed: false, summary: candidate.error }))
    : scenario.assertions.candidate.expect.map((assertion) => evaluateAssertion(candidate.events, assertion));
  const baselineMet = !baseline.error && baselineResults.every((result) => result.passed);
  const candidateMet = !candidate.error && candidateResults.every((result) => result.passed);
  const normalizedBaseline = normalizeVisibleEvents(baseline.events);
  const normalizedCandidate = normalizeVisibleEvents(candidate.events);
  const structureDifferent = stableStringify(normalizedBaseline) !== stableStringify(normalizedCandidate);
  const timingDifference = materialTimingDifference(
    scenario.assertions,
    baselineResults,
    candidateResults,
  );
  const invocationsMatch =
    !baseline.error &&
    !candidate.error &&
    stableStringify(baseline.invocations) === stableStringify(candidate.invocations);
  const materialDifference = structureDifferent || Boolean(timingDifference);

  const baselineExit = Number(options.baselineExit ?? 0);
  const candidateExit = Number(options.candidateExit ?? 0);

  let outcome = "pass";
  let differential = structureDifferent
    ? "The Telegram-visible message/edit/delete timeline changed."
    : timingDifference
      ? `The same visible event gap changed by ${timingDifference.deltaMs}ms.`
      : "The Telegram-visible timelines were identical.";
  if (baseline.error || candidate.error) {
    outcome = "fail";
    differential = baseline.error ?? candidate.error;
  } else if (baselineExit !== 0 || candidateExit !== 0) {
    outcome = "fail";
    differential = `Frozen scenario exited nonzero (main ${baselineExit}, PR ${candidateExit}).`;
  } else if (!invocationsMatch) {
    outcome = "blocked";
    differential = "Baseline and candidate did not receive the same normalized scenario actions.";
  } else if (!baselineMet) {
    outcome = "blocked";
    differential = "Current main did not visibly reproduce the declared defect.";
  } else if (!materialDifference) {
    outcome = "blocked";
    differential = "No material Telegram-visible before/after difference was proved.";
  } else if (!candidateMet) {
    outcome = "fail";
    differential = "The pull request did not satisfy its Telegram-visible assertion.";
  }

  const artifacts = [];
  laneArtifacts(options.outputDir, "baseline", baseline, artifacts);
  laneArtifacts(options.outputDir, "candidate", candidate, artifacts);

  const comparison = {
    baseline: {
      contract: scenario.assertions.baseline,
      normalizedEvents: normalizedBaseline,
      results: baselineResults,
    },
    candidate: {
      contract: scenario.assertions.candidate,
      normalizedEvents: normalizedCandidate,
      results: candidateResults,
    },
    baselineExit,
    candidateExit,
    invocationsMatch,
    materialDifference,
    outcome,
    scenarioHash: scenario.hash,
    structureDifferent,
    timingDifference,
  };
  writeJson(path.join(options.outputDir, "comparison.json"), comparison);
  writeJson(path.join(options.outputDir, "baseline", "visible-events.json"), {
    events: normalizedBaseline,
    results: baselineResults,
  });
  writeJson(path.join(options.outputDir, "candidate", "visible-events.json"), {
    events: normalizedCandidate,
    results: candidateResults,
  });
  writeJson(path.join(options.outputDir, "scenario.json"), {
    assertions: scenario.assertions,
    bytes: scenario.bytes,
    fileCount: scenario.fileCount,
    hash: scenario.hash,
  });
  artifacts.push(
    {
      kind: "attachment",
      label: "Trusted visible comparison",
      lane: "run",
      path: "comparison.json",
      required: true,
      targetPath: "comparison.json",
    },
    {
      kind: "attachment",
      label: "Frozen scenario metadata",
      lane: "run",
      path: "scenario.json",
      required: true,
      targetPath: "scenario.json",
    },
  );

  const runtimeSeconds = Math.round(
    ((baseline.facts?.observation?.uptimeMs ?? 0) +
      (candidate.facts?.observation?.uptimeMs ?? 0)) /
      1_000,
  );
  const manifest = {
    artifacts,
    comparison: {
      baseline: laneComparison({
        contract: scenario.assertions.baseline,
        lane: baseline,
        ref: options.baselineRef,
        results: baselineResults,
        sha: options.baselineSha,
      }),
      candidate: laneComparison({
        contract: scenario.assertions.candidate,
        lane: candidate,
        ref: options.candidateRef,
        results: candidateResults,
        sha: options.candidateSha,
      }),
      differential,
      outcome,
      pass: outcome === "pass",
    },
    id: "telegram-visible-proof",
    runtimeSeconds,
    scenario: `${commentText(scenario.assertions.name, 200)} · sha256:${scenario.hash}`,
    scenarioHash: scenario.hash,
    schemaVersion: 2,
    summary:
      outcome === "pass"
        ? `The same frozen real-user Telegram scenario reproduced the defect on main and showed the repair on this PR. Replay runtime: ${runtimeSeconds}s.`
        : outcome === "blocked"
          ? `${commentText(differential, 600)} Replay runtime: ${runtimeSeconds}s.`
          : `The trusted Telegram-visible proof did not pass. Replay runtime: ${runtimeSeconds}s.`,
    title: `Mantis Telegram proof — ${outcome.toUpperCase()}`,
  };
  writeJson(path.join(options.outputDir, "mantis-evidence.json"), manifest);
  return { manifest, comparison };
}
