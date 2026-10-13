import PiseKit
import SwiftUI

@main
struct PiseApp: App {
    var body: some Scene {
        MenuBarExtra("Pise", systemImage: "chart.bar.xaxis") {
            PiseDashboard()
        }
        .menuBarExtraStyle(.window)
    }
}
