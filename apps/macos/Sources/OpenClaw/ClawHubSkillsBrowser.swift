import Observation
import OpenClawKit
import SwiftUI

private enum ClawHubReviewSheet: Identifiable {
    case install(ClawHubSkillInstallReview, route: GatewayConnection.Route)
    case risk(ClawHubSkillInstallReview, route: GatewayConnection.Route, message: String, warning: String?)

    var id: String {
        switch self {
        case let .install(review, _): "install:\(review.id)"
        case let .risk(review, _, _, _): "risk:\(review.id)"
        }
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
                                installed: skill.version.map {
                                    SkillManagementContract.installed(
                                        self.installedSkills,
                                        slug: skill.slug,
                                        version: $0)
                                } ?? SkillManagementContract.installed(
                                    self.installedSkills,
                                    slug: skill.slug),
                                isBusy: self.model.reviewingSlug == skill.slug || self.model.installingSlug.map {
                                    SkillManagementContract.sameClawHubSkill($0, skill.slug)
                                } == true,
                                showsDivider: index != self.model.results.count - 1)
                            {
                                Task { await self.model.review(skill) }
                            }
                        }
                    }
                }
            }
        }
        .task { await self.model.searchIfNeeded() }
        .sheet(item: self.$model.sheet) { sheet in
            switch sheet {
            case let .install(review, route):
                ClawHubInstallReviewSheet(
                    review: review,
                    isInstalling: self.model.installingSlug == review.slug,
                    onCancel: { self.model.sheet = nil },
                    onInstall: {
                        Task {
                            if let skills = await self.model.install(review, route: route, acknowledgeRisk: false) {
                                self.onInstalled(skills)
                            }
                        }
                    })
            case let .risk(review, route, message, warning):
                ClawHubRiskReviewSheet(
                    review: review,
                    message: message,
                    warning: warning,
                    isInstalling: self.model.installingSlug == review.slug,
                    onCancel: { self.model.sheet = nil },
                    onInstall: {
                        Task {
                            if let skills = await self.model.install(review, route: route, acknowledgeRisk: true) {
                                self.onInstalled(skills)
                            }
                        }
                    })
            }
        }
    }
}

private struct ClawHubSkillResultRow: View {
    let skill: ClawHubSkillSummary
    let installed: Bool
    let isBusy: Bool
    let showsDivider: Bool
    let onReview: () -> Void

    var body: some View {
        SettingsCardRow(
            title: self.skill.displayName,
            subtitle: self.skill.summary ?? self.skill.slug,
            showsDivider: self.showsDivider)
        {
            if let version = self.skill.version {
                Text(version)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Button(self.installed ? "Installed" : "Review", action: self.onReview)
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

private struct ClawHubRiskReviewSheet: View {
    let review: ClawHubSkillInstallReview
    let message: String
    let warning: String?
    let isInstalling: Bool
    let onCancel: () -> Void
    let onInstall: () -> Void
    @State private var warningExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Gateway warning", systemImage: "exclamationmark.triangle.fill")
                .font(.title2.bold())
                .foregroundStyle(.orange)
            ClawHubReviewDetails(review: self.review)
            Text(self.message).font(.body)
            DisclosureGroup("Review warning details", isExpanded: self.$warningExpanded) {
                Text(self.warning ?? "The Gateway requires explicit acknowledgement for this release.")
                    .font(.callout)
                    .textSelection(.enabled)
                    .padding(.top, 8)
            }
            Text("Expand and review the Gateway warning before acknowledging this exact version.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel", action: self.onCancel)
                Button("Acknowledge and install", action: self.onInstall)
                    .buttonStyle(.borderedProminent)
                    .disabled(!self.warningExpanded || self.isInstalling)
            }
        }
        .padding(24)
        .frame(width: 520)
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
            LabeledContent("Version", value: self.review.version)
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

    func review(_ skill: ClawHubSkillSummary) async {
        guard self.reviewingSlug == nil else { return }
        self.reviewingSlug = skill.slug
        self.notice = nil
        defer { self.reviewingSlug = nil }
        do {
            guard let route = await GatewayConnection.shared.captureRoute() else {
                throw ClawHubSkillsBrowserError.gatewayUnavailable
            }
            let detail = try await GatewayConnection.shared.skillsDetail(slug: skill.slug, on: route)
            guard let review = ClawHubSkillInstallReview(detail: detail, fallback: skill) else {
                throw ClawHubSkillsBrowserError.missingInstallVersion
            }
            self.sheet = .install(review, route: route)
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
        route: GatewayConnection.Route,
        acknowledgeRisk: Bool) async -> [SkillStatus]?
    {
        guard self.installingSlug == nil else { return nil }
        self.installingSlug = review.slug
        self.notice = nil
        defer { self.installingSlug = nil }
        do {
            let result = try await GatewayConnection.shared.skillsInstallClawHub(
                slug: review.slug,
                version: review.version,
                acknowledgeRisk: acknowledgeRisk,
                on: route)
            let report = try await GatewayConnection.shared.skillsStatus(on: route)
            guard SkillManagementContract.installed(report.skills, slug: review.slug, version: review.version) else {
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
            let rejection = SkillManagementContract.rejection(from: error, attemptedVersion: review.version)
            if rejection.requiresAcknowledgement, !acknowledgeRisk {
                self.sheet = .risk(
                    review,
                    route: route,
                    message: rejection.message,
                    warning: rejection.warning)
            } else {
                self.sheet = nil
                self.notice = Notice(
                    title: "Gateway blocked install",
                    message: rejection.message,
                    warning: rejection.warning,
                    isError: true)
            }
            return nil
        } catch {
            if let report = try? await GatewayConnection.shared.skillsStatus(on: route),
               SkillManagementContract.installed(report.skills, slug: review.slug, version: review.version)
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
