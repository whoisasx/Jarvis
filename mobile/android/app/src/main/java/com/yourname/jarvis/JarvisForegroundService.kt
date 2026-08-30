package com.yourname.jarvis

import android.Manifest
import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.PackageManager.NameNotFoundException
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.StatFs
import android.provider.CallLog
import android.provider.Telephony
import android.telecom.TelecomManager
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

class JarvisForegroundService : Service() {
  companion object {
    const val CHANNEL_ID = "jarvis_connection"
    const val NOTIFICATION_ID = 1407
    const val EXTRA_BRAIN_URL = "brain_url"
    const val EXTRA_AUTH_TOKEN = "auth_token"
    const val LOCAL_BRAIN_URL = "local://embedded-brain"
    @Volatile var instance: JarvisForegroundService? = null
      private set
  }

  private val handler = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
  private var socket: WebSocket? = null
  private var brainUrl = ""
  private var authToken = ""
  private var reconnect: Runnable? = null
  private var stopped = false
  private var localMode = false
  private var currentStatus = "Not started"
  private var taskActive = false
  private var lastBatteryPercent: Int? = null
  private var lastCharging: Boolean? = null
  private var lastPhoneState = TelephonyManager.EXTRA_STATE_IDLE
  private var screenSnapshotQueued = false
  private var systemReceiverRegistered = false
  private var packageReceiverRegistered = false
  private var clipboardListener: ClipboardManager.OnPrimaryClipChangedListener? = null

  private val systemReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      when (intent.action) {
        Intent.ACTION_BATTERY_CHANGED -> publishBatteryChanged(intent)
        Intent.ACTION_BATTERY_LOW -> publishAndroidEvent("battery.low", "android.battery", "high", mapOf("percent" to (lastBatteryPercent ?: -1)))
        Intent.ACTION_POWER_CONNECTED -> publishAndroidEvent("charging.started", "android.power", "normal", batteryPayload(intent, true))
        Intent.ACTION_POWER_DISCONNECTED -> publishAndroidEvent("charging.stopped", "android.power", "normal", batteryPayload(intent, false))
        Intent.ACTION_SCREEN_OFF -> publishAndroidEvent("screen.locked", "android.screen", "high", mapOf("interactive" to false))
        Intent.ACTION_SCREEN_ON -> publishAndroidEvent("screen.unlocked", "android.screen", "normal", mapOf("interactive" to true, "reason" to "screen_on"))
        Intent.ACTION_USER_PRESENT -> publishAndroidEvent("screen.unlocked", "android.screen", "high", mapOf("interactive" to true, "reason" to "user_present"))
        BluetoothAdapter.ACTION_CONNECTION_STATE_CHANGED -> publishBluetoothEvent(intent)
        ConnectivityManager.CONNECTIVITY_ACTION -> publishWifiEvent()
        TelephonyManager.ACTION_PHONE_STATE_CHANGED -> publishCallState(intent)
      }
    }
  }

  private val packageReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      when (intent.action) {
        Intent.ACTION_PACKAGE_ADDED -> publishPackageEvent("package.installed", intent)
        Intent.ACTION_PACKAGE_REMOVED -> publishPackageEvent("package.removed", intent)
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Jarvis connection", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Keeps the Jarvis phone connection active"
        setShowBadge(false)
      },
    )
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val prefs = getSharedPreferences("jarvis", MODE_PRIVATE)
    val explicitBrainUrl = intent?.getStringExtra(EXTRA_BRAIN_URL)
    val savedUrl = prefs.getString(EXTRA_BRAIN_URL, null)
    brainUrl = explicitBrainUrl ?: savedUrl ?: LOCAL_BRAIN_URL
    authToken = if (brainUrl.startsWith("local://")) {
      ""
    } else {
      intent?.getStringExtra(EXTRA_AUTH_TOKEN) ?: prefs.getString(EXTRA_AUTH_TOKEN, "") ?: ""
    }
    localMode = brainUrl.startsWith("local://")
    if (localMode) {
      prefs.edit().putString(EXTRA_BRAIN_URL, LOCAL_BRAIN_URL).putString(EXTRA_AUTH_TOKEN, "").apply()
      brainUrl = LOCAL_BRAIN_URL
      authToken = ""
    } else if (brainUrl.isNotBlank() && authToken.isNotBlank()) {
      prefs.edit().putString(EXTRA_BRAIN_URL, brainUrl).putString(EXTRA_AUTH_TOKEN, authToken).apply()
    }

    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pendingIntent = PendingIntent.getActivity(
      this, 0, launchIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    startForeground(
      NOTIFICATION_ID,
      NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("Jarvis is running")
        .setContentText(if (localMode) "Embedded brain is running on this phone" else "Connected device automation is available")
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setOngoing(true)
        .setContentIntent(pendingIntent)
        .build(),
    )
    stopped = false
    registerSystemEventPublishers()
    JarvisFlowLog.event("service", "start", if (localMode) "Foreground service started in embedded mode" else "Foreground service started for laptop Brain")
    if (localMode) {
      socket?.close(1000, "Switching to embedded brain")
      socket = null
      reconnect?.let(handler::removeCallbacks)
      reconnect = null
      emitStatus("Embedded brain running on phone")
    } else {
      connect()
      if (socket != null) emitStatus(currentStatus)
    }
    return START_STICKY
  }

  private fun connect() {
    if (localMode || stopped || brainUrl.isBlank() || authToken.isBlank() || socket != null) return
    emitStatus("Connecting…")
    val separator = if (brainUrl.contains('?')) "&" else "?"
    val request = Request.Builder()
      .url("$brainUrl${separator}token=${Uri.encode(authToken)}")
      .build()
    socket = client.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        emitStatus("Connected")
        publishCurrentDeviceSnapshot()
        sendScreenState(null)
      }

      override fun onMessage(webSocket: WebSocket, text: String) = handleMessage(text)

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = disconnected(webSocket)
      override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
        JarvisFlowLog.event("connection", "fail", "WebSocket failed", error = error.message)
        JarvisEventBus.error("Connection: ${error.message}")
        disconnected(webSocket)
      }
    })
  }

  private fun disconnected(webSocket: WebSocket) {
    if (socket !== webSocket) return
    socket = null
    if (stopped) return
    emitStatus("Disconnected — retrying")
    reconnect?.let(handler::removeCallbacks)
    reconnect = Runnable { connect() }.also { handler.postDelayed(it, 3000) }
  }

  private fun handleMessage(raw: String) {
    val message = runCatching { JSONObject(raw) }.getOrElse {
      JarvisEventBus.error("Invalid brain message")
      return
    }
    when (message.optString("type")) {
      "request_screen_state" -> {
        val requestId = message.optString("requestId").takeIf { it.isNotBlank() }
        sendCachedScreenState(requestId)
        handler.post { queueScreenSnapshot(null, requestId, force = true) }
      }
      "task_status" -> {
        val status = message.optString("status")
        val detail = message.optString("detail", status)
        if (status == "started") {
          taskActive = true
          JarvisAccessibilityService.instance?.overlayTaskStarted(detail)
        }
        emitStatus(detail)
      }
      "action" -> handler.post { execute(message) }
    }
  }

  private fun execute(action: JSONObject) {
    val service = JarvisAccessibilityService.instance
    val name = action.optString("action")
    val actionId = action.optString("requestId").ifBlank { UUID.randomUUID().toString() }
    android.util.Log.i("JarvisAction", "actionId=$actionId action=$name")
    if (name == "task_complete" || name == "task_failed") {
      taskActive = false
      val success = name == "task_complete"
      val detail = if (success) action.optString("summary") else action.optString("reason")
      JarvisAccessibilityService.instance?.overlayFinished(detail, success)
      emitStatus(if (success) "Complete: $detail" else "Failed: $detail")
      return
    }
    JarvisAccessibilityService.instance?.overlayAction(
      name,
      action.optString("status").takeIf(String::isNotBlank),
      if (action.has("progress")) action.optInt("progress") else null,
    )

    fun finish(result: String, delayMs: Long = settleDelayFor(name)) {
      if (delayMs <= 0L) queueScreenSnapshot(result, force = true)
      else handler.postDelayed({ queueScreenSnapshot(result, force = true) }, delayMs)
    }
    try {
      when (name) {
        "list_apps" -> {
          val apps = JSONArray()
          packageManager.getInstalledPackages(0).forEach { pkg ->
            val label = runCatching { packageManager.getApplicationLabel(pkg.applicationInfo!!).toString() }.getOrDefault(pkg.packageName)
            apps.put(JSONObject().put("packageName", pkg.packageName).put("label", label))
          }
          finish("success: $apps")
        }
        "resolve_app" -> finish("success: ${resolveApp(action.getString("appName"))}", 0L)
        "open_app" -> {
          val requested = action.getString("packageName").trim()
          val launchIntent = exactLaunchIntent(requested)
          if (launchIntent == null) {
            finish("""failed: PACKAGE_NOT_LAUNCHABLE: {"ok":false,"requested":${JSONObject.quote(requested)},"error":"PACKAGE_NOT_LAUNCHABLE"}""")
          } else {
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(launchIntent)
            handler.postDelayed({
              val opened = service?.currentPackageName().orEmpty()
              finish("""success: {"ok":true,"requested":${JSONObject.quote(requested)},"resolvedPackage":${JSONObject.quote(requested)},"openedPackage":${JSONObject.quote(opened)},"packageName":${JSONObject.quote(requested)},"actionId":${JSONObject.quote(actionId)}}""")
            }, 700L)
            return
          }
        }
        "tap" -> serviceOrThrow(service).tap(action.getInt("x"), action.getInt("y")) { finish(if (it) "success" else "failed: Tap was rejected") }
        "swipe" -> serviceOrThrow(service).swipe(action.getInt("x1"), action.getInt("y1"), action.getInt("x2"), action.getInt("y2")) { finish(if (it) "success" else "failed: Swipe was rejected") }
        "find_and_tap" -> serviceOrThrow(service).findAndTap(action.getString("targetText")) { finish(if (it) "success" else "failed: No matching node was found") }
        "type" -> {
          val result = serviceOrThrow(service).type(action.getString("text"), null)
          finish(if (result == JarvisAccessibilityService.TypeResult.SUCCESS) "success" else "failed: ${result.name}")
        }
        "find_element" -> {
          serviceOrThrow(service).currentTree()
          val text = action.optString("text", "")
          val contentDescription = action.optString("contentDescription", "")
          val resourceId = action.optString("resourceId", "")
          val className = action.optString("className", "")
          val editable = action.optBoolean("editable", false)
          val clickable = action.optBoolean("clickable", false)
          val elementId = service?.findElementInMap(text, contentDescription, resourceId, className, editable, clickable)
          if (elementId != null) {
            finish("found: $elementId")
          } else {
            finish("not_found")
          }
        }
        "find_and_click" -> {
          val result = serviceOrThrow(service).findAndClick(
            action.optString("text", ""),
            action.optString("contentDescription", ""),
            action.optString("resourceId", ""),
            action.optString("className", ""),
            action.optBoolean("editable", false),
            action.optBoolean("clickable", false),
            actionId,
          )
          finish(if (result.optBoolean("ok")) "success: $result" else "failed: ${result.optString("error", "ACTION_FAILED")}: $result")
        }
        "resolve_chooser" -> {
          val result = serviceOrThrow(service).resolveChooser(
            action.optString("preferredPackage", ""),
            action.optString("preferredLabel", ""),
          )
          finish(if (result.optBoolean("ok")) "success: $result" else "failed: ${result.optString("error", "ACTION_FAILED")}: $result")
        }
        "press_back" -> {
          val result = serviceOrThrow(service).pressBack()
          finish(if (result.optBoolean("ok")) "success: $result" else "failed: ${result.optString("error", "ACTION_FAILED")}")
        }
        "focus_element" -> {
          val elementId = action.getString("elementId")
          val result = serviceOrThrow(service).focusElement(elementId)
          finish(when (result) {
            JarvisAccessibilityService.FocusClickResult.SUCCESS -> "success"
            JarvisAccessibilityService.FocusClickResult.ELEMENT_NOT_FOUND -> "failed: ELEMENT_NOT_FOUND"
            JarvisAccessibilityService.FocusClickResult.ELEMENT_STALE -> "failed: ELEMENT_STALE"
            JarvisAccessibilityService.FocusClickResult.ELEMENT_DISABLED -> "failed: ELEMENT_DISABLED"
            JarvisAccessibilityService.FocusClickResult.NOT_FOCUSABLE -> "failed: NOT_FOCUSABLE"
            JarvisAccessibilityService.FocusClickResult.NOT_CLICKABLE -> "failed: NOT_CLICKABLE"
            JarvisAccessibilityService.FocusClickResult.ACTION_FAILED -> "failed: ACTION_FAILED"
            else -> "failed: UNKNOWN"
          })
        }
        "click_element" -> {
          val elementId = action.getString("elementId")
          val result = serviceOrThrow(service).clickElement(elementId)
          finish(when (result) {
            JarvisAccessibilityService.FocusClickResult.SUCCESS -> "success"
            JarvisAccessibilityService.FocusClickResult.ELEMENT_NOT_FOUND -> "failed: ELEMENT_NOT_FOUND"
            JarvisAccessibilityService.FocusClickResult.ELEMENT_STALE -> "failed: ELEMENT_STALE"
            JarvisAccessibilityService.FocusClickResult.ELEMENT_DISABLED -> "failed: ELEMENT_DISABLED"
            JarvisAccessibilityService.FocusClickResult.NOT_FOCUSABLE -> "failed: NOT_FOCUSABLE"
            JarvisAccessibilityService.FocusClickResult.NOT_CLICKABLE -> "failed: NOT_CLICKABLE"
            JarvisAccessibilityService.FocusClickResult.ACTION_FAILED -> "failed: ACTION_FAILED"
            else -> "failed: UNKNOWN"
          })
        }
        "type_text" -> {
          val text = action.getString("text")
          val elementId = action.optString("elementId", "")
          val result = serviceOrThrow(service).type(text, if (elementId.isEmpty()) null else elementId)
          finish(when (result) {
            JarvisAccessibilityService.TypeResult.SUCCESS -> "success"
            JarvisAccessibilityService.TypeResult.ELEMENT_NOT_FOUND -> "failed: ELEMENT_NOT_FOUND"
            JarvisAccessibilityService.TypeResult.ELEMENT_STALE -> "failed: ELEMENT_STALE"
            JarvisAccessibilityService.TypeResult.ELEMENT_DISABLED -> "failed: ELEMENT_DISABLED"
            JarvisAccessibilityService.TypeResult.ELEMENT_NOT_EDITABLE -> "failed: ELEMENT_NOT_EDITABLE"
            JarvisAccessibilityService.TypeResult.ACTION_UNSUPPORTED -> "failed: ACTION_UNSUPPORTED"
            JarvisAccessibilityService.TypeResult.ACTION_FAILED -> "failed: ACTION_FAILED"
            JarvisAccessibilityService.TypeResult.INPUT_NOT_FOCUSED -> "failed: INPUT_NOT_FOCUSED"
            else -> "failed: UNKNOWN"
          })
        }
        "open_url" -> {
          val url = action.getString("url")
          val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          startActivity(intent)
          handler.postDelayed({
            autoResolveUnambiguousChooser()
            finish("""success: {"ok":true,"url":${JSONObject.quote(url)}}""")
          }, 700L)
          return
        }
        "wait" -> handler.postDelayed({ sendScreenState("success") }, action.optLong("ms", 1000))
        "press_key" -> {
          val key = action.getString("key").lowercase()
          val accessibility = serviceOrThrow(service)
          when (key) {
            "back" -> {
              val result = accessibility.pressBack()
              finish(if (result.optBoolean("ok")) "success: $result" else "failed: ${result.optString("error")}")
            }
            "home" -> finish(if (accessibility.goHome()) """success: {"ok":true,"key":"home"}""" else "failed: Could not press home")
            "enter" -> finish(if (accessibility.pressEnter()) """success: {"ok":true,"key":"enter"}""" else "failed: Could not press enter")
            else -> finish("failed: Unknown key $key")
          }
        }
        "call" -> {
          startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:${action.getString("number")}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
          handler.postDelayed({
            autoResolveUnambiguousChooser()
            finish("""success: {"ok":true,"number":${JSONObject.quote(action.getString("number"))}}""")
          }, 800L)
          return
        }
        "end_call" -> finish(endActiveCall())
        "get_recent_sms" -> finish("success: ${readRecentSms(action.optInt("limit", 10))}", 0L)
        "compose_message" -> {
          val number = action.getString("number")
          val body = action.optString("body", "")
          val preferred = action.optString("packageName", "")
          val target = resolveSmsComposerPackage(preferred)
          if (target == null) {
            finish("""failed: NO_SMS_APP: {"ok":false,"draft":false,"sent":false,"number":${JSONObject.quote(number)},"error":"NO_SMS_APP"}""")
          } else {
            val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:${Uri.encode(number)}"))
              .setPackage(target)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (body.isNotBlank()) {
              intent.putExtra("sms_body", body)
              intent.putExtra(Intent.EXTRA_TEXT, body)
            }
            if (intent.resolveActivity(packageManager) == null) {
              finish("""failed: PACKAGE_NOT_LAUNCHABLE: {"ok":false,"draft":false,"sent":false,"number":${JSONObject.quote(number)},"targetPackage":${JSONObject.quote(target)}}""")
            } else {
              startActivity(intent)
              handler.postDelayed({
                finish(inspectComposeResult(number, body, target))
              }, 900L)
              return
            }
          }
        }
        "send_sms" -> finish(sendSmsMessage(action.getString("number"), action.getString("body")))
        "get_recent_calls" -> {
          if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            throw SecurityException("READ_CALL_LOG permission is required")
          }
          val calls = JSONArray()
          val projection = arrayOf(
            CallLog.Calls.CACHED_NAME,
            CallLog.Calls.NUMBER,
            CallLog.Calls.TYPE,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION,
          )
          contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            projection,
            null,
            null,
            "${CallLog.Calls.DATE} DESC",
          )?.use { cursor ->
            val limit = action.optInt("limit", 10).coerceIn(1, 50)
            var count = 0
            while (cursor.moveToNext() && count++ < limit) {
              calls.put(JSONObject()
                .put("name", cursor.getString(0).orEmpty())
                .put("number", cursor.getString(1).orEmpty())
                .put("type", cursor.getInt(2))
                .put("timestamp", cursor.getLong(3))
                .put("durationSeconds", cursor.getLong(4)))
            }
          }
          finish("success: ${calls}")
        }
        "get_device_profile" -> finish("success: ${buildDeviceProfile()}", 0L)
        else -> finish("failed: Unsupported action $name")
      }
    } catch (error: Throwable) {
      finish("failed: ${error.message}")
    }
  }

  fun onAccessibilityChanged() {
    queueScreenSnapshot(null, force = false)
  }

  fun sendNotification(packageName: String, title: String, text: String, timestamp: Long) {
    socket?.send(JSONObject()
      .put("type", "notification")
      .put("packageName", packageName)
      .put("title", title)
      .put("text", text)
      .put("timestamp", timestamp)
      .toString())
  }

  fun sendDeviceObservation(kind: String, packageName: String, className: String, eventType: String, timestamp: Long) {
    val label = appLabel(packageName)
    JarvisEventBus.emit("device_observation", Arguments.createMap().apply {
      putString("kind", kind)
      putString("packageName", packageName)
      putString("appLabel", label)
      putString("className", className)
      putString("eventType", eventType)
      putDouble("timestamp", timestamp.toDouble())
    })
    socket?.send(JSONObject()
      .put("type", "device_observation")
      .put("kind", kind)
      .put("packageName", packageName)
      .put("appLabel", label)
      .put("className", className)
      .put("eventType", eventType)
      .put("timestamp", timestamp)
      .toString())
  }

  private var pendingSnapshotResult: String? = null
  private var pendingSnapshotRequestId: String? = null
  private var snapshotGeneration = 0

  private fun queueScreenSnapshot(lastActionResult: String?, requestId: String? = null, force: Boolean = false) {
    if (lastActionResult != null) pendingSnapshotResult = lastActionResult
    if (!requestId.isNullOrBlank()) pendingSnapshotRequestId = requestId
    val generation = ++snapshotGeneration
    screenSnapshotQueued = true
    handler.postDelayed({
      if (generation != snapshotGeneration) return@postDelayed
      screenSnapshotQueued = false
      val result = pendingSnapshotResult
      val reqId = pendingSnapshotRequestId
      pendingSnapshotResult = null
      pendingSnapshotRequestId = null
      sendScreenState(result, reqId)
    }, if (force) 0L else 160L)
  }

  private fun sendCachedScreenState(requestId: String?) {
    val service = JarvisAccessibilityService.instance ?: return
    val tree = runCatching { JSONArray(service.cachedTreeJson()) }.getOrDefault(JSONArray())
    if (tree.length() == 0) return
    val livePackage = runCatching { service.currentPackageName() }.getOrDefault("")
    val cachedPackage = service.cachedPackageName()
    val packageMatches = livePackage.isBlank() || cachedPackage.isBlank() || livePackage == cachedPackage
    if (service.cachedTreeAgeMs() > 20_000) return
    val reason = service.treeObservationReason()
    val message = JSONObject()
      .put("type", "screen_state")
      .put("nodeTree", tree)
      .put("packageName", cachedPackage.ifBlank { livePackage })
      .put("nodeCount", tree.length())
      .put("treeAvailable", true)
      .put("observationReason", if (reason.isBlank()) JSONObject.NULL else reason)
      .put("observationFresh", packageMatches && service.cachedTreeAgeMs() < 2_000)
      .put("lastActionResult", JSONObject.NULL)
    if (!requestId.isNullOrBlank()) message.put("requestId", requestId)
    socket?.send(message.toString())
  }

  private fun sendScreenState(lastActionResult: String?, requestId: String? = null) {
    val service = JarvisAccessibilityService.instance
    val tree = runCatching { JSONArray(service?.currentTree() ?: "[]") }.getOrDefault(JSONArray())
    val nodeCount = tree.length()
    val reason = service?.treeObservationReason().orEmpty()
    val message = JSONObject()
      .put("type", "screen_state")
      .put("nodeTree", tree)
      .put("packageName", service?.currentPackageName().orEmpty())
      .put("nodeCount", nodeCount)
      .put("treeAvailable", nodeCount > 0)
      .put("observationReason", if (reason.isBlank()) JSONObject.NULL else reason)
      .put("observationFresh", true)
      .put("lastActionResult", lastActionResult ?: JSONObject.NULL)
    if (!requestId.isNullOrBlank()) message.put("requestId", requestId)
    JarvisEventBus.emit("screen_state", Arguments.createMap().apply {
      putString("nodeTreeJson", tree.toString())
      putString("packageName", service?.currentPackageName().orEmpty())
    })
    socket?.send(message.toString())
  }

  private fun emitStatus(status: String) {
    currentStatus = status
    JarvisAccessibilityService.instance?.overlayConnection(status)
    JarvisEventBus.emit("connection_status", Arguments.createMap().apply { putString("status", status) })
  }

  private fun serviceOrThrow(service: JarvisAccessibilityService?) =
    service ?: throw IllegalStateException("Accessibility service is unavailable")

  private fun settleDelayFor(action: String): Long = when (action) {
    "list_apps", "resolve_app", "get_recent_calls", "get_recent_sms", "get_device_profile" -> 0L
    "tap", "find_and_tap", "type", "find_and_click", "press_back", "end_call" -> 120L
    "swipe" -> 220L
    "open_app", "call", "compose_message", "send_sms" -> 700L
    else -> 120L
  }

  private fun registerSystemEventPublishers() {
    if (!systemReceiverRegistered) {
      val filter = IntentFilter().apply {
        addAction(Intent.ACTION_BATTERY_CHANGED)
        addAction(Intent.ACTION_BATTERY_LOW)
        addAction(Intent.ACTION_POWER_CONNECTED)
        addAction(Intent.ACTION_POWER_DISCONNECTED)
        addAction(Intent.ACTION_SCREEN_OFF)
        addAction(Intent.ACTION_SCREEN_ON)
        addAction(Intent.ACTION_USER_PRESENT)
      }
      registerReceiver(systemReceiver, filter)

      registerReceiver(systemReceiver, IntentFilter().apply {
        addAction(BluetoothAdapter.ACTION_CONNECTION_STATE_CHANGED)
        addAction(ConnectivityManager.CONNECTIVITY_ACTION)
        addAction(TelephonyManager.ACTION_PHONE_STATE_CHANGED)
      })
      systemReceiverRegistered = true
    }

    if (!packageReceiverRegistered) {
      registerReceiver(packageReceiver, IntentFilter().apply {
        addAction(Intent.ACTION_PACKAGE_ADDED)
        addAction(Intent.ACTION_PACKAGE_REMOVED)
        addDataScheme("package")
      })
      packageReceiverRegistered = true
    }

    if (clipboardListener == null) {
      val clipboard = getSystemService(ClipboardManager::class.java)
      clipboardListener = ClipboardManager.OnPrimaryClipChangedListener {
        val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString().orEmpty()
        publishAndroidEvent("clipboard.changed", "android.clipboard", "normal", mapOf("text" to text.take(500)))
      }.also { clipboard.addPrimaryClipChangedListener(it) }
    }
    publishCurrentDeviceSnapshot()
  }

  private fun publishCurrentDeviceSnapshot() {
    val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    if (battery != null) {
      lastBatteryPercent = null
      lastCharging = null
      publishBatteryChanged(battery)
    }
    runCatching { publishWifiEvent() }
  }

  private fun autoResolveUnambiguousChooser() {
    val service = JarvisAccessibilityService.instance ?: return
    val result = service.resolveChooser("", "")
    if (!result.optBoolean("ok")) return
  }

  private fun endActiveCall(): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.ANSWER_PHONE_CALLS) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
      if (granted) {
        val ended = runCatching { getSystemService(TelecomManager::class.java).endCall() }.getOrDefault(false)
        if (ended) return """success: {"ok":true,"method":"telecom"}"""
      }
    }
    val service = JarvisAccessibilityService.instance
    val ui = service?.findAndClick(text = "End call")
    val resolved = if (ui?.optBoolean("ok") == true) ui else service?.findAndClick(contentDescription = "End call")
    if (resolved?.optBoolean("ok") == true) {
      return "success: ${resolved.put("method", "ui")}"
    }
    return "failed: NO_ACTIVE_CALL"
  }

  private fun readRecentSms(limit: Int): JSONArray {
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
      throw SecurityException("READ_SMS permission is required")
    }
    val rows = JSONArray()
    val projection = arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE)
    contentResolver.query(Telephony.Sms.CONTENT_URI, projection, null, null, "${Telephony.Sms.DATE} DESC")?.use { cursor ->
      var count = 0
      val max = limit.coerceIn(1, 50)
      while (cursor.moveToNext() && count++ < max) {
        rows.put(JSONObject()
          .put("address", cursor.getString(0).orEmpty())
          .put("body", cursor.getString(1).orEmpty())
          .put("timestamp", cursor.getLong(2))
          .put("type", cursor.getInt(3)))
      }
    }
    return rows
  }

  private fun sendSmsMessage(number: String, body: String): String {
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
      throw SecurityException("SEND_SMS permission is required")
    }
    val sms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      getSystemService(SmsManager::class.java) ?: SmsManager.getDefault()
    } else {
      @Suppress("DEPRECATION")
      SmsManager.getDefault()
    }
    sms.sendTextMessage(number, null, body, null, null)
    return """success: {"ok":true,"sent":true,"number":${JSONObject.quote(number)}}"""
  }

  private fun publishBatteryChanged(intent: Intent) {
    val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    val percent = if (level >= 0 && scale > 0) level * 100 / scale else -1
    val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
    val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    if (lastBatteryPercent == percent && lastCharging == charging) return
    lastBatteryPercent = percent
    lastCharging = charging
    publishAndroidEvent("battery.changed", "android.battery", "low", batteryPayload(intent, charging) + mapOf("percent" to percent))
  }

  private fun batteryPayload(intent: Intent, charging: Boolean): Map<String, Any?> {
    val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
    val source = when (plugged) {
      BatteryManager.BATTERY_PLUGGED_USB -> "usb"
      BatteryManager.BATTERY_PLUGGED_AC -> "ac"
      BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
      else -> ""
    }
    return mapOf("charging" to charging, "powerSource" to source)
  }

  private fun publishPackageEvent(eventType: String, intent: Intent) {
    val packageName = intent.data?.schemeSpecificPart.orEmpty()
    if (packageName.isBlank() || packageName == this.packageName) return
    publishAndroidEvent(eventType, "android.package_manager", "normal", mapOf("packageName" to packageName, "replacing" to intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)))
  }

  private fun publishBluetoothEvent(intent: Intent) {
    val state = intent.getIntExtra(BluetoothAdapter.EXTRA_CONNECTION_STATE, BluetoothAdapter.STATE_DISCONNECTED)
    val eventType = if (state == BluetoothAdapter.STATE_CONNECTED) "bluetooth.connected" else if (state == BluetoothAdapter.STATE_DISCONNECTED) "bluetooth.disconnected" else return
    publishAndroidEvent(eventType, "android.bluetooth", "normal", mapOf("state" to state))
  }

  private fun publishWifiEvent() {
    val connectivity = getSystemService(ConnectivityManager::class.java)
    val network = connectivity.activeNetwork
    val capabilities = connectivity.getNetworkCapabilities(network)
    val connected = capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
    publishAndroidEvent(if (connected) "wifi.connected" else "wifi.lost", "android.connectivity", "normal", mapOf("connected" to connected))
  }

  private fun publishCallState(intent: Intent) {
    val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE).orEmpty()
    if (state == lastPhoneState) return
    lastPhoneState = state
    val eventType = when (state) {
      TelephonyManager.EXTRA_STATE_RINGING -> "call.incoming"
      TelephonyManager.EXTRA_STATE_IDLE -> "call.ended"
      else -> return
    }
    publishAndroidEvent(eventType, "android.telephony", "high", mapOf("state" to state, "number" to intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER).orEmpty()))
  }

  private fun publishAndroidEvent(eventType: String, source: String, priority: String, payload: Map<String, Any?>) {
    val payloadJson = JSONObject()
    val payloadMap = Arguments.createMap()
    payload.forEach { (key, value) ->
      payloadJson.put(key, value)
      when (value) {
        null -> payloadMap.putNull(key)
        is Boolean -> payloadMap.putBoolean(key, value)
        is Int -> payloadMap.putInt(key, value)
        is Long -> payloadMap.putDouble(key, value.toDouble())
        is Double -> payloadMap.putDouble(key, value)
        is Float -> payloadMap.putDouble(key, value.toDouble())
        else -> payloadMap.putString(key, value.toString())
      }
    }
    val timestamp = System.currentTimeMillis()
    JarvisEventBus.emit("android_event", Arguments.createMap().apply {
      putString("eventType", eventType)
      putString("source", source)
      putString("priority", priority)
      putDouble("timestamp", timestamp.toDouble())
      putMap("payload", payloadMap)
    })
    socket?.send(JSONObject()
      .put("type", "android_event")
      .put("eventType", eventType)
      .put("source", source)
      .put("priority", priority)
      .put("timestamp", timestamp)
      .put("payload", payloadJson)
      .toString())
  }

  private fun appLabel(packageName: String): String =
    try {
      val info = packageManager.getApplicationInfo(packageName, 0)
      packageManager.getApplicationLabel(info).toString()
    } catch (_: NameNotFoundException) {
      packageName
    }

  private fun resolveApp(query: String): JSONObject {
    val apps = installedLaunchableApps()
    val visibleLabels = visibleNodeLabels()
    val scored = linkedMapOf<String, JSONObject>()

    apps.forEach { app ->
      val label = app.getString("label")
      val packageName = app.getString("packageName")
      val normalizedLabel = normalizeAppText(label)
      var score = appScore(query, label, packageName)
      var source = "installed_apps"

      if (score > 0 && visibleLabels.any { normalizeAppText(it) == normalizedLabel }) {
        score += 8
        source = "installed_apps+visible_node"
      }

      if (score > 0) {
        scored[packageName] = JSONObject()
          .put("label", label)
          .put("packageName", packageName)
          .put("score", score)
          .put("source", source)
      }
    }

    val matches = scored.values
      .sortedByDescending { it.optInt("score") }
      .take(8)
    val matchesJson = JSONArray().also { array -> matches.forEach(array::put) }
    val best = matches.firstOrNull()
    return JSONObject()
      .put("query", query)
      .put("bestMatch", best ?: JSONObject.NULL)
      .put("matches", matchesJson)
      .put("visibleLauncherLabels", JSONArray(visibleLabels.take(80)))
  }

  private fun exactLaunchIntent(requestedPackage: String): Intent? {
    val requested = requestedPackage.trim()
    if (requested.isEmpty()) return null
    packageManager.getLaunchIntentForPackage(requested)?.let { return it }
    val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(requested)
    val resolved = packageManager.queryIntentActivities(launcher, 0).firstOrNull() ?: return null
    return Intent(Intent.ACTION_MAIN)
      .addCategory(Intent.CATEGORY_LAUNCHER)
      .setClassName(requested, resolved.activityInfo.name)
  }

  private fun inspectComposeResult(number: String, body: String, target: String): String {
    val service = JarvisAccessibilityService.instance
    service?.currentTree()
    val opened = service?.currentPackageName().orEmpty()
    val defaultSms = Telephony.Sms.getDefaultSmsPackage(this).orEmpty()
    val labels = (service?.getElementNodeMap()?.values ?: emptyList()).map {
      it.text.ifBlank { it.contentDescription }.lowercase()
    }
    val joined = labels.joinToString(" ")
    val defaultPrompt = labels.any { label ->
      label.contains("default sms") || label.contains("default messaging") ||
        label.contains("make it your default") || label.contains("set default")
    }
    val hasSend = labels.any { it == "send" || it.contains("send message") || it == "sms send" }
    val hasRecipient = joined.contains(number.lowercase()) || labels.any { it.contains("recipient") || it.startsWith("to ") }
    val hasBody = body.isBlank() || joined.contains(body.lowercase().take(24))
    val composer = hasSend || service?.getElementNodeMap()?.values?.any { it.isEditable } == true
    val payload = JSONObject()
      .put("sent", false)
      .put("number", number)
      .put("targetPackage", target)
      .put("openedPackage", opened)
      .put("defaultSmsPackage", defaultSms)
    return when {
      defaultPrompt && !composer ->
        """failed: NOT_DEFAULT_SMS_APP: ${payload.put("ok", false).put("draft", false).put("draftCreated", false).put("error", "NOT_DEFAULT_SMS_APP").put("message", "The messaging app opened but cannot compose because it is not the default SMS app. Jarvis did not change the default and did not send.")}"""
      composer && (hasRecipient || hasBody || hasSend) ->
        """success: ${payload.put("ok", true).put("draft", true).put("draftCreated", true).put("recipientVisible", hasRecipient).put("bodyVisible", hasBody)}"""
      else ->
        """failed: COMPOSE_UNAVAILABLE: ${payload.put("ok", false).put("draft", false).put("draftCreated", false).put("error", "COMPOSE_UNAVAILABLE").put("message", "Opened the messaging app but a draft composer was not available.")}"""
    }
  }

  private fun resolveSmsComposerPackage(preferredPackage: String): String? {
    val preferred = preferredPackage.trim()
    if (preferred.isNotEmpty() && exactLaunchIntent(preferred) != null) return preferred
    val defaultSms = Telephony.Sms.getDefaultSmsPackage(this).orEmpty()
    val googleMessages = "com.google.android.apps.messaging"
    val candidates = listOf(defaultSms, googleMessages, "com.android.mms", "com.samsung.android.messaging")
      .filter { it.isNotBlank() }
      .distinct()
    val messaging = candidates.firstOrNull { pkg -> isSmsComposerPackage(pkg) && exactLaunchIntent(pkg) != null }
    if (messaging != null) return messaging
    return candidates.firstOrNull { exactLaunchIntent(it) != null }
  }

  private fun isSmsComposerPackage(packageName: String): Boolean {
    val pkg = packageName.lowercase()
    if (pkg.contains("truecaller") || pkg.contains("dialer") || pkg.contains("callerid")) return false
    return pkg.contains("messaging") || pkg.contains("mms") || pkg.endsWith(".sms") || pkg.contains("android.apps.messaging")
  }

  private fun installedLaunchableApps(): List<JSONObject> {
    val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    return packageManager.queryIntentActivities(launcherIntent, 0)
      .map { app ->
        JSONObject()
          .put("label", app.loadLabel(packageManager).toString())
          .put("packageName", app.activityInfo.packageName)
      }
      .sortedBy { it.getString("label").lowercase() }
  }

  private fun visibleNodeLabels(): List<String> {
    val service = JarvisAccessibilityService.instance ?: return emptyList()
    val tree = runCatching { JSONArray(service.currentTree()) }.getOrDefault(JSONArray())
    val labels = linkedSetOf<String>()
    for (index in 0 until tree.length()) {
      val node = tree.optJSONObject(index) ?: continue
      listOf(node.optString("text"), node.optString("contentDescription"))
        .map { it.trim() }
        .filter { it.isNotBlank() && it.length <= 80 }
        .filterNot { setOf("apps", "newsfeed", "search", "more options").contains(normalizeAppText(it)) }
        .forEach(labels::add)
    }
    return labels.toList()
  }

  private fun appScore(queryRaw: String, labelRaw: String, packageRaw: String): Int {
    val query = normalizeAppText(queryRaw)
    val label = normalizeAppText(labelRaw)
    val pkg = normalizeAppText(packageRaw)
    if (query.isBlank()) return 0
    if (packageRaw.equals(queryRaw, ignoreCase = true)) return 100
    val queryTokens = appTokens(query)
    val labelTokens = appTokens(label)
    val extra = labelTokens.filter { it !in queryTokens }
    val extraDistinguisher = extra.any { APP_DISTINGUISHERS.contains(it) }
    if (label == query || queryTokens.toSet() == labelTokens.toSet()) return 95
    if (extraDistinguisher) return 0
    val lastSegment = packageRaw.substringAfterLast('.').lowercase()
    if (lastSegment.isNotBlank() && lastSegment == query.replace(" ", "")) return 90
    if (pkg.replace(" ", "") == query.replace(" ", "")) return 88
    if (label.startsWith(query) && extra.isEmpty()) return 82
    if (label.contains(query) && extra.isEmpty()) return 72
    if (pkg.contains(query) && extra.isEmpty() && labelTokens.none { APP_DISTINGUISHERS.contains(it) }) return 64
    if (queryTokens.size > 1 && queryTokens.all { label.contains(it) || pkg.contains(it) }) return 76
    return 0
  }

  private fun appTokens(value: String): List<String> =
    value.split(" ").filter { it.isNotBlank() }.map { if (it == "yt") "youtube" else it }

  private val APP_DISTINGUISHERS = setOf("music", "lite", "go", "tv", "studio", "kids", "premium")

  private fun normalizeAppText(value: String): String =
    value.lowercase()
      .replace("&", " and ")
      .replace(Regex("[^a-z0-9]+"), " ")
      .trim()
      .replace(Regex("\\s+"), " ")

  private fun levenshtein(a: String, b: String): Int {
    val previous = IntArray(b.length + 1) { it }
    for (i in 1..a.length) {
      var last = i - 1
      previous[0] = i
      for (j in 1..b.length) {
        val old = previous[j]
        previous[j] = minOf(
          previous[j] + 1,
          previous[j - 1] + 1,
          last + if (a[i - 1] == b[j - 1]) 0 else 1,
        )
        last = old
      }
    }
    return previous[b.length]
  }

  private fun findNodeByClassName(root: android.view.accessibility.AccessibilityNodeInfo?, className: String): android.view.accessibility.AccessibilityNodeInfo? {
    if (root == null) return null
    val currentClass = root.className?.toString() ?: ""
    if (currentClass.contains(className, ignoreCase = true)) return root
    for (i in 0 until root.childCount) {
      val child = root.getChild(i)
      if (child != null) {
        val found = findNodeByClassName(child, className)
        if (found != null) return found
      }
    }
    return null
  }

  private fun findNodeByContentDescription(root: android.view.accessibility.AccessibilityNodeInfo?, targetDescription: String): android.view.accessibility.AccessibilityNodeInfo? {
    if (root == null) return null
    val desc = root.contentDescription?.toString().orEmpty()
    if (desc.contains(targetDescription, ignoreCase = true)) return root
    for (i in 0 until root.childCount) {
      val child = root.getChild(i)
      if (child != null) {
        val found = findNodeByContentDescription(child, targetDescription)
        if (found != null) return found
      }
    }
    return null
  }

  private fun findElementIdInTree(service: JarvisAccessibilityService, targetNode: android.view.accessibility.AccessibilityNodeInfo): String? {
    val nodeMap = service.getElementNodeMap()
    for ((elementId, nodeInfo) in nodeMap) {
      if (nodeInfo.node === targetNode) {
        return elementId
      }
    }
    return null
  }

  private fun buildDeviceProfile(): JSONObject {
    val activity = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val memory = ActivityManager.MemoryInfo().also(activity::getMemoryInfo)
    val stat = StatFs(filesDir.absolutePath)
    val power = getSystemService(PowerManager::class.java)
    val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val batteryStatus = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    val batteryLevel = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val batteryScale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
    val batteryPercent = if (batteryLevel >= 0 && batteryScale > 0) (batteryLevel * 100 / batteryScale) else -1
    val features = packageManager.systemAvailableFeatures.mapNotNull { it.name }
    val hasVulkan = features.any { it.contains("vulkan", ignoreCase = true) }
    val hasGpu = packageManager.hasSystemFeature(PackageManager.FEATURE_OPENGLES_EXTENSION_PACK) || hasVulkan
    val hasNpu = features.any {
      it.contains("neural", ignoreCase = true) ||
        it.contains("npu", ignoreCase = true) ||
        it.contains("ai", ignoreCase = true) ||
        it.contains("hexagon", ignoreCase = true)
    }
    return JSONObject()
      .put("manufacturer", Build.MANUFACTURER.orEmpty())
      .put("model", Build.MODEL.orEmpty())
      .put("ramMB", (memory.totalMem / 1024L / 1024L).toInt())
      .put("cpuCores", Runtime.getRuntime().availableProcessors())
      .put("architecture", System.getProperty("os.arch").orEmpty())
      .put("abi", Build.SUPPORTED_ABIS.firstOrNull().orEmpty())
      .put("androidVersion", Build.VERSION.RELEASE.orEmpty())
      .put("sdk", Build.VERSION.SDK_INT)
      .put("storageAvailableMB", (stat.availableBytes / 1024L / 1024L).toInt())
      .put("batteryState", batteryStateName(batteryStatus))
      .put("batteryPercent", batteryPercent)
      .put("thermalStatus", thermalStatusName(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) power.currentThermalStatus else -1))
      .put("supportsGPUAcceleration", hasGpu)
      .put("supportsNPUAcceleration", hasNpu)
  }

  private fun batteryStateName(status: Int) = when (status) {
    BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
    BatteryManager.BATTERY_STATUS_DISCHARGING -> "discharging"
    BatteryManager.BATTERY_STATUS_FULL -> "full"
    BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "not_charging"
    else -> "unknown"
  }

  private fun thermalStatusName(status: Int) = when (status) {
    PowerManager.THERMAL_STATUS_NONE -> "none"
    PowerManager.THERMAL_STATUS_LIGHT -> "light"
    PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
    PowerManager.THERMAL_STATUS_SEVERE -> "severe"
    PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
    PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
    PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
    else -> "unknown"
  }

  override fun onDestroy() {
    stopped = true
    reconnect?.let(handler::removeCallbacks)
    if (systemReceiverRegistered) {
      runCatching { unregisterReceiver(systemReceiver) }
      systemReceiverRegistered = false
    }
    if (packageReceiverRegistered) {
      runCatching { unregisterReceiver(packageReceiver) }
      packageReceiverRegistered = false
    }
    clipboardListener?.let { listener ->
      runCatching { getSystemService(ClipboardManager::class.java).removePrimaryClipChangedListener(listener) }
      clipboardListener = null
    }
    socket?.close(1000, "Service stopped")
    socket = null
    if (instance === this) instance = null
    client.dispatcher.executorService.shutdown()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
