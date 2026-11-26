package com.zerochill.avalancherun;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.unity3d.mediation.LevelPlay;
import com.unity3d.mediation.LevelPlayAdError;
import com.unity3d.mediation.LevelPlayAdInfo;
import com.unity3d.mediation.LevelPlayAdSize;
import com.unity3d.mediation.LevelPlayConfiguration;
import com.unity3d.mediation.LevelPlayInitError;
import com.unity3d.mediation.LevelPlayInitListener;
import com.unity3d.mediation.LevelPlayInitRequest;
import com.unity3d.mediation.banner.LevelPlayBannerAdView;
import com.unity3d.mediation.banner.LevelPlayBannerAdViewListener;
import com.unity3d.mediation.interstitial.LevelPlayInterstitialAd;
import com.unity3d.mediation.interstitial.LevelPlayInterstitialAdListener;
import com.unity3d.mediation.rewarded.LevelPlayReward;
import com.unity3d.mediation.rewarded.LevelPlayRewardedAd;
import com.unity3d.mediation.rewarded.LevelPlayRewardedAdListener;

// The game's only door to Unity LevelPlay (DECISIONS 85). Kept thin on purpose:
// pacing, placement and rewards are decided in the game (src/systems/ads.js) and
// on the server; this file only initialises the SDK and shows what it is told to.
@CapacitorPlugin(name = "Ads")
public class AdsPlugin extends Plugin {
    private static final String TAG = "AvalancheAds";
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean ready;
    private LevelPlayInterstitialAd interstitial;
    private LevelPlayRewardedAd rewarded;
    private LevelPlayBannerAdView banner;
    private FrameLayout bannerHolder;
    private boolean bannerWanted;
    private boolean bannerLoaded;
    private PluginCall showing; // the interstitial or rewarded call waiting for its ad to close
    private boolean earned;

    // "start", not "init", to match iOS, where Objective-C treats init… methods as constructors.
    @PluginMethod
    public void start(PluginCall call) {
        String appKey = call.getString("appKey");
        if (appKey == null || appKey.isEmpty()) {
            call.reject("appKey missing");
            return;
        }
        if (ready) {
            call.resolve(status());
            return;
        }
        final String bannerId = call.getString("banner");
        final String interstitialId = call.getString("interstitial");
        final String rewardedId = call.getString("rewarded");
        // Debug builds log every network's answer, so a no-fill can be traced.
        if ((getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) LevelPlay.setAdaptersDebug(true);
        LevelPlay.init(getContext(), new LevelPlayInitRequest.Builder(appKey).build(), new LevelPlayInitListener() {
            @Override
            public void onInitSuccess(LevelPlayConfiguration configuration) {
                main.post(() -> {
                    ready = true;
                    if (interstitialId != null) setUpInterstitial(interstitialId);
                    if (rewardedId != null) setUpRewarded(rewardedId);
                    if (bannerId != null) setUpBanner(bannerId);
                    call.resolve(status());
                });
            }

            @Override
            public void onInitFailed(LevelPlayInitError error) {
                call.reject("init failed: " + error);
            }
        });
    }

    @PluginMethod
    public void isReady(PluginCall call) {
        call.resolve(status());
    }

    // Resolves when the ad has closed: { shown }.
    @PluginMethod
    public void showInterstitial(PluginCall call) {
        main.post(() -> {
            Activity a = getActivity();
            if (showing != null || interstitial == null || a == null || !interstitial.isAdReady()) {
                call.resolve(result(false, false));
                return;
            }
            showing = call;
            interstitial.showAd(a);
        });
    }

    // Resolves when the ad has closed: { shown, rewarded }. The reward itself is
    // credited by the server from LevelPlay's server-to-server callback, which
    // carries `userId` back as dynamicUserId so the server knows what to credit.
    @PluginMethod
    public void showRewarded(PluginCall call) {
        final String userId = call.getString("userId");
        main.post(() -> {
            Activity a = getActivity();
            if (showing != null || rewarded == null || a == null || !rewarded.isAdReady()) {
                call.resolve(result(false, false));
                return;
            }
            if (userId != null) LevelPlay.setDynamicUserId(userId);
            showing = call;
            earned = false;
            rewarded.showAd(a);
        });
    }

    // The banner sits over the bottom edge of the game; the game makes room for
    // it in its layout, so the WebView never resizes.
    @PluginMethod
    public void setBanner(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("visible", false));
        main.post(() -> {
            bannerWanted = on;
            applyBanner();
            call.resolve(status());
        });
    }

    private void setUpInterstitial(String id) {
        interstitial = new LevelPlayInterstitialAd(id);
        interstitial.setListener(new LevelPlayInterstitialAdListener() {
            @Override public void onAdLoaded(LevelPlayAdInfo info) { emit("loaded", "interstitial"); }
            @Override public void onAdLoadFailed(LevelPlayAdError error) { Log.w(TAG, "interstitial load failed: " + error); retryLoad(() -> interstitial.loadAd()); }
            @Override public void onAdDisplayed(LevelPlayAdInfo info) {}
            @Override public void onAdDisplayFailed(LevelPlayAdError error, LevelPlayAdInfo info) { finish(false); interstitial.loadAd(); }
            @Override public void onAdClosed(LevelPlayAdInfo info) { finish(true); interstitial.loadAd(); }
        });
        interstitial.loadAd();
    }

    private void setUpRewarded(String id) {
        rewarded = new LevelPlayRewardedAd(id);
        rewarded.setListener(new LevelPlayRewardedAdListener() {
            @Override public void onAdLoaded(LevelPlayAdInfo info) { emit("loaded", "rewarded"); }
            @Override public void onAdLoadFailed(LevelPlayAdError error) { Log.w(TAG, "rewarded load failed: " + error); retryLoad(() -> rewarded.loadAd()); }
            @Override public void onAdDisplayed(LevelPlayAdInfo info) {}
            @Override public void onAdRewarded(LevelPlayReward reward, LevelPlayAdInfo info) { earned = true; }
            @Override public void onAdDisplayFailed(LevelPlayAdError error, LevelPlayAdInfo info) { finish(false); rewarded.loadAd(); }
            @Override public void onAdClosed(LevelPlayAdInfo info) {
                // The reward can arrive just after the close: give it a moment.
                main.postDelayed(() -> { finish(true); rewarded.loadAd(); }, 600);
            }
        });
        rewarded.loadAd();
    }

    private void setUpBanner(String id) {
        Activity a = getActivity();
        if (a == null) return;
        LevelPlayBannerAdView.Config config = new LevelPlayBannerAdView.Config.Builder().setAdSize(LevelPlayAdSize.BANNER).build();
        banner = new LevelPlayBannerAdView(a, id, config);
        banner.setBannerListener(new LevelPlayBannerAdViewListener() {
            @Override public void onAdLoaded(LevelPlayAdInfo info) { Log.i(TAG, "banner loaded"); bannerLoaded = true; applyBanner(); }
            // No retry of our own: the banner view retries by itself (about every
            // 25 s). A failed refresh keeps the last ad on screen, so the space
            // the game made for it stays too.
            @Override public void onAdLoadFailed(LevelPlayAdError error) { Log.w(TAG, "banner load failed: " + error); }
        });
        bannerHolder = new FrameLayout(a);
        bannerHolder.setVisibility(View.GONE);
        // The app draws edge to edge: keep the banner above the navigation bar
        // (the game already pads its layout by the same inset).
        ViewCompat.setOnApplyWindowInsetsListener(bannerHolder, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.navigationBars());
            v.setPadding(0, 0, 0, bars.bottom);
            return insets;
        });
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        // A fixed 320x50 dp box, so the empty view has an area before the first
        // ad: LevelPlay seems to stop retrying a banner it can't see on screen.
        float dp = a.getResources().getDisplayMetrics().density;
        bannerHolder.addView(banner, new FrameLayout.LayoutParams(Math.round(LevelPlayAdSize.BANNER.getWidth() * dp), Math.round(LevelPlayAdSize.BANNER.getHeight() * dp)));
        ((ViewGroup) a.findViewById(android.R.id.content)).addView(bannerHolder, lp);
        ViewCompat.requestApplyInsets(bannerHolder);
        banner.loadAd();
    }

    private void applyBanner() {
        if (bannerHolder == null) return;
        boolean show = bannerWanted && bannerLoaded;
        // On screen whenever the game wants a banner, even before one arrives:
        // LevelPlay stops retrying a banner view that isn't shown. Empty, it is
        // transparent and lets taps through; the game only makes room once loaded.
        bannerHolder.setVisibility(bannerWanted ? View.VISIBLE : View.GONE);
        // Only pause refresh once a banner has arrived: pausing while the first
        // load is still in flight stalls it, and the banner never shows.
        if (bannerLoaded) {
            if (show) banner.resumeAutoRefresh();
            else banner.pauseAutoRefresh();
        }
        JSObject o = new JSObject();
        // CSS pixels equal dp in the WebView.
        o.put("height", show ? LevelPlayAdSize.BANNER.getHeight() : 0);
        notifyListeners("banner", o);
    }

    private void finish(boolean shown) {
        PluginCall c = showing;
        showing = null;
        if (c != null) c.resolve(result(shown, earned));
        earned = false;
    }

    private void retryLoad(Runnable load) {
        main.postDelayed(load, 30000);
    }

    private void emit(String event, String format) {
        JSObject o = new JSObject();
        o.put("format", format);
        notifyListeners(event, o);
    }

    private JSObject status() {
        JSObject o = new JSObject();
        o.put("ready", ready);
        o.put("interstitial", interstitial != null && interstitial.isAdReady());
        o.put("rewarded", rewarded != null && rewarded.isAdReady());
        o.put("banner", bannerLoaded);
        return o;
    }

    private static JSObject result(boolean shown, boolean rewarded) {
        JSObject o = new JSObject();
        o.put("shown", shown);
        o.put("rewarded", rewarded);
        return o;
    }
}
