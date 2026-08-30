package com.yourname.jarvis

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys

object JarvisSecrets {
  private const val ENCRYPTED_FILE = "jarvis_secure_store"
  private const val LEGACY_LOCAL_AI = "jarvis_local_ai_runtime"
  const val CURSOR_API_KEY = "cursor_api_key"
  const val CURSOR_MODEL_ID = "cursor_model_id"
  const val CURSOR_ENABLED = "cursor_enabled"
  const val HUGGINGFACE_TOKEN = "huggingface_token"

  @Volatile private var cached: SharedPreferences? = null

  fun prefs(context: Context): SharedPreferences {
    cached?.let { return it }
    synchronized(this) {
      cached?.let { return it }
      val app = context.applicationContext
      val created = runCatching {
        val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
        EncryptedSharedPreferences.create(
          ENCRYPTED_FILE,
          masterKeyAlias,
          app,
          EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
          EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
      }.getOrElse {
        app.getSharedPreferences(ENCRYPTED_FILE, Context.MODE_PRIVATE)
      }
      migrateLegacyHuggingFaceToken(app, created)
      cached = created
      return created
    }
  }

  fun get(context: Context, key: String): String? =
    prefs(context).getString(key, null)?.takeIf { it.isNotBlank() }

  fun set(context: Context, key: String, value: String) {
    prefs(context).edit().putString(key, value.trim()).apply()
  }

  fun delete(context: Context, key: String) {
    prefs(context).edit().remove(key).apply()
  }

  private fun migrateLegacyHuggingFaceToken(app: Context, secure: SharedPreferences) {
    if (!secure.getString(HUGGINGFACE_TOKEN, null).isNullOrBlank()) return
    val legacy = app.getSharedPreferences(LEGACY_LOCAL_AI, Context.MODE_PRIVATE)
    val token = legacy.getString(HUGGINGFACE_TOKEN, null)?.trim().orEmpty()
    if (token.isBlank()) return
    secure.edit().putString(HUGGINGFACE_TOKEN, token).apply()
    legacy.edit().remove(HUGGINGFACE_TOKEN).apply()
  }
}
