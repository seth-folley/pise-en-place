import ComposableArchitecture
import SwiftUI

/// The menu bar dashboard. Its store, reducers, and ledger clients are package-owned;
/// the application target needs only SwiftUI and this local package product.
@MainActor
public struct PiseDashboard: View {
    @State private var store = Store(initialState: DashboardFeature.State()) {
        DashboardFeature()
    }

    public init() {}

    public var body: some View {
        ContentView(store: store)
    }
}
