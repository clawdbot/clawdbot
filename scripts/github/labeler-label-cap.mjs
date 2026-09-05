// One owner for GitHub's 100-labels-per-issue cap. Labeler steps are cosmetic: hitting the cap
// is a visible warning naming the skipped label, never a red check. Unrelated errors still throw.
export async function addLabelsWithinCap({ github, core, owner, repo, issueNumber, labels }) {
  try {
    await github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
    return true;
  } catch (error) {
    if (error?.status !== 422 || !/cannot have more than 100 labels/i.test(error.message ?? "")) {
      throw error;
    }
    core.warning(
      `Skipping label ${labels.map((label) => JSON.stringify(label)).join(", ")} on #${issueNumber}: GitHub caps issues at 100 labels.`,
    );
    return false;
  }
}
