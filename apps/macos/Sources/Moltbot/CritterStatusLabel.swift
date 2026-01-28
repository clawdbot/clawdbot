import SwiftUI

struct CritterStatusLabel: View {
    var isPaused: Bool
    var isSleeping: Bool
    var isWorking: Bool
    var earBoostActive: Bool
    var blinkTick: Int
    var sendCelebrationTick: Int
    var gatewayStatus: GatewayProcessManager.Status
    var animationsEnabled: Bool
    var iconState: IconState

    @State var blinkAmount: CGFloat = 0
    @State var nextBlink = Date().addingTimeInterval(Double.random(in: 3.5...8.5))
    @State var wiggleAngle: Double = 0
    @State var wiggleOffset: CGFloat = 0
    @State var nextWiggle = Date().addingTimeInterval(Double.random(in: 6.5...14))
    @State var legWiggle: CGFloat = 0
    @State var nextLegWiggle = Date().addingTimeInterval(Double.random(in: 5.0...11.0))
    @State var earWiggle: CGFloat = 0
    @State var nextEarWiggle = Date().addingTimeInterval(Double.random(in: 7.0...14.0))
}
