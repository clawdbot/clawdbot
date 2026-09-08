import Foundation
import SwiftUI

extension AppState {
    enum GatewayConfigField: String, CaseIterable {
        case mode = "gateway.mode"
        case remoteTransport = "gateway.remote.transport"
        case remoteUrl = "gateway.remote.url"
        case remoteTarget = "gateway.remote.sshTarget"
        case remoteIdentity = "gateway.remote.sshIdentity"
        case remoteHostKeyPolicy = "gateway.remote.sshHostKeyPolicy"
        case remoteToken = "gateway.remote.token"

        var remoteKey: String? {
            switch self {
            case .mode:
                nil
            case .remoteTransport:
                "transport"
            case .remoteUrl:
                "url"
            case .remoteTarget:
                "sshTarget"
            case .remoteIdentity:
                "sshIdentity"
            case .remoteHostKeyPolicy:
                "sshHostKeyPolicy"
            case .remoteToken:
                "token"
            }
        }

        var displayName: String {
            switch self {
            case .mode:
                String(localized: "Gateway location")
            case .remoteTransport:
                String(localized: "Transport")
            case .remoteUrl:
                String(localized: "Gateway URL")
            case .remoteTarget:
                String(localized: "SSH target")
            case .remoteIdentity:
                String(localized: "Identity file")
            case .remoteHostKeyPolicy:
                String(localized: "SSH host key policy")
            case .remoteToken:
                String(localized: "Gateway token")
            }
        }
    }

    struct GatewayConfigConflict: Equatable {
        let fields: [GatewayConfigField]
        let fieldNames: [String]
        let message: String
    }

    enum GatewayConfigValue: Equatable {
        case missing
        case json(Data)
    }

    struct GatewayConfigSnapshot {
        static let empty = GatewayConfigSnapshot(values: [:])
        let values: [GatewayConfigField: GatewayConfigValue]

        subscript(field: GatewayConfigField) -> GatewayConfigValue {
            self.values[field] ?? .missing
        }
    }

    struct RemoteGatewayConfigDraft {
        var transport: RemoteTransport
        var remoteUrl: String
        var remoteHost: String?
        var remoteTarget: String
        var remoteIdentity: String
        var remoteToken: String
        var dirtyFields: Set<GatewayConfigField>
    }

    struct GatewayConfigSyncDraft {
        var connectionMode: ConnectionMode
        var remoteTransport: RemoteTransport
        var remoteTarget: String
        var remoteIdentity: String
        var remoteUrl: String
        var remoteToken: String
        var dirtyFields: Set<GatewayConfigField>

        var clearsPrimaryGateway: Bool {
            self.connectionMode == .unconfigured && self.dirtyFields.contains(.mode)
        }
    }

    struct GatewaySelectionSnapshot: Equatable {
        let connectionMode: ConnectionMode
        let remoteTransport: RemoteTransport
        let remoteUrl: String
        let remoteTarget: String
    }
}

struct GatewayConfigConflictRecoveryView: View {
    @Bindable var state: AppState

    var body: some View {
        let conflict = self.state.gatewayConfigConflict
        if let message = conflict?.message ?? state.gatewayConfigSyncFailure {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: message)
                        .fixedSize(horizontal: false, vertical: true)

                    if conflict != nil {
                        HStack(spacing: 8) {
                            Button("Use file version") {
                                self.state.useFileGatewayConfigConflict()
                            }
                            .buttonStyle(.bordered)

                            Button("Keep my edits") {
                                self.state.keepGatewayConfigEdits()
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        .controlSize(.small)
                    }
                }
            }
        }
    }
}
