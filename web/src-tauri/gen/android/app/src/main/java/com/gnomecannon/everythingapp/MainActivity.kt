package com.gnomecannon.everythingapp

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  /** Held only while the app is on screen, so Bonjour answers from the hub reach it (home.rs browses only then). */
  private var multicast: WifiManager.MulticastLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Android 15 and later draw apps under the status and navigation bars. The app is a web page that does not
    // pad itself for them, so the window keeps them clear here (and shrinks above the keyboard while typing).
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onResume() {
    super.onResume()
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    multicast = wifi?.createMulticastLock("aeneas-bonjour")?.apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  override fun onPause() {
    multicast?.let { if (it.isHeld) it.release() }
    multicast = null
    super.onPause()
  }
}
