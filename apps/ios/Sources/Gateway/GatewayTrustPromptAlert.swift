import SwiftUI

struct GatewayTrustPromptAlert: ViewModifier {
    @Environment(GatewayConnectionController.self) private var gatewayController: GatewayConnectionController
    let isEnabled: Bool

    func body(content: Content) -> some View {
        content.alert(
            "Trust this gateway?",
            isPresented: Binding(
                get: { self.isEnabled && self.gatewayController.pendingTrustPrompt != nil },
                set: { _ in
                    // Keep pending trust state until explicit user action.
                    // SwiftUI may set presentation bindings during dismissal; clearing here can
                    // race with the trust button and make accept no-op.
                }),
            presenting: self.gatewayController.pendingTrustPrompt)
        { _ in
            Button(role: .cancel) {
                self.gatewayController.declinePendingTrustPrompt()
            } label: {
                Text("Cancel")
                    .font(OpenClawType.subheadSemiBold)
            }
            Button {
                Task { await self.gatewayController.acceptPendingTrustPrompt() }
            } label: {
                Text("Trust and connect")
                    .font(OpenClawType.subheadSemiBold)
            }
        } message: { prompt in
            Text(String(
                format: NSLocalizedString(
                    "First-time TLS connection.\n\nVerify this SHA-256 fingerprint out-of-band before trusting:\n%@",
                    comment: "Gateway certificate trust instructions"),
                prompt.fingerprintSha256))
                .font(OpenClawType.subhead)
        }
    }
}

extension View {
    func gatewayTrustPromptAlert(isEnabled: Bool = true) -> some View {
        self.modifier(GatewayTrustPromptAlert(isEnabled: isEnabled))
    }
}
