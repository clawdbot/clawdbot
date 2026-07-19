import SwiftUI
import UIKit

enum UnifiedChatVoiceTabIcon {
    enum State: Hashable {
        case inactive
        case active
        case listening
        case speaking

        var isVoiceActive: Bool {
            self != .inactive
        }
    }

    struct CacheKey: Hashable {
        let state: State
        let colorScheme: ColorScheme
    }

    private static let canvasSize = CGSize(width: 30, height: 30)
    @MainActor private static var imageCache: [CacheKey: UIImage] = [:]

    @MainActor
    static func image(state: State, colorScheme: ColorScheme) -> Image {
        // Voice-active icons render the adaptive brand color into bitmap pixels;
        // appearance must therefore participate in cache identity.
        let cacheKey = CacheKey(state: state, colorScheme: colorScheme)
        let rendered = self.imageCache[cacheKey] ?? {
            let image = self.renderedImage(state: state, colorScheme: colorScheme)
            self.imageCache[cacheKey] = image
            return image
        }()
        return Image(uiImage: rendered)
            .renderingMode(state.isVoiceActive ? .original : .template)
    }

    @MainActor
    private static func renderedImage(state: State, colorScheme: ColorScheme) -> UIImage {
        let userInterfaceStyle: UIUserInterfaceStyle = colorScheme == .dark ? .dark : .light
        let traits = UITraitCollection(userInterfaceStyle: userInterfaceStyle)
        let format = UIGraphicsImageRendererFormat(for: traits)
        format.opaque = false
        format.scale = UIScreen.main.scale
        let renderer = UIGraphicsImageRenderer(size: self.canvasSize, format: format)
        let rendered = renderer.image { context in
            let symbolConfig = UIImage.SymbolConfiguration(pointSize: 25, weight: .regular)
            guard let bubble = UIImage(systemName: "bubble.left.fill", withConfiguration: symbolConfig) else {
                return
            }
            let fill = state.isVoiceActive
                ? UIColor(OpenClawBrand.accent).resolvedColor(with: traits)
                : UIColor.black
            let tintedBubble = bubble.withTintColor(fill, renderingMode: .alwaysOriginal)
            let bubbleRect = CGRect(
                x: (self.canvasSize.width - tintedBubble.size.width) / 2,
                y: (self.canvasSize.height - tintedBubble.size.height) / 2,
                width: tintedBubble.size.width,
                height: tintedBubble.size.height)
            tintedBubble.draw(in: bubbleRect)

            // Cut one waveform out of the bubble so the tab keeps a single,
            // legible template silhouette at native tab-bar sizes.
            context.cgContext.setBlendMode(.clear)
            let heights: [CGFloat] = switch state {
            case .inactive: [6, 11, 7]
            case .active: [7, 12, 8]
            case .listening: [9, 15, 10]
            case .speaking: [13, 8, 14]
            }
            for index in heights.indices {
                let height = heights[index]
                let rect = CGRect(
                    x: 10.1 + CGFloat(index) * 4.1,
                    y: 13.4 - height / 2,
                    width: 2.35,
                    height: height)
                UIBezierPath(roundedRect: rect, cornerRadius: 1.2).fill()
            }
        }
        return rendered.withRenderingMode(state.isVoiceActive ? .alwaysOriginal : .alwaysTemplate)
    }
}

/// Phone tabs push Settings routes (gateway, voice) onto their own stack so
/// Back returns to the tab content the user navigated from; only global flows
/// (deep links, onboarding, problem banner) jump to the canonical Settings tab.
struct PhoneTabSettingsHost<Content: View>: View {
    @State private var settingsPath: [SettingsRoute] = []
    private let resetRequestID: Int
    private let content: (_ openSettingsRoute: @escaping (SettingsRoute) -> Void) -> Content

    init(
        resetRequestID: Int = 0,
        @ViewBuilder content: @escaping (_ openSettingsRoute: @escaping (SettingsRoute) -> Void) -> Content)
    {
        self.resetRequestID = resetRequestID
        self.content = content
    }

    var body: some View {
        NavigationStack(path: self.$settingsPath) {
            self.content { route in
                self.settingsPath.append(route)
            }
            .navigationDestination(for: SettingsRoute.self) { route in
                SettingsProTab(directRoute: route)
            }
        }
        .onChange(of: self.resetRequestID) { _, _ in
            self.settingsPath.removeAll()
        }
    }
}
