import OpenClawKit
import SwiftUI

struct AgentProTab: View {
    @Environment(NodeAppModel.self) var appModel
    @Environment(\.scenePhase) var scenePhase
    let directRoute: AgentRoute
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let headerTitle: String
    let openSettings: (() -> Void)?
    @State var agentRosterFilter: AgentRosterFilter = .all
    @State var agentSearchText = ""

    enum AgentRoute: Hashable {
        case agents
        case files
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

    init(
        directRoute: AgentRoute,
        headerSidebarAction: OpenClawSidebarHeaderAction? = nil,
        headerTitle: String = "Agents",
        openSettings: (() -> Void)? = nil)
    {
        self.directRoute = directRoute
        self.headerSidebarAction = headerSidebarAction
        self.headerTitle = headerTitle
        self.openSettings = openSettings
    }

    var body: some View {
        self.directDestination(for: self.directRoute)
            .task(id: self.rosterTaskID) {
                await self.refreshAgents()
            }
    }

    private func directDestination(for route: AgentRoute) -> some View {
        self.destination(for: route)
            .toolbar(
                route != .agents && self.directHeaderSidebarAction(for: route) != nil ? .hidden : .visible,
                for: .navigationBar)
    }
}
