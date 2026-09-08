import AppKit
import QuartzCore
import Testing
@testable import OpenClaw

@MainActor
struct CritterIconRendererTests {
    @Test func `make icon renders expected size`() {
        let image = CritterIconRenderer.makeIcon(
            blink: 0.25,
            legWiggle: 0.5,
            earWiggle: 0.2,
            earScale: 1,
            badge: nil)

        #expect(image.size.width == 18)
        #expect(image.size.height == 18)
        #expect(image.tiffRepresentation != nil)
    }

    @Test func `make icon renders with badge`() {
        let image = CritterIconRenderer.makeIcon(
            blink: 0,
            legWiggle: 0,
            earWiggle: 0,
            earScale: 1,
            badge: .init(symbolName: "terminal.fill", prominence: .primary))

        #expect(image.tiffRepresentation != nil)
    }

    @Test func `make icon renders expressive states`() {
        let sleeping = CritterIconRenderer.makeIcon(
            blink: 1,
            antennaDroop: 1,
            eyesClosedLines: true)
        let celebrating = CritterIconRenderer.makeIcon(blink: 0, happyEyes: true)

        #expect(sleeping.tiffRepresentation != nil)
        #expect(celebrating.tiffRepresentation != nil)
    }

    @Test func `icon motion keeps native frames fixed around the image center`() throws {
        let view = CritterMotionView()
        let rotation = try #require(view.imageView.superview)
        let rotationLayer = try #require(rotation.layer)
        let translationLayer = try #require(view.layer)
        let imageFrame = view.imageView.frame
        let rotationFrame = rotation.frame
        let imageCenter = NSPoint(x: view.imageView.bounds.midX, y: view.imageView.bounds.midY)
        let pivot = view.imageView.convert(imageCenter, to: rotation)
        #expect(pivot == .zero)
        #expect(rotationLayer.bounds.size == .zero)

        for (angle, offset) in [(CGFloat(4), CGFloat(0.5)), (-3, -0.4)] {
            view.updateMotion(rotation: .init(value: angle), translation: .init(value: offset), enabled: true)
            #expect(view.frame == NSRect(x: 0, y: 0, width: 18, height: 18))
            #expect(view.imageView.frame == imageFrame)
            #expect(rotation.frame == rotationFrame)
            // Detached AppKit backing layers are unlinked; combine their model transforms in view coordinates.
            let rotated = pivot.applying(CATransform3DGetAffineTransform(rotationLayer.sublayerTransform))
            let center = rotation.convert(rotated, to: view)
                .applying(CATransform3DGetAffineTransform(translationLayer.sublayerTransform))
            #expect(abs(center.x - (9 + offset)) < 0.001)
            #expect(abs(center.y - 9) < 0.001)
        }
    }

    @Test func `icon motion retargets independent channels from their model targets`() throws {
        let view = CritterMotionView()
        let translation = SampledPresentationLayer()
        translation.sampledPresentation = SampledPresentationLayer()
        // Sampling a presentation with an active tail would count that tail twice when retargeting.
        translation.sampledPresentation?.setValue(8, forKeyPath: "sublayerTransform.translation.x")
        view.layer = translation
        let rotation = try #require(view.imageView.superview?.layer)

        view.updateMotion(
            rotation: .init(value: 4, curve: .wiggle), translation: .init(value: 0.5, curve: .wiggle), enabled: true)
        let rotationKeys = Set(rotation.animationKeys() ?? [])
        let translationKeys = Set(translation.animationKeys() ?? [])
        #expect(rotationKeys.count == 1)
        #expect(translationKeys.count == 1)

        view.updateMotion(
            rotation: .init(value: 4, curve: .wiggle), translation: .init(value: 0.5, curve: .scurryOut), enabled: true)
        #expect(Set(rotation.animationKeys() ?? []) == rotationKeys)
        #expect(Set(translation.animationKeys() ?? []) == translationKeys)

        view.updateMotion(
            rotation: .init(value: 4, curve: .wiggle),
            translation: .init(value: -0.4, curve: .scurryOut),
            enabled: true)
        let retargetedTranslationKeys = Set(translation.animationKeys() ?? [])
        #expect(Set(rotation.animationKeys() ?? []) == rotationKeys)
        #expect(retargetedTranslationKeys.isSuperset(of: translationKeys))
        #expect(retargetedTranslationKeys.count == translationKeys.count + 1)
        let translationKey = try #require(retargetedTranslationKeys.subtracting(translationKeys).first)
        let translationAnimation = try #require(translation.animation(forKey: translationKey) as? CABasicAnimation)
        let translationResidual = try #require(translationAnimation.fromValue as? CGFloat)
        #expect(abs(translationResidual - 0.9) < 0.001)
        #expect(translationAnimation.toValue as? CGFloat == 0)
        #expect(translationAnimation.isAdditive)
        #expect(translation.value(forKeyPath: "sublayerTransform.translation.x") as? CGFloat == -0.4)

        view.updateMotion(
            rotation: .init(value: -3, curve: .wiggle),
            translation: .init(value: -0.4, curve: .scurryBack),
            enabled: true)
        let retargetedRotationKeys = Set(rotation.animationKeys() ?? [])
        #expect(Set(translation.animationKeys() ?? []) == retargetedTranslationKeys)
        #expect(retargetedRotationKeys.isSuperset(of: rotationKeys))
        #expect(retargetedRotationKeys.count == rotationKeys.count + 1)
        let rotationKey = try #require(retargetedRotationKeys.subtracting(rotationKeys).first)
        let rotationAnimation = try #require(rotation.animation(forKey: rotationKey) as? CABasicAnimation)
        let rotationResidual = try #require(rotationAnimation.fromValue as? CGFloat)
        #expect(abs(rotationResidual + 7 * .pi / 180) < 0.001)
        #expect(rotationAnimation.toValue as? CGFloat == 0)
        #expect(rotationAnimation.isAdditive)
    }

    @Test(arguments: [false, true])
    func `icon motion reset retires only owned animations even at a zero target`(disabled: Bool) throws {
        let view = CritterMotionView()
        let layers = try [#require(view.layer), #require(view.imageView.superview?.layer)]
        view.updateMotion(
            rotation: .init(value: 4, curve: .wiggle), translation: .init(value: 0.5, curve: .scurryOut), enabled: true)
        view.updateMotion(
            rotation: .init(value: 0, curve: .wiggle), translation: .init(value: 0, curve: .scurryBack), enabled: true)
        for layer in layers {
            #expect(layer.animationKeys()?.count == 2)
            let foreign = CABasicAnimation(keyPath: "opacity")
            foreign.duration = 10
            layer.add(foreign, forKey: "foreign.animation")
        }

        let reset = disabled ? CritterMotionTarget(value: 9, curve: .wiggle) : .init()
        view.updateMotion(rotation: reset, translation: reset, enabled: !disabled)
        for layer in layers {
            #expect(layer.animationKeys() == ["foreign.animation"])
        }
        #expect(layers[0].value(forKeyPath: "sublayerTransform.translation.x") as? CGFloat == 0)
        #expect(layers[1].value(forKeyPath: "sublayerTransform.rotation.z") as? CGFloat == 0)
    }

    @Test func `idle critter sleeps until its next animation`() {
        let now = Date(timeIntervalSinceReferenceDate: 100)
        let delay = CritterStatusLabel.nextAnimationTickDelay(
            now: now,
            isWorking: false,
            deadlines: [
                now.addingTimeInterval(8),
                now.addingTimeInterval(5),
                now.addingTimeInterval(11),
                now.addingTimeInterval(7),
            ])

        #expect(delay == 5)
    }

    @Test func `working critter keeps its animation cadence`() {
        let now = Date(timeIntervalSinceReferenceDate: 100)
        let delay = CritterStatusLabel.nextAnimationTickDelay(
            now: now,
            isWorking: true,
            deadlines: [now.addingTimeInterval(8)])

        #expect(delay == 0.35)
    }
}

private final class SampledPresentationLayer: CALayer {
    var sampledPresentation: SampledPresentationLayer?

    override func presentation() -> Self? {
        self.sampledPresentation as? Self
    }
}
