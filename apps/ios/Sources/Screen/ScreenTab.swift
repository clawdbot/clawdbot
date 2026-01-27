import MoltbotKit
import SwiftUI

struct ScreenTab: View {
    @Environment(NodeAppModel.self) private var appModel

    var body: some View {
        ZStack(alignment: .top) {
            ScreenWebView(controller: self.appModel.screen)
                .ignoresSafeArea()
                .overlay(alignment: .top) {
                    if let errorText = self.appModel.screen.errorText {
                        Text(errorText)
                            .font(.footnote)
                            .padding(10)
                            .background(.thinMaterial)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .padding()
                    }
                }
        }
    }

    // Navigation is agent-driven; no local URL bar here.
}
