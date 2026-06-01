import SwiftUI

struct TalkPermissionPromptView: View {
    enum Style {
        case card
        case settings
        case sheet
    }

    @Environment(NodeAppModel.self) private var appModel

    let style: Style
    var onPermissionReady: (() -> Void)?

    private var state: TalkGatewayPermissionState {
        self.appModel.talkMode.gatewayTalkPermissionState
    }

    private var requestIsPending: Bool {
        self.state.isApprovalRequestInProgress
    }

    private var pollTaskKey: String {
        switch self.state {
        case .requestingUpgrade:
            "requesting"
        case let .upgradeRequested(requestId):
            "pending:\(requestId ?? "")"
        default:
            "idle:\(self.state.statusLabel)"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: self.style == .sheet ? 16 : 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: self.iconSystemName)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(self.requestIsPending ? Color.orange : Color.accentColor)
                    .frame(width: 28, height: 28)

                VStack(alignment: .leading, spacing: 6) {
                    Text(self.titleText)
                        .font(self.style == .sheet ? .title3.weight(.semibold) : .headline)
                    Text(self.messageText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let failureMessage = self.state.failureMessage {
                Label(failureMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let requestId = self.state.requestId {
                LabeledContent("Request ID") {
                    Text(requestId)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            HStack(spacing: 10) {
                Button {
                    self.appModel.requestTalkPermissionUpgrade()
                } label: {
                    if case .requestingUpgrade = self.state {
                        Label {
                            Text("Sending...")
                        } icon: {
                            ProgressView()
                        }
                    } else {
                        Label(self.primaryButtonTitle, systemImage: self.primaryButtonSystemImage)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.state == .requestingUpgrade)

                Button {
                    Task { await self.appModel.talkMode.reloadConfig() }
                } label: {
                    Label("Retry", systemImage: "arrow.triangle.2.circlepath")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(self.style == .card || self.style == .sheet ? 16 : 0)
        .background {
            if self.style == .card || self.style == .sheet {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(.thinMaterial)
            }
        }
        .overlay {
            if self.style == .card || self.style == .sheet {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.accentColor.opacity(0.20), lineWidth: 1)
            }
        }
        .task(id: self.pollTaskKey) {
            guard self.requestIsPending else { return }
            await self.pollUntilReady()
        }
        .onChange(of: self.state) { _, newState in
            if newState == .ready {
                self.onPermissionReady?()
            }
        }
    }

    private var iconSystemName: String {
        switch self.state {
        case .requestingUpgrade:
            "paperplane.fill"
        case .upgradeRequested:
            "hourglass"
        case .requestFailed:
            "exclamationmark.triangle.fill"
        default:
            "key.fill"
        }
    }

    private var titleText: String {
        switch self.state {
        case .requestingUpgrade:
            "Sending approval request"
        case .upgradeRequested:
            "Approval sent"
        case .requestFailed:
            "Could not request approval"
        default:
            "Enable Talk"
        }
    }

    private var messageText: String {
        switch self.state {
        case .requestingUpgrade:
            "Sending a new pairing request to your gateway..."
        case .upgradeRequested:
            "Approve this request on your gateway. Talk will start automatically when approval lands."
        default:
            "This device needs gateway approval before Talk can use realtime voice. Audio will go directly from " +
                "this device to the voice provider."
        }
    }

    private var primaryButtonTitle: String {
        self.requestIsPending ? "Request Again" : "Send Approval Request"
    }

    private var primaryButtonSystemImage: String {
        self.requestIsPending ? "arrow.clockwise" : "paperplane.fill"
    }

    private func pollUntilReady() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if Task.isCancelled { return }
            await self.appModel.pollTalkPermissionUpgrade()
            if !self.appModel.talkMode.gatewayTalkPermissionState.requiresTalkPermissionAction {
                return
            }
        }
    }
}
