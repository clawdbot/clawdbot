import OpenClawKit
import SwiftUI

private enum SkillsSettingsSection: String, CaseIterable, Identifiable {
    case installed
    case browse

    var id: String {
        rawValue
    }

    var title: String {
        self == .installed ? String(localized: "Installed") : String(localized: "Browse")
    }
}

private enum InstalledSkillFilter: String, CaseIterable, Identifiable {
    case all
    case ready
    case setup
    case off

    var id: String {
        rawValue
    }

    var title: String {
        switch self {
        case .all: String(localized: "All")
        case .ready: String(localized: "Ready")
        case .setup: String(localized: "Needs Setup")
        case .off: String(localized: "Off")
        }
    }
}

private enum SkillsReviewSheet: Identifiable {
    case install(ClawHubSkillInstallReview, route: GatewayNodeSessionRoute)
    case risk(ClawHubSkillInstallReview, route: GatewayNodeSessionRoute, message: String, warning: String?)

    var id: String {
        switch self {
        case let .install(review, _): "install:\(review.id)"
        case let .risk(review, _, _, _): "risk:\(review.id)"
        }
    }
}

struct SettingsSkillsDestination: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var section: SkillsSettingsSection = .installed
    @State private var installedFilter: InstalledSkillFilter = .all
    @State private var installedQuery = ""
    @State private var installedSkills: [SkillStatus] = []
    @State private var installedLoadID: UUID?
    @State private var mutationIDs: [String: UUID] = [:]
    @State private var browseQuery = ""
    @State private var searchResults: [ClawHubSkillSummary] = []
    @State private var searchID: UUID?
    @State private var reviewingSlug: String?
    @State private var reviewID: UUID?
    @State private var installingSlug: String?
    @State private var installID: UUID?
    @State private var reviewSheet: SkillsReviewSheet?
    @State private var clawHubSupported: Bool?
    @State private var notice: SkillsNotice?
    @State private var loadedGatewayID: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                self.summaryCard
                self.sectionPicker
                if self.section == .installed {
                    self.installedContent
                } else {
                    self.browseContent
                }
            }
            .padding(.vertical, 12)
        }
        .font(OpenClawType.body)
        .task(id: self.refreshID) { await self.loadInitialState() }
        .refreshable { await self.refreshVisibleSection() }
        .onChange(of: self.appModel.connectedGatewayID) { _, _ in
            self.resetGatewayState()
        }
        .onChange(of: self.section) { _, section in
            guard section == .browse, self.searchResults.isEmpty else { return }
            Task { await self.searchClawHub() }
        }
        .sheet(item: self.$reviewSheet) { sheet in
            switch sheet {
            case let .install(review, route):
                SkillsInstallReviewSheet(
                    review: review,
                    canInstall: self.canAdmin,
                    isInstalling: self.installingSlug == review.slug,
                    onCancel: { self.reviewSheet = nil },
                    onInstall: { Task { await self.install(review, route: route, acknowledgeRisk: false) } })
            case let .risk(review, route, message, warning):
                SkillsRiskReviewSheet(
                    review: review,
                    message: message,
                    warning: warning,
                    isInstalling: self.installingSlug == review.slug,
                    onCancel: { self.reviewSheet = nil },
                    onInstall: { Task { await self.install(review, route: route, acknowledgeRisk: true) } })
            }
        }
    }

    private var refreshID: String {
        [
            self.canRead ? "connected" : "offline",
            self.scenePhase == .active ? "active" : "inactive",
            self.appModel.connectedGatewayID ?? "no-gateway",
        ].joined(separator: ":")
    }

    private var canRead: Bool {
        self.appModel.isOperatorGatewayConnected
    }

    private var canAdmin: Bool {
        self.appModel.hasOperatorAdminScope
    }

    private var isLoadingInstalled: Bool {
        self.installedLoadID != nil
    }

    private var isSearching: Bool {
        self.searchID != nil
    }

    private var readyCount: Int {
        self.installedSkills.count(where: Self.isReady)
    }

    private var setupCount: Int {
        self.installedSkills.count(where: Self.needsSetup)
    }

    private var summaryCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: "sparkles", color: OpenClawBrand.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Skills").font(OpenClawType.headline)
                    Text(self.summaryText)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                ProValuePill(value: self.summaryValue, color: self.summaryColor)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var summaryText: String {
        guard self.canRead else { return String(localized: "Connect to manage Gateway skills.") }
        if self.isLoadingInstalled, self.installedSkills.isEmpty {
            return String(localized: "Loading installed skills and readiness.")
        }
        return String(
            format: String(localized: "%@ ready · %@ need setup"),
            self.readyCount.formatted(),
            self.setupCount.formatted())
    }

    private var summaryValue: String {
        guard self.canRead else { return String(localized: "offline") }
        if self.isLoadingInstalled, self.installedSkills.isEmpty {
            return String(localized: "loading")
        }
        return self.installedSkills.count.formatted()
    }

    private var summaryColor: Color {
        guard self.canRead else { return .secondary }
        return self.setupCount > 0 ? OpenClawBrand.warn : OpenClawBrand.ok
    }

    private var sectionPicker: some View {
        Picker(selection: self.$section) {
            ForEach(SkillsSettingsSection.allCases) { section in
                Text(verbatim: section.title).font(OpenClawType.captionSemiBold).tag(section)
            }
        } label: {
            Text("Skills section").font(OpenClawType.captionSemiBold)
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var installedContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.installedControls
            if let notice {
                SkillsNoticeCard(notice: notice)
            }
            ProCard(padding: 0, radius: SettingsLayout.cardRadius) {
                VStack(spacing: 0) {
                    ProPanelHeader(
                        title: "Installed",
                        value: self.filteredInstalledSkills.count.formatted(),
                        actionIcon: self.isLoadingInstalled ? "hourglass" : "arrow.clockwise",
                        actionAccessibilityLabel: "Refresh Skills",
                        isActionDisabled: self.isLoadingInstalled,
                        action: { Task { await self.loadInstalled() } })
                    self.installedRows
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var installedControls: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 10) {
                TextField(
                    text: self.$installedQuery,
                    prompt: Text("Search installed skills").font(OpenClawType.body))
                {
                    Text("Search installed skills").font(OpenClawType.body)
                }
                .font(OpenClawType.body)
                .textFieldStyle(.roundedBorder)
                Picker(selection: self.$installedFilter) {
                    ForEach(InstalledSkillFilter.allCases) { filter in
                        Text(verbatim: filter.title).font(OpenClawType.captionSemiBold).tag(filter)
                    }
                } label: {
                    Text("Installed skill filter").font(OpenClawType.captionSemiBold)
                }
                .pickerStyle(.segmented)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    @ViewBuilder
    private var installedRows: some View {
        if !self.canRead {
            ProStatusRow(
                icon: "wifi.slash",
                title: "Gateway offline",
                detail: "Connect to load and manage installed skills.",
                value: "offline",
                color: .secondary)
        } else if self.isLoadingInstalled, self.installedSkills.isEmpty {
            ProStatusRow(
                icon: "hourglass",
                title: "Loading skills",
                detail: "Reading the Gateway skill catalog.",
                value: "loading",
                color: OpenClawBrand.accent)
        } else if self.filteredInstalledSkills.isEmpty {
            ProStatusRow(
                icon: "tray",
                title: self.installedSkills.isEmpty ? "No skills installed" : "No matching skills",
                detail: self.installedSkills.isEmpty
                    ? "Browse ClawHub to discover and install skills."
                    : "Change the search or readiness filter.",
                value: "empty",
                color: .secondary)
        } else {
            ForEach(Array(self.filteredInstalledSkills.enumerated()), id: \.element.id) { index, skill in
                if index > 0 {
                    Divider().padding(.leading, 58)
                }
                InstalledSkillRow(
                    skill: skill,
                    canAdmin: self.canAdmin,
                    isBusy: self.mutationIDs[skill.skillKey] != nil,
                    onToggle: { enabled in Task { await self.setEnabled(skill, enabled: enabled) } })
            }
        }
    }

    private var filteredInstalledSkills: [SkillStatus] {
        let query = self.installedQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.installedSkills.filter { skill in
            let matchesQuery = query.isEmpty
                || skill.name.localizedCaseInsensitiveContains(query)
                || skill.skillKey.localizedCaseInsensitiveContains(query)
                || skill.description.localizedCaseInsensitiveContains(query)
            let matchesFilter = switch self.installedFilter {
            case .all: true
            case .ready: Self.isReady(skill)
            case .setup: Self.needsSetup(skill)
            case .off: skill.disabled
            }
            return matchesQuery && matchesFilter
        }
    }

    private var browseContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.browseControls
            if let notice {
                SkillsNoticeCard(notice: notice)
            }
            ProCard(padding: 0, radius: SettingsLayout.cardRadius) {
                VStack(spacing: 0) {
                    ProPanelHeader(
                        title: "ClawHub",
                        value: self.searchResults.count.formatted(),
                        actionIcon: self.isSearching ? "hourglass" : "arrow.clockwise",
                        actionAccessibilityLabel: "Search ClawHub",
                        isActionDisabled: self.isSearching || self.clawHubSupported == false,
                        action: { Task { await self.searchClawHub() } })
                    self.browseRows
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var browseControls: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 10) {
                TextField(
                    text: self.$browseQuery,
                    prompt: Text("Search ClawHub").font(OpenClawType.body))
                {
                    Text("Search ClawHub").font(OpenClawType.body)
                }
                .font(OpenClawType.body)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.search)
                .onSubmit { Task { await self.searchClawHub() } }
                Button {
                    Task { await self.searchClawHub() }
                } label: {
                    Label("Search", systemImage: "magnifyingglass").font(OpenClawType.subheadSemiBold)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!self.canRead || self.isSearching || self.clawHubSupported == false)
                Text("The Gateway verifies the exact reviewed release before download.")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    @ViewBuilder
    private var browseRows: some View {
        if !self.canRead {
            ProStatusRow(
                icon: "wifi.slash",
                title: "Gateway offline",
                detail: "Connect to search and install ClawHub skills.",
                value: "offline",
                color: .secondary)
        } else if self.clawHubSupported == false {
            ProStatusRow(
                icon: "arrow.up.circle",
                title: "Gateway update required",
                detail: "Update the Gateway to search and install ClawHub skills from iOS.",
                value: "update",
                color: OpenClawBrand.warn)
        } else if self.isSearching, self.searchResults.isEmpty {
            ProStatusRow(
                icon: "hourglass",
                title: "Searching ClawHub",
                detail: "Loading verified skill releases.",
                value: "loading",
                color: OpenClawBrand.accent)
        } else if self.searchResults.isEmpty {
            ProStatusRow(
                icon: "magnifyingglass",
                title: "No skills found",
                detail: "Try another search or refresh the catalog.",
                value: "empty",
                color: .secondary)
        } else {
            ForEach(Array(self.searchResults.enumerated()), id: \.element.id) { index, skill in
                if index > 0 {
                    Divider().padding(.leading, 58)
                }
                ClawHubSkillRow(
                    skill: skill,
                    installed: skill.version.map {
                        SkillManagementContract.installed(self.installedSkills, slug: skill.slug, version: $0)
                    } ?? SkillManagementContract.installed(self.installedSkills, slug: skill.slug),
                    isBusy: self.reviewingSlug == skill.slug || self.installingSlug.map {
                        SkillManagementContract.sameClawHubSkill($0, skill.slug)
                    } == true,
                    onReview: { Task { await self.review(skill) } })
            }
        }
    }

    private func loadInitialState() async {
        guard self.scenePhase == .active else { return }
        if self.appModel.isScreenshotFixtureModeEnabled {
            self.installedSkills = Self.screenshotSkills
            self.clawHubSupported = true
            self.loadedGatewayID = self.appModel.connectedGatewayID
            return
        }
        guard self.canRead else {
            self.resetGatewayState()
            return
        }
        let gatewayID = self.appModel.connectedGatewayID
        if self.loadedGatewayID != gatewayID {
            self.resetGatewayState()
            self.loadedGatewayID = gatewayID
        }
        await self.updateClawHubSupport()
        await self.loadInstalled()
    }

    private func refreshVisibleSection() async {
        await self.updateClawHubSupport()
        if self.section == .installed {
            await self.loadInstalled()
        } else {
            await self.loadInstalled()
            await self.searchClawHub()
        }
    }

    private func updateClawHubSupport() async {
        let gatewayID = self.appModel.connectedGatewayID
        guard let route = await appModel.operatorSession.currentRoute(ifGatewayID: gatewayID) else {
            self.clawHubSupported = nil
            return
        }
        var values: [Bool?] = []
        for method in clawHubSkillGatewayMethods.sorted() {
            let supported = await appModel.operatorSession.supportsServerMethod(
                method,
                ifCurrentRoute: route)
            values.append(supported)
        }
        guard self.appModel.connectedGatewayID == gatewayID else { return }
        if values.contains(false) {
            self.clawHubSupported = false
        } else if values.allSatisfy({ $0 == true }) {
            self.clawHubSupported = true
        } else {
            self.clawHubSupported = nil
        }
    }

    private func loadInstalled() async {
        guard self.canRead, self.installedLoadID == nil else { return }
        let gatewayID = self.appModel.connectedGatewayID
        let operationID = UUID()
        self.installedLoadID = operationID
        self.notice = nil
        defer {
            if self.installedLoadID == operationID {
                self.installedLoadID = nil
            }
        }
        do {
            let route = try await gatewayRoute()
            let skills = try await fetchInstalledSkills(route: route)
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            self.installedSkills = skills
        } catch {
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            self.notice = SkillsNotice(
                title: String(localized: "Could not load skills"),
                message: error.localizedDescription,
                warning: nil,
                isError: true)
        }
    }

    private func searchClawHub() async {
        guard self.canRead,
              self.loadedGatewayID == self.appModel.connectedGatewayID,
              self.clawHubSupported != false,
              self.searchID == nil
        else { return }
        let gatewayID = self.appModel.connectedGatewayID
        let operationID = UUID()
        self.searchID = operationID
        self.notice = nil
        defer {
            if self.searchID == operationID {
                self.searchID = nil
            }
        }
        do {
            let route = try await gatewayRoute()
            let request = ClawHubSearchRequest(
                query: browseQuery.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                limit: 25)
            let data = try await self.request(
                method: "skills.search",
                params: request,
                timeoutSeconds: 20,
                route: route)
            let results = try JSONDecoder().decode(ClawHubSkillSearchResult.self, from: data).results
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            self.searchResults = results
        } catch {
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            self.notice = SkillsNotice(
                title: String(localized: "ClawHub unavailable"),
                message: error.localizedDescription,
                warning: nil,
                isError: true)
        }
    }

    private func review(_ skill: ClawHubSkillSummary) async {
        guard self.canRead,
              self.loadedGatewayID == self.appModel.connectedGatewayID,
              self.reviewID == nil
        else { return }
        let gatewayID = self.appModel.connectedGatewayID
        let operationID = UUID()
        self.reviewID = operationID
        self.reviewingSlug = skill.slug
        self.notice = nil
        defer {
            if self.reviewID == operationID {
                self.reviewID = nil
                self.reviewingSlug = nil
            }
        }
        do {
            let route = try await gatewayRoute()
            let data = try await request(
                method: "skills.detail",
                params: ClawHubDetailRequest(slug: skill.slug),
                timeoutSeconds: 20,
                route: route)
            let detail = try JSONDecoder().decode(ClawHubSkillDetail.self, from: data)
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            guard let review = ClawHubSkillInstallReview(detail: detail, fallback: skill) else {
                throw SkillsSettingsError.missingInstallVersion
            }
            self.reviewSheet = .install(review, route: route)
        } catch {
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            self.notice = SkillsNotice(
                title: String(localized: "Could not review skill"),
                message: error.localizedDescription,
                warning: nil,
                isError: true)
        }
    }

    private func install(
        _ review: ClawHubSkillInstallReview,
        route: GatewayNodeSessionRoute,
        acknowledgeRisk: Bool) async
    {
        guard self.canAdmin,
              self.loadedGatewayID == self.appModel.connectedGatewayID,
              self.installID == nil
        else { return }
        let gatewayID = self.appModel.connectedGatewayID
        let operationID = UUID()
        self.installID = operationID
        self.installingSlug = review.slug
        self.notice = nil
        defer {
            if self.installID == operationID {
                self.installID = nil
                self.installingSlug = nil
            }
        }
        do {
            let request = ClawHubInstallRequest(
                source: "clawhub",
                slug: review.slug,
                version: review.version,
                acknowledgeClawHubRisk: acknowledgeRisk ? true : nil,
                timeoutMs: clawHubInstallTimeoutMilliseconds)
            let data = try await self.request(
                method: "skills.install",
                params: request,
                timeoutSeconds: 125,
                route: route)
            let result = try JSONDecoder().decode(SkillInstallResult.self, from: data)
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            self.installedSkills = try await self.fetchInstalledSkills(route: route)
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            guard SkillManagementContract.installed(
                self.installedSkills,
                slug: review.slug,
                version: review.version)
            else {
                self.reviewSheet = nil
                self.notice = SkillsNotice(
                    title: String(localized: "Install result unknown"),
                    message: String(
                        localized:
                        """
                        Reconnect, refresh Skills, then retry. \
                        The Gateway safely joins a matching install still running.
                        """),
                    warning: result.warning,
                    isError: true)
                return
            }
            self.reviewSheet = nil
            self.notice = SkillsNotice(
                title: String(localized: "Installed"),
                message: result.message,
                warning: result.warning,
                isError: false)
        } catch let error as GatewayResponseError {
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            let rejection = SkillManagementContract.rejection(from: error, attemptedVersion: review.version)
            if rejection.requiresAcknowledgement, !acknowledgeRisk {
                self.reviewSheet = .risk(
                    review,
                    route: route,
                    message: rejection.message,
                    warning: rejection.warning)
            } else {
                self.reviewSheet = nil
                self.notice = SkillsNotice(
                    title: String(localized: "Gateway blocked install"),
                    message: rejection.message,
                    warning: rejection.warning,
                    isError: true)
            }
        } catch {
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            if let skills = try? await fetchInstalledSkills(route: route),
               appModel.connectedGatewayID == gatewayID
            {
                self.installedSkills = skills
                if SkillManagementContract.installed(skills, slug: review.slug, version: review.version) {
                    self.reviewSheet = nil
                    self.notice = SkillsNotice(
                        title: String(localized: "Installed"),
                        message: String(localized: "The Gateway installed the reviewed version."),
                        warning: nil,
                        isError: false)
                    return
                }
            }
            self.reviewSheet = nil
            self.notice = SkillsNotice(
                title: String(localized: "Install result unknown"),
                message: error.localizedDescription,
                warning: nil,
                isError: true)
        }
    }

    private func setEnabled(_ skill: SkillStatus, enabled: Bool) async {
        guard self.canAdmin,
              self.loadedGatewayID == self.appModel.connectedGatewayID,
              self.mutationIDs[skill.skillKey] == nil
        else { return }
        let gatewayID = self.appModel.connectedGatewayID
        let operationID = UUID()
        self.mutationIDs[skill.skillKey] = operationID
        self.notice = nil
        defer {
            if self.mutationIDs[skill.skillKey] == operationID {
                self.mutationIDs.removeValue(forKey: skill.skillKey)
            }
        }
        do {
            let route = try await gatewayRoute()
            _ = try await self.request(
                method: "skills.update",
                params: SkillEnabledRequest(skillKey: skill.skillKey, enabled: enabled),
                timeoutSeconds: 20,
                route: route)
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            let skills = try await fetchInstalledSkills(route: route)
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            self.installedSkills = skills
            self.notice = SkillsNotice(
                title: enabled ? String(localized: "Skill enabled") : String(localized: "Skill disabled"),
                message: skill.name,
                warning: nil,
                isError: false)
        } catch {
            guard self.appModel.connectedGatewayID == gatewayID else { return }
            self.notice = SkillsNotice(
                title: enabled ? String(localized: "Could not enable skill") :
                    String(localized: "Could not disable skill"),
                message: error.localizedDescription,
                warning: nil,
                isError: true)
        }
    }

    private func fetchInstalledSkills(route: GatewayNodeSessionRoute) async throws -> [SkillStatus] {
        let data = try await request(
            method: "skills.status",
            params: EmptySkillsRequest(),
            timeoutSeconds: 20,
            route: route)
        return try JSONDecoder().decode(SkillsStatusReport.self, from: data).skills.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private func request(
        method: String,
        params: some Encodable,
        timeoutSeconds: Int,
        route: GatewayNodeSessionRoute) async throws -> Data
    {
        let data = try JSONEncoder().encode(params)
        guard let json = String(data: data, encoding: .utf8) else { throw SkillsSettingsError.invalidPayload }
        let response = try await self.appModel.operatorSession.request(
            method: method,
            paramsJSON: json,
            timeoutSeconds: timeoutSeconds,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
        guard await self.appModel.operatorSession.currentRoute() == route else {
            throw SkillsSettingsError.gatewayChanged
        }
        return response
    }

    private func gatewayRoute() async throws -> GatewayNodeSessionRoute {
        let gatewayID = self.appModel.connectedGatewayID
        guard let route = await appModel.operatorSession.currentRoute(ifGatewayID: gatewayID),
              appModel.connectedGatewayID == gatewayID
        else {
            throw SkillsSettingsError.gatewayChanged
        }
        return route
    }

    private func resetGatewayState() {
        self.loadedGatewayID = nil
        self.installedSkills = []
        self.searchResults = []
        self.clawHubSupported = nil
        self.notice = nil
        self.reviewSheet = nil
        self.installedLoadID = nil
        self.searchID = nil
        self.reviewID = nil
        self.reviewingSlug = nil
        self.installID = nil
        self.installingSlug = nil
        self.mutationIDs = [:]
    }

    private static var screenshotSkills: [SkillStatus] {
        [
            SkillStatus(
                name: "github",
                description: "Review pull requests, issues, checks, and repository activity.",
                source: "managed",
                bundled: true,
                filePath: "/skills/github/SKILL.md",
                baseDir: "/skills/github",
                skillKey: "github",
                primaryEnv: nil,
                emoji: "🐙",
                homepage: "https://docs.openclaw.ai/tools/skills",
                always: false,
                disabled: false,
                eligible: true,
                requirements: SkillRequirements(bins: ["gh"], env: [], config: []),
                missing: SkillMissing(bins: [], env: [], config: []),
                configChecks: [],
                install: []),
            SkillStatus(
                name: "calendar",
                description: "Plan meetings and turn your schedule into focused daily briefs.",
                source: "managed",
                bundled: false,
                filePath: "/skills/calendar/SKILL.md",
                baseDir: "/skills/calendar",
                skillKey: "calendar",
                primaryEnv: nil,
                emoji: "📅",
                homepage: nil,
                always: false,
                disabled: false,
                eligible: true,
                requirements: SkillRequirements(bins: [], env: [], config: []),
                missing: SkillMissing(bins: [], env: [], config: []),
                configChecks: [],
                install: []),
            SkillStatus(
                name: "image-generation",
                description: "Create and edit images from a clear visual brief.",
                source: "managed",
                bundled: false,
                filePath: "/skills/image-generation/SKILL.md",
                baseDir: "/skills/image-generation",
                skillKey: "image-generation",
                primaryEnv: "OPENAI_API_KEY",
                emoji: "🎨",
                homepage: nil,
                always: false,
                disabled: false,
                eligible: false,
                requirements: SkillRequirements(bins: [], env: ["OPENAI_API_KEY"], config: []),
                missing: SkillMissing(bins: [], env: ["OPENAI_API_KEY"], config: []),
                configChecks: [],
                install: []),
        ]
    }

    static func isReady(_ skill: SkillStatus) -> Bool {
        SkillManagementContract.ready(skill)
    }

    static func needsSetup(_ skill: SkillStatus) -> Bool {
        SkillManagementContract.needsSetup(skill)
    }
}

private struct InstalledSkillRow: View {
    let skill: SkillStatus
    let canAdmin: Bool
    let isBusy: Bool
    let onToggle: (Bool) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(self.skill.emoji ?? "✨")
                .font(OpenClawType.title3)
                .frame(width: 32, height: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 7) {
                    Text(self.skill.name).font(OpenClawType.subheadSemiBold)
                    Text(verbatim: self.statusLabel)
                        .font(OpenClawType.caption2SemiBold)
                        .foregroundStyle(self.statusColor)
                }
                Text(self.skill.description)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if !self.missingSummary.isEmpty {
                    Text(verbatim: self.missingSummary)
                        .font(OpenClawType.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
                if let link = self.skill.clawhub, link.valid, let slug = link.slug {
                    Text(verbatim: [slug, link.installedVersion].compactMap(\.self).joined(separator: " · "))
                        .font(OpenClawType.monoSmall)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Button {
                self.onToggle(self.skill.disabled)
            } label: {
                Text(self.skill.disabled ? String(localized: "Enable") : String(localized: "Disable"))
                    .font(OpenClawType.captionSemiBold)
            }
            .buttonStyle(.bordered)
            .disabled(!self.canAdmin || self.isBusy)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private var statusLabel: String {
        if self.skill.disabled {
            return String(localized: "Off")
        }
        return SettingsSkillsDestination.isReady(self.skill)
            ? String(localized: "Ready")
            : String(localized: "Needs Setup")
    }

    private var statusColor: Color {
        if self.skill.disabled {
            return .secondary
        }
        return SettingsSkillsDestination.isReady(self.skill) ? OpenClawBrand.ok : OpenClawBrand.warn
    }

    private var missingSummary: String {
        let values = self.skill.missing.bins
            + self.skill.missing.anyBins.map { String(format: String(localized: "Any binary: %@"), $0) }
            + self.skill.missing.env
            + self.skill.missing.config
            + self.skill.missing.os.map { String(format: String(localized: "OS: %@"), $0) }
        return values.isEmpty ? "" : String(format: String(localized: "Missing: %@"), values.joined(separator: ", "))
    }
}

private struct ClawHubSkillRow: View {
    let skill: ClawHubSkillSummary
    let installed: Bool
    let isBusy: Bool
    let onReview: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: "shippingbox", color: self.installed ? OpenClawBrand.ok : OpenClawBrand.accent)
            VStack(alignment: .leading, spacing: 4) {
                Text(self.skill.displayName).font(OpenClawType.subheadSemiBold)
                Text(self.skill.summary ?? self.skill.slug)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Text(self.skill.slug).font(OpenClawType.monoSmall).foregroundStyle(.secondary)
                    if let version = self.skill.version {
                        Text(verbatim: version).font(OpenClawType.monoSmall).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 8)
            Button(action: self.onReview) {
                Text(self.installed ? String(localized: "Installed") : String(localized: "Install"))
                    .font(OpenClawType.captionSemiBold)
            }
            .buttonStyle(.bordered)
            .disabled(self.isBusy || self.installed)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }
}

private struct SkillsNotice: Equatable {
    let title: String
    let message: String
    let warning: String?
    let isError: Bool
}

private struct SkillsNoticeCard: View {
    let notice: SkillsNotice

    var body: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            HStack(alignment: .top, spacing: 12) {
                ProIconBadge(
                    systemName: self.notice.isError ? "exclamationmark.triangle" : "checkmark.circle",
                    color: self.notice.isError ? OpenClawBrand.warn : OpenClawBrand.ok)
                VStack(alignment: .leading, spacing: 4) {
                    Text(self.notice.title).font(OpenClawType.subheadSemiBold)
                    Text(self.notice.message).font(OpenClawType.caption).textSelection(.enabled)
                    if let warning = self.notice.warning {
                        Text(warning)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                Spacer()
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }
}

private struct SkillsInstallReviewSheet: View {
    let review: ClawHubSkillInstallReview
    let canInstall: Bool
    let isInstalling: Bool
    let onCancel: () -> Void
    let onInstall: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    SkillsReviewDetails(review: self.review)
                    Text("The Gateway will verify this exact release with ClawHub before download.")
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                    if !self.canInstall {
                        Text("This gateway connection needs operator.admin to install skills.")
                            .font(OpenClawType.caption)
                            .foregroundStyle(OpenClawBrand.warn)
                    }
                }
                .padding(20)
            }
            .navigationTitle("Review ClawHub skill")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: self.onCancel) { Text("Cancel").font(OpenClawType.subheadSemiBold) }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: self.onInstall) {
                        Text("Verify and install").font(OpenClawType.subheadSemiBold)
                    }
                    .disabled(!self.canInstall || self.isInstalling)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct SkillsRiskReviewSheet: View {
    let review: ClawHubSkillInstallReview
    let message: String
    let warning: String?
    let isInstalling: Bool
    let onCancel: () -> Void
    let onInstall: () -> Void
    @State private var warningExpanded = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Label {
                        Text("Gateway warning").font(OpenClawType.headline)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                    .foregroundStyle(OpenClawBrand.warn)
                    SkillsReviewDetails(review: self.review)
                    Text(self.message).font(OpenClawType.body)
                    DisclosureGroup(isExpanded: self.$warningExpanded) {
                        Text(self
                            .warning ??
                            String(localized: "The Gateway requires explicit acknowledgement for this release."))
                            .font(OpenClawType.caption)
                            .textSelection(.enabled)
                            .padding(.top, 8)
                    } label: {
                        Text("Review warning details").font(OpenClawType.subheadSemiBold)
                    }
                    Text("Expand and review the Gateway warning before acknowledging this exact version.")
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(20)
            }
            .navigationTitle("Review Gateway warning")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: self.onCancel) { Text("Cancel").font(OpenClawType.subheadSemiBold) }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: self.onInstall) {
                        Text("Acknowledge and install").font(OpenClawType.subheadSemiBold)
                    }
                    .disabled(!self.warningExpanded || self.isInstalling)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct SkillsReviewDetails: View {
    let review: ClawHubSkillInstallReview

    var body: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 8) {
                Text(self.review.displayName).font(OpenClawType.headline)
                if let summary = self.review.summary {
                    Text(summary).font(OpenClawType.body).foregroundStyle(.secondary)
                }
                SkillsReviewLine(label: "Version", value: self.review.version)
                SkillsReviewLine(label: "Publisher", value: self.review.author)
            }
        }
    }
}

private struct SkillsReviewLine: View {
    let label: LocalizedStringKey
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(self.label).font(OpenClawType.captionSemiBold).foregroundStyle(.secondary)
            Text(self.value).font(OpenClawType.body)
        }
    }
}

private struct EmptySkillsRequest: Encodable {}

private struct ClawHubSearchRequest: Encodable {
    let query: String?
    let limit: Int
}

private struct ClawHubDetailRequest: Encodable { let slug: String }

private struct ClawHubInstallRequest: Encodable {
    let source: String
    let slug: String
    let version: String
    let acknowledgeClawHubRisk: Bool?
    let timeoutMs: Int
}

private struct SkillEnabledRequest: Encodable {
    let skillKey: String
    let enabled: Bool
}

private enum SkillsSettingsError: LocalizedError {
    case gatewayChanged
    case invalidPayload
    case missingInstallVersion

    var errorDescription: String? {
        switch self {
        case .gatewayChanged: String(localized: "The connected Gateway changed. Refresh Skills and try again.")
        case .invalidPayload: String(localized: "Could not encode the Gateway request.")
        case .missingInstallVersion: String(localized: "ClawHub did not report an installable version for this skill.")
        }
    }
}

extension String {
    fileprivate var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
