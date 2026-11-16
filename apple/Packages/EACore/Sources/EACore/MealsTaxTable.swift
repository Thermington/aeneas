import Foundation

/// The hub's meals tax lookup (hub/src/mealstax.ts) for sample mode, which has no hub: each state's rate on restaurant
/// meals and the US Census state outlines, copied from the hub by hub/scripts/sample-meals-tax.ts into
/// SampleMealsTax.json in the app. The answer is the hub's, worked out on the device.
public struct MealsTaxTable: Codable, Sendable {
    public struct Rate: Codable, Sendable {
        public var name: String
        public var pct: Double
    }

    public struct State: Codable, Sendable {
        public var code: String
        /// Polygons, each a list of rings of [longitude, latitude] points (the first ring the outside).
        public var polygons: [[[[Double]]]]
    }

    public var rates: [String: Rate]
    /// In the hub's order, which decides a point on a shared border.
    public var states: [State]

    /// What the hub answers for a position, or nil outside every state.
    public func answer(latitude: Double, longitude: Double) -> MealsTax? {
        // Rounded as the hub rounds (JavaScript's Math.round), so a position gives the hub's answer.
        let lat = (latitude * 100 + 0.5).rounded(.down) / 100
        let lon = (longitude * 100 + 0.5).rounded(.down) / 100
        guard let state = states.first(where: { $0.polygons.contains { Self.inside(lon, lat, $0) } }),
              let rate = rates[state.code] else { return nil }
        return MealsTax(state: state.code, name: rate.name, pct: rate.pct,
                        note: "\(rate.name)'s rate on restaurant meals. Your city or county may add its own.")
    }

    /// Even-odd test over every ring of a polygon, so a hole (a lake, an enclave) is outside.
    static func inside(_ lon: Double, _ lat: Double, _ rings: [[[Double]]]) -> Bool {
        var inside = false
        for ring in rings where ring.count > 2 && ring.allSatisfy({ $0.count >= 2 }) {
            var j = ring.count - 1
            for i in 0..<ring.count {
                let xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]
                if (yi > lat) != (yj > lat), lon < (xj - xi) * (lat - yi) / (yj - yi) + xi { inside.toggle() }
                j = i
            }
        }
        return inside
    }
}
