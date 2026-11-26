import AppTrackingTransparency
import Capacitor
import IronSource
import UIKit

// The game's only door to Unity LevelPlay on iOS (DECISIONS 85), mirroring
// AdsPlugin.java on Android. Kept thin on purpose: pacing, placement and rewards
// are decided in the game (src/systems/ads.js) and on the server; this file only
// initialises the SDK and shows what it is told to.
//
// Written against the LevelPlay 9.x docs without a Mac (2026-11-26) and not yet
// compiled: see docs/ads.md, "iOS (slice 4)".
@objc(AdsPlugin)
public class AdsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AdsPlugin"
    public let jsName = "Ads"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "privacy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "trackingStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showInterstitial", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showRewarded", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBanner", returnType: CAPPluginReturnPromise),
    ]

    private static let bannerHeight = 50 // the default 320x50 banner, in points (= CSS pixels)

    private var ready = false
    private var interstitial: LPMInterstitialAd?
    private var rewarded: LPMRewardedAd?
    private var banner: LPMBannerAdView?
    private var bannerWanted = false
    private var bannerLoaded = false
    private var showing: CAPPluginCall? // the interstitial or rewarded call waiting for its ad to close
    private var earned = false
    // LevelPlay holds delegates weakly, and the interstitial and rewarded
    // protocols share method names, so each ad gets its own small listener.
    private var listeners: [AnyObject] = []

    // "start", not "init": Objective-C treats any init… method as a constructor.
    @objc func start(_ call: CAPPluginCall) {
        guard let appKey = call.getString("appKey"), !appKey.isEmpty else {
            call.reject("appKey missing")
            return
        }
        if ready {
            call.resolve(status())
            return
        }
        let interstitialId = call.getString("interstitial")
        let rewardedId = call.getString("rewarded")
        let bannerId = call.getString("banner")
        // The game asks Apple's tracking prompt itself, after its own explainer
        // and before calling start (DECISIONS 92), so the SDK starts knowing the answer.
        applyPrivacy(call)
        DispatchQueue.main.async {
            self.initLevelPlay(call, appKey: appKey, interstitialId: interstitialId, rewardedId: rewardedId, bannerId: bannerId)
        }
    }

    // The player's ad privacy answers (DECISIONS 92), handed over before start and
    // again whenever Settings changes them: { consent?: boolean, doNotSell?: boolean }.
    // LPMPrivacySettings is LevelPlay 9.5+'s API (from Unity's docs; not compiled yet).
    @objc func privacy(_ call: CAPPluginCall) {
        applyPrivacy(call)
        call.resolve()
    }

    private func applyPrivacy(_ call: CAPPluginCall) {
        if let consent = call.getBool("consent") { LPMPrivacySettings.setGDPRConsent(consent) }
        if let doNotSell = call.getBool("doNotSell") { LPMPrivacySettings.setCCPA(doNotSell) }
    }

    // { status: "notDetermined" | "authorized" | "denied" | "restricted" }
    @objc func trackingStatus(_ call: CAPPluginCall) {
        call.resolve(["status": AdsPlugin.trackingName(ATTrackingManager.trackingAuthorizationStatus)])
    }

    // Apple's tracking prompt; iOS shows it only while the answer is undetermined.
    @objc func requestTracking(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            ATTrackingManager.requestTrackingAuthorization { status in
                call.resolve(["status": AdsPlugin.trackingName(status)])
            }
        }
    }

    private static func trackingName(_ s: ATTrackingManager.AuthorizationStatus) -> String {
        switch s {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        default: return "notDetermined"
        }
    }

    private func initLevelPlay(_ call: CAPPluginCall, appKey: String, interstitialId: String?, rewardedId: String?, bannerId: String?) {
        let request = LPMInitRequestBuilder(appKey: appKey).build()
        LevelPlay.initWith(request) { [weak self] _, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let error = error {
                    call.reject("init failed: \(error.localizedDescription)")
                    return
                }
                self.ready = true
                if let id = interstitialId { self.setUpInterstitial(id) }
                if let id = rewardedId { self.setUpRewarded(id) }
                if let id = bannerId { self.setUpBanner(id) }
                call.resolve(self.status())
            }
        }
    }

    @objc func isReady(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.status()) }
    }

    // Resolves when the ad has closed: { shown }.
    @objc func showInterstitial(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.showing == nil, let ad = self.interstitial, ad.isAdReady(), let vc = self.bridge?.viewController else {
                call.resolve(Self.result(false, false))
                return
            }
            self.showing = call
            ad.showAd(viewController: vc, placementName: nil)
        }
    }

    // Resolves when the ad has closed: { shown, rewarded }. The reward itself is
    // credited by the server from LevelPlay's server-to-server callback, which
    // carries `userId` back as dynamicUserId so the server knows what to credit.
    @objc func showRewarded(_ call: CAPPluginCall) {
        let userId = call.getString("userId")
        DispatchQueue.main.async {
            guard self.showing == nil, let ad = self.rewarded, ad.isAdReady(), let vc = self.bridge?.viewController else {
                call.resolve(Self.result(false, false))
                return
            }
            if let userId = userId { LevelPlay.setDynamicUserId(userId) }
            self.showing = call
            self.earned = false
            ad.showAd(viewController: vc, placementName: nil)
        }
    }

    // The banner sits over the bottom edge of the game; the game makes room for
    // it in its layout, so the web view never resizes.
    @objc func setBanner(_ call: CAPPluginCall) {
        let on = call.getBool("visible") ?? false
        DispatchQueue.main.async {
            self.bannerWanted = on
            self.applyBanner()
            call.resolve(self.status())
        }
    }

    private func setUpInterstitial(_ id: String) {
        let ad = LPMInterstitialAd(adUnitId: id)
        let listener = InterstitialListener(owner: self, ad: ad)
        listeners.append(listener)
        ad.setDelegate(listener)
        interstitial = ad
        ad.loadAd()
    }

    private func setUpRewarded(_ id: String) {
        let ad = LPMRewardedAd(adUnitId: id)
        let listener = RewardedListener(owner: self, ad: ad)
        listeners.append(listener)
        ad.setDelegate(listener)
        rewarded = ad
        ad.loadAd()
    }

    private func setUpBanner(_ id: String) {
        guard let vc = bridge?.viewController else { return }
        let view = LPMBannerAdView(adUnitId: id, config: LPMBannerAdViewConfigBuilder().build())
        let listener = BannerListener(owner: self, view: view)
        listeners.append(listener)
        view.setDelegate(listener)
        view.isHidden = true
        view.translatesAutoresizingMaskIntoConstraints = false
        vc.view.addSubview(view)
        // Above the home indicator; the game already pads its layout by the same inset.
        NSLayoutConstraint.activate([
            view.centerXAnchor.constraint(equalTo: vc.view.centerXAnchor),
            view.bottomAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.bottomAnchor),
            view.widthAnchor.constraint(equalToConstant: 320),
            view.heightAnchor.constraint(equalToConstant: CGFloat(Self.bannerHeight)),
        ])
        banner = view
        view.loadAd(with: vc)
    }

    fileprivate func bannerResult(loaded: Bool) {
        bannerLoaded = loaded
        applyBanner()
    }

    private func applyBanner() {
        guard let view = banner else { return }
        let show = bannerWanted && bannerLoaded
        // On screen whenever the game wants a banner, even before one arrives:
        // on Android, LevelPlay stopped retrying a banner it couldn't see.
        view.isHidden = !bannerWanted
        // Only pause refresh once a banner has arrived: pausing while the first
        // load is still in flight stalls it (seen on Android).
        if bannerLoaded {
            if show { view.resumeAutoRefresh() } else { view.pauseAutoRefresh() }
        }
        notifyListeners("banner", data: ["height": show ? Self.bannerHeight : 0])
    }

    fileprivate func emitLoaded(_ format: String) {
        notifyListeners("loaded", data: ["format": format])
    }

    fileprivate func markEarned() {
        earned = true
    }

    fileprivate func finish(shown: Bool) {
        let call = showing
        showing = nil
        call?.resolve(Self.result(shown, earned))
        earned = false
    }

    fileprivate func retryLoad(_ load: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: load)
    }

    private func status() -> [String: Any] {
        return [
            "ready": ready,
            "interstitial": interstitial?.isAdReady() ?? false,
            "rewarded": rewarded?.isAdReady() ?? false,
            "banner": bannerLoaded,
        ]
    }

    private static func result(_ shown: Bool, _ rewarded: Bool) -> [String: Any] {
        return ["shown": shown, "rewarded": rewarded]
    }
}

private final class InterstitialListener: NSObject, LPMInterstitialAdDelegate {
    private weak var owner: AdsPlugin?
    private let ad: LPMInterstitialAd

    init(owner: AdsPlugin, ad: LPMInterstitialAd) {
        self.owner = owner
        self.ad = ad
    }

    func didLoadAd(with adInfo: LPMAdInfo) { owner?.emitLoaded("interstitial") }
    func didFailToLoadAd(withAdUnitId adUnitId: String, error: Error) {
        NSLog("AvalancheAds: interstitial load failed: %@", error.localizedDescription)
        owner?.retryLoad { self.ad.loadAd() }
    }
    func didDisplayAd(with adInfo: LPMAdInfo) {}
    func didFailToDisplayAd(with adInfo: LPMAdInfo, error: Error) {
        owner?.finish(shown: false)
        ad.loadAd()
    }
    func didCloseAd(with adInfo: LPMAdInfo) {
        owner?.finish(shown: true)
        ad.loadAd()
    }
}

private final class RewardedListener: NSObject, LPMRewardedAdDelegate {
    private weak var owner: AdsPlugin?
    private let ad: LPMRewardedAd

    init(owner: AdsPlugin, ad: LPMRewardedAd) {
        self.owner = owner
        self.ad = ad
    }

    func didLoadAd(with adInfo: LPMAdInfo) { owner?.emitLoaded("rewarded") }
    func didFailToLoadAd(withAdUnitId adUnitId: String, error: Error) {
        NSLog("AvalancheAds: rewarded load failed: %@", error.localizedDescription)
        owner?.retryLoad { self.ad.loadAd() }
    }
    func didDisplayAd(with adInfo: LPMAdInfo) {}
    func didRewardAd(with adInfo: LPMAdInfo, reward: LPMReward) { owner?.markEarned() }
    func didFailToDisplayAd(with adInfo: LPMAdInfo, error: Error) {
        owner?.finish(shown: false)
        ad.loadAd()
    }
    func didCloseAd(with adInfo: LPMAdInfo) {
        // The reward can arrive just after the close: give it a moment.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            self.owner?.finish(shown: true)
            self.ad.loadAd()
        }
    }
}

private final class BannerListener: NSObject, LPMBannerAdViewDelegate {
    private weak var owner: AdsPlugin?
    private let view: LPMBannerAdView

    init(owner: AdsPlugin, view: LPMBannerAdView) {
        self.owner = owner
        self.view = view
    }

    func didLoadAd(with adInfo: LPMAdInfo) { owner?.bannerResult(loaded: true) }
    // No retry of our own: the banner view retries by itself. A failed refresh
    // keeps the last ad on screen, so the space the game made for it stays too.
    func didFailToLoadAd(withAdUnitId adUnitId: String, error: Error) {
        NSLog("AvalancheAds: banner load failed: %@", error.localizedDescription)
    }
}
