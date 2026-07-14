import OpenClawKit
import SwiftUI

struct AgentProTab: View {
    @Environment(NodeAppModel.self) var appModel
    @Environment(\.scenePhase) var scenePhase
    let directRoute: AgentRoute?
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let headerTitle: String
    let openSettings: (() -> Void)?
    @State var overview: AgentOverviewSnapshot?
    @State var overviewErrorText: String?
    @State var overviewLoading: Bool = false
    @State var overviewRefreshGate = AgentOverviewRefreshGate()
    @State var agentRosterFilter: AgentRosterFilter = .all
    @State var agentSearchPresented = false
    @State var agentSearchText = ""
    @State var skillFilter: String = ""
    @State var skillStatusFilter: SkillStatusFilter = .all
    @State var skillMutationBusyKeys: Set<String> = []
    @State var skillMutationErrorText: String?
    @State var skillMutationStatusText: String?
    @State var skillConfigBusyKeys: Set<String> = []
    @State var skillConfigMessages: [String: SkillEditorMessage] = [:]
    @State var skillAPIKeyDrafts: [String: String] = [:]
    @State var skillEditorSelection: SkillEditorSelection?
    @State var clawHubQuery: String = ""
    @State var clawHubResults: [ClawHubSearchResultLite] = []
    @State var clawHubLoading: Bool = false
    @State var clawHubErrorText: String?
    @State var clawHubInstallSlug: String?
    @State var cronActionBusyIDs: Set<String> = []
    @State var cronActionStatusText: String?

    enum AgentRoute: Hashable {
        case agents
        case skills
        case instances
        case cron
        case usage
        case dreaming
        case files
    }

    enum SkillStatusFilter: String, CaseIterable, Identifiable {
        case all
        case enabled
        case off
        case setup
        case blocked

        var id: Self {
            self
        }

        var title: String {
            switch self {
            case .all: String(localized: "All")
            case .enabled: String(localized: "Enabled")
            case .off: String(localized: "Off")
            case .setup: String(localized: "Setup")
            case .blocked: String(localized: "Blocked")
            }
        }
    }

    enum AgentRosterFilter: String, CaseIterable, Identifiable {
        case all
        case online
        case ready

        var id: Self {
            self
        }

        var title: String {
            switch self {
            case .all: String(localized: "All")
            case .online: String(localized: "Online")
            case .ready: String(localized: "Ready")
            }
        }

        var systemImage: String {
            switch self {
            case .all: "person.2"
            case .online: "antenna.radiowaves.left.and.right"
            case .ready: "checkmark.circle"
            }
        }
    }

    enum AgentLayout {
        static let cardRadius: CGFloat = OpenClawProMetric.cardRadius
        static let filterHeight: CGFloat = 34
        static let metricTileHeight: CGFloat = 94
    }

    enum AgentRosterState: Equatable {
        case online
        case ready

        var color: Color {
            switch self {
            case .online: OpenClawBrand.ok
            case .ready: OpenClawBrand.info
            }
        }
    }

    struct SkillEditorSelection: Identifiable {
        let id: String
    }

    struct SkillEditorMessage {
        let kind: Kind
        let text: String

        enum Kind {
            case success
            case error
        }
    }

    init(
        directRoute: AgentRoute? = nil,
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        headerTitle: String = "Agents",
        openSettings: (() -> Void)? = nil)
    {
        self.directRoute = directRoute
        self.headerLeadingAction = headerLeadingAction
        self.headerTitle = headerTitle
        self.openSettings = openSettings
    }

    var body: some View {
        Group {
            if let directRoute {
                self.directDestination(for: directRoute)
            } else {
                self.overviewNavigation
            }
        }
        .task(id: self.overviewTaskID) {
            await self.refreshOverview(force: false)
        }
        .sheet(item: self.$skillEditorSelection) { selection in
            if let skill = self.skillByKey(selection.id) {
                self.skillEditorSheet(skill)
            } else {
                self.missingSkillEditorSheet
            }
        }
    }

    private var overviewNavigation: some View {
        NavigationStack {
            ZStack {
                OpenClawProBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        self.rosterHeader
                        self.agentFilters
                        self.agentsSection
                        self.operationsSection
                        self.dreamingSection
                        self.cronSection
                    }
                    .padding(.vertical, 18)
                }
                .refreshable {
                    await self.refreshOverview(force: true)
                }
            }
            .navigationBarHidden(true)
            .navigationDestination(for: AgentRoute.self) { route in
                self.destination(for: route)
            }
        }
    }

    private func directDestination(for route: AgentRoute) -> some View {
        self.destination(for: route)
            .toolbar(
                route != .agents && self.directHeaderLeadingAction(for: route) != nil ? .hidden : .visible,
                for: .navigationBar)
    }
}
