package com.yourname.jarvis

import android.os.PowerManager
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class AccessibilityModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  init { JarvisEventBus.attach(context) }
  override fun getName() = "JarvisAccessibility"

  // An open_app step pushes the target app to the foreground and drops this
  // process out of Android's top-app scheduling class. The embedded Brain's
  // whole action -> refreshAndSend -> screen_state -> onScreenState loop runs
  // on this process's JS thread, so without a wake lock that thread can be
  // starved of CPU for many seconds while another app is in front — which is
  // what was firing the "delayed action result" watchdog. Held only for the
  // lifetime of one task, released the moment it completes or fails.
  private var taskWakeLock: PowerManager.WakeLock? = null

  @ReactMethod fun tap(x: Double, y: Double, promise: Promise) = withService(promise) {
    it.tap(x.toInt(), y.toInt()) { ok -> settle(promise, ok, "Tap was rejected") }
  }

  @ReactMethod fun type(text: String, elementId: String?, promise: Promise) = withService(promise) {
    val result = it.type(text, elementId)
    when (result) {
      JarvisAccessibilityService.TypeResult.SUCCESS -> promise.resolve(true)
      JarvisAccessibilityService.TypeResult.ELEMENT_NOT_FOUND -> promise.reject("ELEMENT_NOT_FOUND", "Element not found in registry")
      JarvisAccessibilityService.TypeResult.ELEMENT_STALE -> promise.reject("ELEMENT_STALE", "The referenced UI element is no longer available")
      JarvisAccessibilityService.TypeResult.ELEMENT_DISABLED -> promise.reject("ELEMENT_DISABLED", "Element is disabled")
      JarvisAccessibilityService.TypeResult.ELEMENT_NOT_EDITABLE -> promise.reject("ELEMENT_NOT_EDITABLE", "Element is not editable")
      JarvisAccessibilityService.TypeResult.ACTION_UNSUPPORTED -> promise.reject("ACTION_UNSUPPORTED", "Action not supported on element")
      JarvisAccessibilityService.TypeResult.ACTION_FAILED -> promise.reject("ACTION_FAILED", "Failed to type text")
      JarvisAccessibilityService.TypeResult.INPUT_NOT_FOCUSED -> promise.reject("INPUT_NOT_FOCUSED", "Could not focus the target field")
    }
  }

  @ReactMethod fun focus_element(elementId: String, promise: Promise) = withService(promise) {
    val result = it.focusElement(elementId)
    when (result) {
      JarvisAccessibilityService.FocusClickResult.SUCCESS -> promise.resolve(true)
      JarvisAccessibilityService.FocusClickResult.ELEMENT_NOT_FOUND -> promise.reject("ELEMENT_NOT_FOUND", "Element not found in registry")
      JarvisAccessibilityService.FocusClickResult.ELEMENT_STALE -> promise.reject("ELEMENT_STALE", "The referenced UI element is no longer available")
      JarvisAccessibilityService.FocusClickResult.ELEMENT_DISABLED -> promise.reject("ELEMENT_DISABLED", "Element is disabled")
      JarvisAccessibilityService.FocusClickResult.NOT_FOCUSABLE -> promise.reject("NOT_FOCUSABLE", "Element is not focusable")
      JarvisAccessibilityService.FocusClickResult.NOT_CLICKABLE -> promise.reject("NOT_CLICKABLE", "Element is not clickable")
      JarvisAccessibilityService.FocusClickResult.ACTION_FAILED -> promise.reject("ACTION_FAILED", "Failed to focus element")
    }
  }

  @ReactMethod fun click_element(elementId: String, promise: Promise) = withService(promise) {
    val result = it.clickElement(elementId)
    when (result) {
      JarvisAccessibilityService.FocusClickResult.SUCCESS -> promise.resolve(true)
      JarvisAccessibilityService.FocusClickResult.ELEMENT_NOT_FOUND -> promise.reject("ELEMENT_NOT_FOUND", "Element not found in registry")
      JarvisAccessibilityService.FocusClickResult.ELEMENT_STALE -> promise.reject("ELEMENT_STALE", "The referenced UI element is no longer available")
      JarvisAccessibilityService.FocusClickResult.ELEMENT_DISABLED -> promise.reject("ELEMENT_DISABLED", "Element is disabled")
      JarvisAccessibilityService.FocusClickResult.NOT_FOCUSABLE -> promise.reject("NOT_FOCUSABLE", "Element is not focusable")
      JarvisAccessibilityService.FocusClickResult.NOT_CLICKABLE -> promise.reject("NOT_CLICKABLE", "Element is not clickable")
      JarvisAccessibilityService.FocusClickResult.ACTION_FAILED -> promise.reject("ACTION_FAILED", "Failed to click element")
    }
  }

  @ReactMethod fun type_text(text: String, elementId: String?, promise: Promise) = withService(promise) {
    val result = it.type(text, elementId)
    when (result) {
      JarvisAccessibilityService.TypeResult.SUCCESS -> promise.resolve(true)
      JarvisAccessibilityService.TypeResult.ELEMENT_NOT_FOUND -> promise.reject("ELEMENT_NOT_FOUND", "Element not found in registry")
      JarvisAccessibilityService.TypeResult.ELEMENT_STALE -> promise.reject("ELEMENT_STALE", "The referenced UI element is no longer available")
      JarvisAccessibilityService.TypeResult.ELEMENT_DISABLED -> promise.reject("ELEMENT_DISABLED", "Element is disabled")
      JarvisAccessibilityService.TypeResult.ELEMENT_NOT_EDITABLE -> promise.reject("ELEMENT_NOT_EDITABLE", "Element is not editable")
      JarvisAccessibilityService.TypeResult.ACTION_UNSUPPORTED -> promise.reject("ACTION_UNSUPPORTED", "Action not supported on element")
      JarvisAccessibilityService.TypeResult.ACTION_FAILED -> promise.reject("ACTION_FAILED", "Failed to type text")
      JarvisAccessibilityService.TypeResult.INPUT_NOT_FOCUSED -> promise.reject("INPUT_NOT_FOCUSED", "Could not focus the target field")
    }
  }

  @ReactMethod fun find_and_click(args: ReadableMap, promise: Promise) = withService(promise) {
    val result = it.findAndClick(
      getStringArg(args, "text"),
      getStringArg(args, "contentDescription"),
      getStringArg(args, "resourceId"),
      getStringArg(args, "className"),
      getBooleanArg(args, "editable"),
      getBooleanArg(args, "clickable"),
    )
    if (result.optBoolean("ok")) promise.resolve(result.toString())
    else promise.reject(result.optString("error", "ACTION_FAILED"), result.toString())
  }

  @ReactMethod fun find_element(args: ReadableMap, promise: Promise) = withService(promise) {
    val service = JarvisAccessibilityService.instance
    if (service == null) {
      promise.reject("ACCESSIBILITY_DISABLED", "Accessibility service is unavailable")
      return@withService
    }
    service.currentTree()
    val elementId = service.findElementInMap(
      getStringArg(args, "text"),
      getStringArg(args, "contentDescription"),
      getStringArg(args, "resourceId"),
      getStringArg(args, "className"),
      getBooleanArg(args, "editable"),
      getBooleanArg(args, "clickable"),
    )
    if (elementId != null) {
      promise.resolve(mapOf("found" to true, "elementId" to elementId))
    } else {
      promise.resolve(mapOf("found" to false))
    }
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

  private fun getStringArg(args: ReadableMap, key: String): String {
    if (!args.hasKey(key)) return ""
    val value = args.getString(key)
    return if (value != null && value.isNotBlank()) value else ""
  }

  private fun getBooleanArg(args: ReadableMap, key: String): Boolean {
    if (!args.hasKey(key)) return false
    return args.getBoolean(key)
  }

  @ReactMethod fun swipe(x1: Double, y1: Double, x2: Double, y2: Double, promise: Promise) = withService(promise) {
    it.swipe(x1.toInt(), y1.toInt(), x2.toInt(), y2.toInt()) { ok -> settle(promise, ok, "Swipe was rejected") }
  }

  @ReactMethod fun findAndTap(targetText: String, promise: Promise) = withService(promise) {
    it.findAndTap(targetText) { ok -> settle(promise, ok, "No matching node was found") }
  }

  @ReactMethod fun press_back(promise: Promise) = withService(promise) {
    val result = it.pressBack()
    if (result.optBoolean("ok")) promise.resolve(true)
    else promise.reject(result.optString("error", "ACTION_FAILED"), result.toString())
  }

  @ReactMethod fun getCurrentNodeTree(promise: Promise) = withService(promise) {
    promise.resolve(it.currentTree())
  }

  @ReactMethod fun overlayTaskStarted(instruction: String, promise: Promise) {
    JarvisAccessibilityService.instance?.overlayTaskStarted(instruction)
    JarvisFlowLog.event("overlay", "start", instruction)
    acquireTaskWakeLock()
    promise.resolve(true)
  }

  @ReactMethod fun overlayAction(action: String, status: String, progress: Double, promise: Promise) {
    val percent = if (progress.isNaN() || progress < 0) null else progress.toInt()
    val label = status.takeIf { it.isNotBlank() }
    JarvisAccessibilityService.instance?.overlayAction(action, label, percent)
    JarvisFlowLog.event("overlay", "success", label ?: action, extra = mapOf("action" to action))
    promise.resolve(true)
  }

  @ReactMethod fun overlayFinished(message: String, success: Boolean, promise: Promise) {
    JarvisAccessibilityService.instance?.overlayFinished(message, success)
    JarvisFlowLog.event("overlay", if (success) "success" else "fail", message)
    releaseTaskWakeLock()
    promise.resolve(true)
  }

  @ReactMethod fun overlayConnection(status: String, promise: Promise) {
    JarvisAccessibilityService.instance?.overlayConnection(status)
    promise.resolve(true)
  }

  @ReactMethod fun addListener(eventName: String) = Unit
  @ReactMethod fun removeListeners(count: Double) = Unit

  private fun withService(promise: Promise, block: (JarvisAccessibilityService) -> Unit) {
    val service = JarvisAccessibilityService.instance
    if (service == null) {
      JarvisFlowLog.event("native_execute", "fail", "Accessibility service is unavailable")
      promise.reject("ACCESSIBILITY_DISABLED", "Enable Jarvis in Accessibility settings")
    } else block(service)
  }

  private fun settle(promise: Promise, success: Boolean, reason: String) {
    if (success) promise.resolve(true)
    else {
      JarvisFlowLog.event("native_execute", "fail", reason)
      promise.reject("ACTION_FAILED", reason)
    }
  }

  private fun acquireTaskWakeLock() {
    if (taskWakeLock?.isHeld == true) return
    val power = reactApplicationContext.getSystemService(PowerManager::class.java) ?: return
    val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Jarvis:TaskExecution")
    lock.setReferenceCounted(false)
    // Safety timeout in case a task is killed/aborted without ever reaching
    // overlayFinished (e.g. the app process is force-stopped mid-task).
    lock.acquire(5 * 60 * 1000L)
    taskWakeLock = lock
    JarvisFlowLog.event("wakelock", "start", "Acquired task wake lock")
  }

  private fun releaseTaskWakeLock() {
    taskWakeLock?.let { if (it.isHeld) it.release() }
    taskWakeLock = null
    JarvisFlowLog.event("wakelock", "success", "Released task wake lock")
  }
}
