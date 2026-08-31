import Observation
import OpenClawKit
import SwiftUI

private struct ClawHubReviewSheet: Identifiable {
    let review: ClawHubSkillInstallReview
    let route: GatewayConnection.Route

    var id: String {
        "install:\(self.review.id)"
    }
}

struct ClawHubSkillsBrowser: View {
    @State private var model = ClawHubSkillsBrowserModel()
    let installedSkills: [SkillStatus]
    let onInstalled: ([SkillStatus]) -> Void

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

            if let notice = self.model.notice {
                ClawHubNoticeCard(notice: notice)
            }

            SettingsCardGroup("Results") {
                if self.model.isSearching, self.model.results.isEmpty {
                    SettingsCardRow(title: "Searching ClawHub…", showsDivider: false) {
                        ProgressView().controlSize(.small)
                    }
                } else if self.model.results.isEmpty {
                    SettingsCardRow(
                        title: "No skills found",
                        subtitle: "Try another search or refresh the catalog.",
                        showsDivider: false)
                    {
                        EmptyView()
                    }
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(self.model.results.enumerated()), id: \.element.id) { index, skill in
                            ClawHubSkillResultRow(
                                skill: skill,
                                installed: SkillManagementContract.installed(
                                    self.installedSkills,
                                    searchResult: skill),
                                isBusy: self.model.reviewingSlug == skill.reference || self.model.installingSlug.map {
                                    SkillManagementContract.sameClawHubSkill($0, skill.reference)
                                } == true,
                                showsDivider: index != self.model.results.count - 1)
                            {
                                Task {
                                    if let skills = await self.model.act(on: skill) {
                                        self.onInstalled(skills)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .task { await self.model.searchIfNeeded() }
        .sheet(item: self.$model.sheet) { sheet in
            ClawHubInstallReviewSheet(
                review: sheet.review,
                isInstalling: self.model.installingSlug == sheet.review.slug,
                onCancel: { self.model.sheet = nil },
                onInstall: {
                    Task {
                        if let skills = await self.model.install(sheet.review, route: sheet.route) {
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

@MainActor
@Observable
private final class ClawHubSkillsBrowserModel {
    struct Notice {
        let title: String
        let message: String
        let warning: String?
        let isError: Bool
    }

    var query = ""
    var results: [ClawHubSkillSummary] = []
    var isSearching = false
    var reviewingSlug: String?
    var installingSlug: String?
    var sheet: ClawHubReviewSheet?
    var notice: Notice?
    private var hasSearched = false

    func searchIfNeeded() async {
        guard !self.hasSearched else { return }
        await self.search()
    }

    func search() async {
        guard !self.isSearching else { return }
        self.isSearching = true
        self.notice = nil
        defer { self.isSearching = false }
        do {
            guard let route = await GatewayConnection.shared.captureRoute() else {
                throw ClawHubSkillsBrowserError.gatewayUnavailable
            }
            self.results = try await GatewayConnection.shared.skillsSearch(query: self.query, on: route)
            self.hasSearched = true
        } catch {
            self.notice = Notice(
                title: "ClawHub unavailable",
                message: error.localizedDescription,
                warning: nil,
                isError: true)
        }
    }

    /// Routes a row to the only action its source supports. Install-only results skip review and
    /// install the exact reference search returned, so the picked source is the installed source.
    func act(on skill: ClawHubSkillSummary) async -> [SkillStatus]? {
        guard skill.canReadDetails else {
            guard let route = await GatewayConnection.shared.captureRoute() else {
                self.notice = Notice(
                    title: "Could not install skill",
                    message: ClawHubSkillsBrowserError.gatewayUnavailable.localizedDescription,
                    warning: nil,
                    isError: true)
                return nil
            }
            return await self.install(
                ClawHubSkillInstallReview(directInstall: skill),
                route: route)
        }
        await self.review(skill)
        return nil
    }

    func review(_ skill: ClawHubSkillSummary) async {
        guard self.reviewingSlug == nil else { return }
        self.reviewingSlug = skill.reference
        self.notice = nil
        defer { self.reviewingSlug = nil }
        do {
            guard let route = await GatewayConnection.shared.captureRoute() else {
                throw ClawHubSkillsBrowserError.gatewayUnavailable
            }
            let detail = try await GatewayConnection.shared.skillsDetail(slug: skill.reference, on: route)
            guard let review = ClawHubSkillInstallReview(detail: detail, fallback: skill) else {
                throw ClawHubSkillsBrowserError.missingInstallVersion
            }
            self.sheet = ClawHubReviewSheet(review: review, route: route)
        } catch {
            self.notice = Notice(
                title: "Could not review skill",
                message: error.localizedDescription,
                warning: nil,
                isError: true)
        }
    }

    func install(
        _ review: ClawHubSkillInstallReview,
        route: GatewayConnection.Route) async -> [SkillStatus]?
    {
        guard self.installingSlug == nil else { return nil }
        self.installingSlug = review.slug
        self.notice = nil
        defer { self.installingSlug = nil }
        do {
            let result = try await GatewayConnection.shared.skillsInstallClawHub(
                slug: review.slug,
                version: review.version,
                on: route)
            let report = try await GatewayConnection.shared.skillsStatus(on: route)
            guard installedAfter(report.skills, review: review) else {
                self.sheet = nil
                self.notice = Notice(
                    title: "Install result unknown",
                    // swiftlint:disable line_length
                    message: "Reconnect, refresh Skills, then retry. The Gateway safely joins a matching install still running.",
                    // swiftlint:enable line_length
                    warning: result.warning,
                    isError: true)
                return nil
            }
            self.sheet = nil
            self.notice = Notice(
                title: "Installed",
                message: result.message,
                warning: result.warning,
                isError: false)
            return report.skills
        } catch let error as GatewayResponseError {
            let rejection = SkillManagementContract.rejection(from: error)
            self.sheet = nil
            self.notice = Notice(
                title: "Gateway blocked install",
                message: rejection.message,
                warning: rejection.warning,
                isError: true)
            return nil
        } catch {
            if let report = try? await GatewayConnection.shared.skillsStatus(on: route),
               installedAfter(report.skills, review: review)
            {
                self.sheet = nil
                self.notice = Notice(
                    title: "Installed",
                    message: "The Gateway installed the reviewed version.",
                    warning: nil,
                    isError: false)
                return report.skills
            }
            self.sheet = nil
            self.notice = Notice(
                title: "Install result unknown",
                message: error.localizedDescription,
                warning: nil,
                isError: true)
            return nil
        }
    }
}

/// An install-only source resolves to a commit, not a release, and its reference is not a
/// `@owner/slug` spelling, so confirmation matches the reference the Gateway recorded.
private func installedAfter(_ skills: [SkillStatus], review: ClawHubSkillInstallReview) -> Bool {
    if let requestedReference = review.requestedReference {
        return SkillManagementContract.installed(skills, requestedReference: requestedReference)
    }
    guard let version = review.version else {
        return SkillManagementContract.installed(skills, slug: review.slug)
    }
    return SkillManagementContract.installed(skills, slug: review.slug, version: version)
}

private enum ClawHubSkillsBrowserError: LocalizedError {
    case gatewayUnavailable
    case missingInstallVersion

    var errorDescription: String? {
        switch self {
        case .gatewayUnavailable:
            "Connect to a Gateway and try again."
        case .missingInstallVersion:
            "ClawHub did not report an installable version for this skill."
        }
    }
}
