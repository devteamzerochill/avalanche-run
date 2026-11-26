import Capacitor
import UIKit

// The storyboard's bridge view controller, so local plugins can register
// (Capacitor's way on iOS; MainActivity does the same on Android).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(AdsPlugin())
    }
}
