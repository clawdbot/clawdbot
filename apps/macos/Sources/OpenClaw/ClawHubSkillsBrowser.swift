import Observation
import OpenClawKit
import SwiftUI

struct ClawHubSkillsBrowser: View {
    @State private var model = ClawHubSkillsBrowserModel()
    let installedSkills: [SkillStatus]
    let onInstalled: (GatewaySkillCatalog) -> Void

    init(
        gateway: GatewayConnection = .shared,
        installedSkills: [SkillStatus],
        onInstalled: @escaping (GatewaySkillCatalog) -> Void)
    {
        self._model = State(initialValue: ClawHubSkillsBrowserModel(gateway: gateway))
        self.installedSkills = installedSkills
        self.onInstalled = onInstalled
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SettingsCardGroup("Browse ClawHub") {
                SettingsCardRow(
                    title: "Discover skills",
                    subtitle: "The Gateway verifies the exact reviewed release before download.",
                    showsDivider: false)
                {
                    TextField("Search ClawHub", text: self.$model.query)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 260)
                        .onSubmit { Task { await self.model.search() } }
                    Button {
                        Task { await self.model.search() }
                    } label: {
                        Label("Search", systemImage: "magnifyingglass")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.model.isSearching)
                }
            }

            ForEach(Array(self.model.notices.enumerated()), id: \.offset) { _, notice in
                ClawHubNoticeCard(notice: notice)
            }

            if self.model.isSearching || self.model.searchResults != nil {
                SettingsCardGroup("Results") {
                    if self.model.isSearching, self.model.results.isEmpty {
                        SettingsCardRow(title: "Searching ClawHub…", showsDivider: false) {
                            ProgressView().controlSize(.small)
                        }
                    } else if self.model.searchResults?.skills.isEmpty == true {
                        SettingsCardRow(
                            title: "No skills found",
                            subtitle: "Try another search or refresh the catalog.",
                            showsDivider: false)
                        {
                            EmptyView()
                        }
                    } else if let results = self.model.searchResults {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(results.skills.enumerated()), id: \.element.id) { index, skill in
                                ClawHubSkillResultRow(
                                    skill: skill,
                                    installed: SkillManagementContract.installed(
                                        self.installedSkills,
                                        searchResult: skill),
                                    isBusy: self.model.reviewingSlug == skill.reference || self.model.installingSlug
                                        .map {
                                            SkillManagementContract.sameClawHubSkill($0, skill.reference)
                                        } == true,
                                    showsDivider: index != self.model.results.count - 1)
                                {
                                    Task {
                                        if let skills = await self.model.act(on: skill, source: results.source) {
                                            self.onInstalled(skills)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .task { await self.model.run() }
        .sheet(item: self.$model.sheet) { sheet in
            ClawHubInstallReviewSheet(
                review: sheet.review,
                isInstalling: self.model.installingSlug == sheet.review.slug,
                onCancel: { self.model.sheet = nil },
                onInstall: {
                    Task {
                        if let skills = await self.model.install(sheet.review, source: sheet.source) {
                            self.onInstalled(skills)
                        }
                    }
                })
        }
    }
}

private struct ClawHubSkillResultRow: View {
    let skill: ClawHubSkillSummary
    let installed: Bool
    let isBusy: Bool
    let showsDivider: Bool
    let onAction: () -> Void

    /// Same-slug rows share a display name and often a summary, so the reference always shows:
    /// it is the only thing that tells them apart and what install sends back. An unscanned source
    /// says so here, because that row never opens a review card that could carry the warning.
    private var subtitle: String {
        var parts = [String]()
        if let summary = self.skill.summary {
            parts.append(summary)
        }
        parts.append(self.skill.reference)
        if self.skill.isUnscannedSource {
            parts.append(String(localized: "Not scanned by ClawHub"))
        }
        return parts.joined(separator: " · ")
    }

    private var actionTitle: String {
        if self.installed {
            return "Installed"
        }
        return self.skill.canReadDetails ? "Review" : "Install"
    }

    var body: some View {
        SettingsCardRow(
            title: .verbatim(self.skill.displayName),
            subtitle: .verbatim(self.subtitle),
            showsDivider: self.showsDivider)
        {
            if let version = self.skill.version {
                Text(version)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            // Install-only sources get no Review button: the Gateway cannot answer detail for them.
            Button(self.actionTitle, action: self.onAction)
                .buttonStyle(.bordered)
                .disabled(self.isBusy || self.installed)
        }
    }
}

private struct ClawHubInstallReviewSheet: View {
    let review: ClawHubSkillInstallReview
    let isInstalling: Bool
    let onCancel: () -> Void
    let onInstall: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Review ClawHub skill").font(.title2.bold())
            ClawHubReviewDetails(review: self.review)
            Text("The Gateway will verify this exact release with ClawHub before download.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel", action: self.onCancel)
                Button("Verify and install", action: self.onInstall)
                    .buttonStyle(.borderedProminent)
                    .disabled(self.isInstalling)
            }
        }
        .padding(24)
        .frame(width: 480)
    }
}

private struct ClawHubReviewDetails: View {
    let review: ClawHubSkillInstallReview

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(self.review.displayName).font(.headline)
            if let summary = self.review.summary {
                Text(summary).foregroundStyle(.secondary)
            }
            if let version = self.review.version {
                LabeledContent("Version", value: version)
            }
            LabeledContent("Publisher", value: self.review.author)
        }
    }
}

private struct ClawHubNoticeCard: View {
    let notice: ClawHubSkillsBrowserModel.Notice

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: self.notice.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(self.notice.isError ? .orange : .green)
            VStack(alignment: .leading, spacing: 4) {
                Text(self.notice.title).font(.headline)
                Text(self.notice.message).font(.footnote).textSelection(.enabled)
                if let warning = self.notice.warning {
                    Text(warning).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            Spacer()
        }
        .padding(14)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
