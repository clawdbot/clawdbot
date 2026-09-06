import SwiftUI

/// Taste-only chat motion. Hosts opt in; macOS window and Quick Chat stay off.
/// `composerChrome == .clean` is not an iOS gate — clean chrome exists on Mac too.
enum ChatTasteRowInsertion: Equatable, Sendable {
    case none
    case opacity
    case scaleAndOpacity
}

func chatTasteRowInsertion(
    tasteMotionEnabled: Bool,
    composerChromeIsClean: Bool,
    reduceMotion: Bool,
    transcriptHasSettled: Bool) -> ChatTasteRowInsertion
{
    guard tasteMotionEnabled, composerChromeIsClean, transcriptHasSettled else {
        return .none
    }
    return reduceMotion ? .opacity : .scaleAndOpacity
}

func chatTasteWorkingAppear(
    tasteMotionEnabled: Bool,
    reduceMotion: Bool) -> ChatTasteRowInsertion
{
    guard tasteMotionEnabled else { return .none }
    return reduceMotion ? .opacity : .scaleAndOpacity
}

func chatTasteAllowsSymbolReplace(tasteMotionEnabled: Bool, reduceMotion: Bool) -> Bool {
    tasteMotionEnabled && !reduceMotion
}

func chatTasteAllowsHeightAnimation(tasteMotionEnabled: Bool, reduceMotion: Bool) -> Bool {
    tasteMotionEnabled && !reduceMotion
}

func chatTasteRowAnimation(
    _ insertion: ChatTasteRowInsertion) -> Animation?
{
    switch insertion {
    case .none:
        nil
    case .opacity, .scaleAndOpacity:
        .easeOut(duration: 0.16)
    }
}

struct ChatTasteInsertModifier: ViewModifier {
    let style: ChatTasteRowInsertion

    func body(content: Content) -> some View {
        switch self.style {
        case .none:
            content
        case .opacity:
            content.transition(.opacity)
        case .scaleAndOpacity:
            content.transition(
                .asymmetric(
                    insertion: .scale(scale: 0.98).combined(with: .opacity),
                    removal: .opacity))
        }
    }
}

struct ChatTasteSymbolReplaceModifier: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        #if os(iOS)
        if self.enabled {
            content.contentTransition(.symbolEffect(.replace))
        } else {
            content
        }
        #else
        content
        #endif
    }
}
