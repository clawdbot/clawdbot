import AppKit
import QuartzCore
import SwiftUI

struct CritterMotionTarget {
    var value: CGFloat = 0
    var curve: CritterMotionCurve?
}

enum CritterMotionCurve {
    case wiggle, scurryOut, scurryBack

    static let scurryOutDuration = 0.12
    static let scurryBackDuration = 0.16

    func animation(keyPath: String) -> CABasicAnimation {
        if self == .wiggle {
            let spring = CASpringAnimation(keyPath: keyPath)
            spring.mass = 1
            spring.stiffness = 220
            spring.damping = 18
            spring.duration = spring.settlingDuration
            spring.timingFunction = CAMediaTimingFunction(name: .linear)
            return spring
        }
        let animation = CABasicAnimation(keyPath: keyPath)
        animation.duration = self == .scurryOut ? Self.scurryOutDuration : Self.scurryBackDuration
        animation.timingFunction = CAMediaTimingFunction(name: self == .scurryOut ? .easeInEaseOut : .easeOut)
        return animation
    }
}

struct CritterStatusImage: NSViewRepresentable {
    var image: NSImage
    var rotation: CritterMotionTarget
    var translation: CritterMotionTarget
    var motionEnabled: Bool

    func makeNSView(context: Context) -> CritterMotionView {
        CritterMotionView()
    }

    func updateNSView(_ view: CritterMotionView, context: Context) {
        view.imageView.image = self.image
        view.updateMotion(rotation: self.rotation, translation: self.translation, enabled: self.motionEnabled)
    }

    static func dismantleNSView(_ view: CritterMotionView, coordinator: ()) {
        view.updateMotion(rotation: .init(), translation: .init(), enabled: false)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: CritterMotionView, context: Context) -> CGSize? {
        CGSize(width: 18, height: 18)
    }
}

@MainActor
final class CritterMotionView: NSView {
    let imageView = NSImageView(frame: NSRect(x: -9, y: -9, width: 18, height: 18))
    private let rotationView = NSView(frame: NSRect(x: 9, y: 9, width: 0, height: 0))
    private static let animationPrefix = "openclaw.critter.motion."
    private var animationSequence: UInt64 = 0
    private var targetAngle: CGFloat = 0
    private var targetOffset: CGFloat = 0

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 18, height: 18))
        self.wantsLayer = true
        self.rotationView.wantsLayer = true
        self.imageView.wantsLayer = true
        // AppKit owns layer anchors. A zero-size, non-clipping parent fixes the pivot at the image center.
        self.rotationView.clipsToBounds = false
        self.imageView.imageScaling = .scaleNone
        self.addSubview(self.rotationView)
        self.rotationView.addSubview(self.imageView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func updateMotion(rotation: CritterMotionTarget, translation: CritterMotionTarget, enabled: Bool) {
        guard let translationLayer = self.layer, let rotationLayer = self.rotationView.layer else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        // Only child transforms move. AppKit retains its frames, anchors, template tint, and backing scale.
        // The centered pivot stays independent while scurry retargets translation.
        self.targetAngle = self.update(
            layer: rotationLayer,
            keyPath: "sublayerTransform.rotation.z",
            from: self.targetAngle,
            to: enabled ? -rotation.value * .pi / 180 : 0,
            curve: enabled ? rotation.curve : nil)
        self.targetOffset = self.update(
            layer: translationLayer,
            keyPath: "sublayerTransform.translation.x",
            from: self.targetOffset,
            to: enabled ? translation.value : 0,
            curve: enabled ? translation.curve : nil)
    }

    private func update(
        layer: CALayer,
        keyPath: String,
        from previous: CGFloat,
        to value: CGFloat,
        curve: CritterMotionCurve?) -> CGFloat
    {
        // A reset also retires a return animation whose model target is already zero.
        guard let curve else {
            for key in layer.animationKeys() ?? [] where key.hasPrefix(Self.animationPrefix) {
                layer.removeAnimation(forKey: key)
            }
            layer.setValue(value, forKeyPath: keyPath)
            return value
        }
        guard previous != value else { return previous }

        let animation = curve.animation(keyPath: keyPath)
        // Both interpolating springs and interrupted timing curves compose additively in SwiftUI.
        // Retain old tails and compensate from the old model target, not the presentation value.
        animation.fromValue = previous - value
        animation.toValue = 0
        animation.isAdditive = true
        layer.setValue(value, forKeyPath: keyPath)
        self.animationSequence &+= 1
        layer.add(animation, forKey: Self.animationPrefix + String(self.animationSequence))
        return value
    }
}
