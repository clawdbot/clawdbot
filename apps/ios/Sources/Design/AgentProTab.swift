import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct AgentProTab: View {
    @Environment(NodeAppModel.self) var appModel
    @Environment(\.colorScheme) var colorScheme
    @Environment(\.scenePhase) var scenePhase
    @State var overview: AgentOverviewSnapshot?
    @State var overviewErrorText: String?
    @State var overviewLoading: Bool = false
    @State var overviewRefreshNonce: Int = 0
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
        case skills
        case nodes
        case cron
        case usage
        case dreaming
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
            case .all: "All"
            case .enabled: "Enabled"
            case .off: "Off"
            case .setup: "Setup"
            case .blocked: "Blocked"
            }
        }
    }

    enum AgentRosterFilter: String, CaseIterable, Identifiable {
        case all
        case online
        case busy
        case idle

        var id: Self {
            self
        }

        var title: String {
            switch self {
            case .all: "All"
            case .online: "Online"
            case .busy: "Busy"
            case .idle: "Idle"
            }
        }
    }

    enum AgentLayout {
        static let cardRadius: CGFloat = 12
        static let filterHeight: CGFloat = 34
        static let rowMinHeight: CGFloat = 104
        static let metricTileHeight: CGFloat = 94
        static let actionButtonSize: CGFloat = 34
    }

    enum AgentRosterState: Equatable {
        case online
        case busy
        case idle

        var title: String {
            switch self {
            case .online: "Online"
            case .busy: "Busy"
            case .idle: "Idle"
            }
        }

        var color: Color {
            switch self {
            case .online: OpenClawBrand.ok
            case .busy: OpenClawBrand.warn
            case .idle: Color(red: 0 / 255.0, green: 122 / 255.0, blue: 255 / 255.0)
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

    var body: some View {
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
                .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
            .navigationBarHidden(true)
            .navigationDestination(for: AgentRoute.self) { route in
                self.destination(for: route)
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
}
