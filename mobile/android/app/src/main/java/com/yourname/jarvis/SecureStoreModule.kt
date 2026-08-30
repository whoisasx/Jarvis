package com.yourname.jarvis

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.Executors

class SecureStoreModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val worker = Executors.newSingleThreadExecutor()

  override fun getName(): String = "JarvisSecureStore"

  @ReactMethod
  fun getSecret(key: String, promise: Promise) {
    worker.execute {
      runCatching { promise.resolve(JarvisSecrets.get(context, key)) }
        .onFailure { promise.reject("SECURE_STORE_READ_FAILED", it.message, it) }
    }
  }

  @ReactMethod
  fun setSecret(key: String, value: String, promise: Promise) {
    worker.execute {
      runCatching {
        val clean = value.trim()
        if (clean.isBlank()) throw IllegalArgumentException("Value cannot be empty")
        JarvisSecrets.set(context, key, clean)
        promise.resolve(true)
      }.onFailure { promise.reject("SECURE_STORE_WRITE_FAILED", it.message, it) }
    }
  }

  @ReactMethod
  fun deleteSecret(key: String, promise: Promise) {
    worker.execute {
      runCatching {
        JarvisSecrets.delete(context, key)
        promise.resolve(true)
      }.onFailure { promise.reject("SECURE_STORE_DELETE_FAILED", it.message, it) }
    }
  }

  @ReactMethod
  fun hasSecret(key: String, promise: Promise) {
    worker.execute {
      runCatching { promise.resolve(!JarvisSecrets.get(context, key).isNullOrBlank()) }
        .onFailure { promise.reject("SECURE_STORE_READ_FAILED", it.message, it) }
    }
  }
}
