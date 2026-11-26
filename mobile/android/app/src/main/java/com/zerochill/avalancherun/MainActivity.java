package com.zerochill.avalancherun;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AdsPlugin.class); // local plugins register before the bridge starts
        super.onCreate(savedInstanceState);
    }
}
