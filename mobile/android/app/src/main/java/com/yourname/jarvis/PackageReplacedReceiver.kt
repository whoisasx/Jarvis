package com.yourname.jarvis

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class PackageReplacedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    val prefs = context.getSharedPreferences("jarvis", Context.MODE_PRIVATE)
    val url = prefs.getString(JarvisForegroundService.EXTRA_BRAIN_URL, null) ?: return
    val token = prefs.getString(JarvisForegroundService.EXTRA_AUTH_TOKEN, "") ?: ""
    if (url.isBlank() || url.startsWith("local://") || token.isBlank()) return
    ContextCompat.startForegroundService(
      context,
      Intent(context, JarvisForegroundService::class.java)
        .putExtra(JarvisForegroundService.EXTRA_BRAIN_URL, url)
        .putExtra(JarvisForegroundService.EXTRA_AUTH_TOKEN, token),
    )
  }
}
