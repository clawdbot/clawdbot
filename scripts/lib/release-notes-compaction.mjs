// Shared plain-JavaScript rendering also runs in package preflight before dependency setup.
export const OPENCLAW_RELEASE_TAG_PATTERN =
  /^v[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:(?:alpha|beta)\.[1-9][0-9]*|[1-9][0-9]*))?$/u;

const CONTRIBUTION_RECORD_HEADING = "### Complete contribution record";

export function validateReleaseNotesRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`invalid GitHub repository: ${repository}`);
  }
}

export function validateReleaseNotesTag(tag) {
  if (!OPENCLAW_RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error(`invalid release tag: ${tag}`);
  }
}

function tagPinnedContributionRecordUrl(repository, tag) {
  validateReleaseNotesRepository(repository);
  validateReleaseNotesTag(tag);
  return `https://github.com/${repository}/blob/${tag}/CHANGELOG.md#complete-contribution-record`;
}

function headingIndexOutsideFences(markdown, heading) {
  let offset = 0;
  let fence;
  for (const segment of markdown.split(/(?<=\n)/u)) {
    const line = segment.replace(/\n$/u, "");
    const fenceMatch = line.match(/^\s*(?<marker>`{3,}|~{3,})/u);
    if (fenceMatch?.groups?.marker) {
      const marker = fenceMatch.groups.marker;
      if (!fence) {
        fence = marker;
      } else if (marker.charAt(0) === fence.charAt(0) && marker.length >= fence.length) {
        fence = undefined;
      }
    } else if (!fence && line === heading) {
      return offset;
    }
    offset += segment.length;
  }
  return -1;
}

export function compactReleaseNotes(section, repository, tag) {
  const recordIndex = headingIndexOutsideFences(section, CONTRIBUTION_RECORD_HEADING);
  if (recordIndex < 0) {
    return null;
  }
  const editorialNotes = section.slice(0, recordIndex).trimEnd();
  const contributionRecordUrl = tagPinnedContributionRecordUrl(repository, tag);
  const body = [
    editorialNotes,
    "",
    CONTRIBUTION_RECORD_HEADING,
    "",
    `The full contribution record is available in the tag-pinned [CHANGELOG.md](${contributionRecordUrl}).`,
  ].join("\n");
  return { body, editorialNotes };
}
