package com.yourname.jarvis

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject

class JarvisAccessibilityService : AccessibilityService() {
  companion object {
    private const val MAX_TREE_DEPTH = 45
    private const val MAX_TREE_NODES = 500

    @Volatile var instance: JarvisAccessibilityService? = null
    private set

    const val ACTION_FOCUS = "android.accessibilityaction.FOCUS"
    const val ACTION_CLICK = "android.accessibilityaction.CLICK"
    const val ACTION_SET_TEXT = "android.accessibilityaction.SET_TEXT"
  }

  @Volatile private var latestTree = "[]"
  @Volatile private var latestPackageName = ""
  @Volatile private var latestTreeAt = 0L
  private lateinit var overlay: JarvisOverlayController
  private val main = Handler(Looper.getMainLooper())
  private var lastPackageName = ""
  private var lastClassName = ""
  private var lastWindowObservationAt = 0L
  private var lastInteractionObservationAt = 0L

  private val nodeIdMap = mutableMapOf<String, AndroidNodeInfo>()
  private val fingerprints = mutableMapOf<String, NodeFingerprint>()
  private var nextElementId = 1
  private var currentTreeVersion = 0

  private fun generateElementId(nodeId: Int): String {
    return "tree-$currentTreeVersion-node-$nodeId"
  }

  private fun extractTreeVersion(elementId: String): Int? {
    val parts = elementId.split("-")
    if (parts.size >= 2 && parts[0] == "tree") {
      return try { parts[1].toInt() } catch (e: NumberFormatException) { null }
    }
    return null
  }

  override fun onServiceConnected() {
    instance = this
    overlay = JarvisOverlayController(this, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY)
    overlay.show()
    JarvisFlowLog.event("accessibility", "success", "Accessibility service connected and overlay shown")
    restartStoredForegroundService()
  }

  fun overlayTaskStarted(instruction: String) = main.post {
    if (!::overlay.isInitialized) return@post
    overlay.taskStarted(instruction)
  }
  fun overlayAction(action: String, status: String?, progress: Int?) = main.post {
    if (!::overlay.isInitialized) return@post
    overlay.action(action, status, progress)
  }
  fun overlayFinished(message: String, success: Boolean) = main.post {
    if (!::overlay.isInitialized) return@post
    overlay.taskFinished(message, success)
  }
  fun overlayConnection(status: String) = main.post {
    if (!::overlay.isInitialized) overlay.connection(status)
  }
  fun overlayEnsureVisible() = main.post { if (::overlay.isInitialized) overlay.ensureVisible() }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) = observeLightweight(event)
  override fun onInterrupt() = Unit

  override fun onDestroy() {
    if (::overlay.isInitialized) overlay.hide()
    if (instance === this) instance = null
    super.onDestroy()
  }

  fun currentTree(): String {
    refreshTree()
    return latestTree
  }

  fun cachedTreeJson(): String = latestTree

  fun cachedPackageName(): String = latestPackageName

  fun cachedTreeAgeMs(): Long = if (latestTreeAt == 0L) Long.MAX_VALUE else System.currentTimeMillis() - latestTreeAt

  fun currentPackageName(): String = activeContentRoot()?.packageName?.toString().orEmpty()

  fun tap(x: Int, y: Int, callback: (Boolean) -> Unit) {
    dispatch(Path().apply { moveTo(x.toFloat(), y.toFloat()) }, 1L, 80L, callback)
  }

  fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, callback: (Boolean) -> Unit) {
    val path = Path().apply {
      moveTo(x1.toFloat(), y1.toFloat())
      lineTo(x2.toFloat(), y2.toFloat())
    }
    dispatch(path, 1L, 450L, callback)
  }

  fun type(text: String, elementId: String? = null): TypeResult {
    currentTree()
    val resolvedId = when {
      !elementId.isNullOrBlank() -> resolveElementId(elementId)
      else -> findFocusedEditableId() ?: findElementInMap(editable = true)
    }
    if (resolvedId == null) return TypeResult.ELEMENT_NOT_FOUND
    val nodeInfo = nodeIdMap[resolvedId]?.node ?: return TypeResult.ELEMENT_NOT_FOUND
    if (isElementStale(nodeInfo)) {
      nodeIdMap.remove(resolvedId)
      return TypeResult.ELEMENT_STALE
    }
    if (!nodeInfo.isEnabled) return TypeResult.ELEMENT_DISABLED
    if (!nodeInfo.isEditable) return TypeResult.ELEMENT_NOT_EDITABLE

    if (!nodeInfo.isFocused) {
      nodeInfo.performAction(AccessibilityNodeInfo.ACTION_CLICK)
      if (!nodeInfo.performAction(AccessibilityNodeInfo.ACTION_FOCUS, null) && !nodeInfo.isFocused) {
        val args = Bundle().apply {
          putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return if (nodeInfo.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
          TypeResult.SUCCESS
        } else {
          TypeResult.INPUT_NOT_FOCUSED
        }
      }
    }

    val args = Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    }
    return if (nodeInfo.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
      TypeResult.SUCCESS
    } else {
      TypeResult.ACTION_FAILED
    }
  }

  enum class TypeResult {
    SUCCESS,
    ELEMENT_NOT_FOUND,
    ELEMENT_STALE,
    ELEMENT_DISABLED,
    ELEMENT_NOT_EDITABLE,
    ACTION_UNSUPPORTED,
    ACTION_FAILED,
    INPUT_NOT_FOCUSED
  }

  fun findAndTap(targetText: String, callback: (Boolean) -> Unit) {
    val target = targetText.trim()
    if (target.isEmpty()) {
      callback(false)
      return
    }

    val matches = mutableListOf<AccessibilityNodeInfo>()
    fun walk(node: AccessibilityNodeInfo?) {
      if (node == null) return
      val text = node.text?.toString().orEmpty()
      val desc = node.contentDescription?.toString().orEmpty()
      if (text.equals(target, ignoreCase = true) || desc.equals(target, ignoreCase = true)) {
        matches.add(node)
      }
      for (i in 0 until node.childCount) walk(node.getChild(i))
    }
    walk(activeContentRoot())

    val node = matches.firstOrNull { it.isClickable }
      ?: matches.firstOrNull()?.let { match ->
        var clickable: AccessibilityNodeInfo? = match
        while (clickable != null && !clickable.isClickable) clickable = clickable.parent
        clickable
      }

    if (node == null) {
      callback(false)
      return
    }

    if (node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
      callback(true)
      return
    }
    val bounds = Rect().also { node.getBoundsInScreen(it) }
    tap(bounds.centerX().toInt(), bounds.centerY().toInt(), callback)
  }

  fun getElementNodeMap(): Map<String, AndroidNodeInfo> {
    return nodeIdMap.toMap()
  }

  fun findElementInMap(
    text: String = "",
    contentDescription: String = "",
    resourceId: String = "",
    className: String = "",
    editable: Boolean = false,
    clickable: Boolean = false,
  ): String? {
    var bestId: String? = null
    var bestScore = -1
    for ((elementId, info) in nodeIdMap) {
      if (isElementIdStale(elementId)) continue
      val node = info.node
      if (!node.isVisibleToUser) continue
      val nodeText = node.text?.toString().orEmpty()
      val nodeDesc = node.contentDescription?.toString().orEmpty()
      var score = 0
      if (text.isNotEmpty()) {
        val aliases = symbolAliases(text)
        val exact = nodeText.equals(text, ignoreCase = true) || nodeDesc.equals(text, ignoreCase = true) ||
          aliases.any { alias -> nodeDesc.equals(alias, ignoreCase = true) || nodeText.equals(alias, ignoreCase = true) }
        val partial = nodeText.contains(text, ignoreCase = true) || nodeDesc.contains(text, ignoreCase = true)
        if (!exact && !partial) continue
        score += if (exact) 100 else 60
      }
      if (contentDescription.isNotEmpty()) {
        if (!nodeDesc.contains(contentDescription, ignoreCase = true) && !nodeText.contains(contentDescription, ignoreCase = true)) continue
        score += 40
      }
      if (resourceId.isNotEmpty() && node.viewIdResourceName != resourceId) continue
      if (className.isNotEmpty() && !node.className.toString().contains(className, ignoreCase = true)) continue
      if (editable && !node.isEditable) continue
      if (clickable && !node.isClickable) continue
      if (text.isEmpty() && contentDescription.isEmpty() && resourceId.isEmpty() && className.isEmpty() && !editable && !clickable) continue
      if (score == 0) score = 10
      val better = when {
        score > bestScore -> true
        score < bestScore -> false
        bestId == null -> true
        else -> preferTighterClickTarget(node, nodeIdMap[bestId]?.node)
      }
      if (better) {
        bestScore = score
        bestId = elementId
      }
    }
    return bestId
  }

  private fun preferTighterClickTarget(candidate: AccessibilityNodeInfo, current: AccessibilityNodeInfo?): Boolean {
    if (current == null) return true
    if (candidate.isClickable && !current.isClickable) return true
    if (!candidate.isClickable && current.isClickable) return false
    val candidateBounds = Rect().also { candidate.getBoundsInScreen(it) }
    val currentBounds = Rect().also { current.getBoundsInScreen(it) }
    val candidateArea = candidateBounds.width().toLong() * candidateBounds.height()
    val currentArea = currentBounds.width().toLong() * currentBounds.height()
    return candidateArea in 1 until currentArea
  }

  fun getCurrentTreeVersion(): Int {
    return currentTreeVersion
  }

  fun getNextElementId(): Int {
    return nextElementId
  }

  fun setNextElementId(id: Int) {
    nextElementId = id
  }

  fun addNodeToMap(elementId: String, node: android.view.accessibility.AccessibilityNodeInfo) {
    nodeIdMap[elementId] = AndroidNodeInfo(node)
  }

  fun addNodeToMap(elementId: String, node: AndroidNodeInfo) {
    nodeIdMap[elementId] = node
  }

  fun incrementElementId(): Int {
    val current = nextElementId
    nextElementId = nextElementId + 1
    return current
  }

  private fun isElementStale(nodeInfo: AccessibilityNodeInfo?): Boolean {
    return nodeInfo == null || !nodeInfo.isVisibleToUser || !isNodeAttachedToWindow(nodeInfo)
  }

  private fun isElementIdStale(elementId: String): Boolean {
    val version = extractTreeVersion(elementId)
    return version != null && version != currentTreeVersion
  }

  private fun isNodeAttachedToWindow(nodeInfo: AccessibilityNodeInfo): Boolean {
    try {
      val bounds = Rect()
      nodeInfo.getBoundsInScreen(bounds)
      return bounds.width() > 0 && bounds.height() > 0
    } catch (e: Exception) {
      return false
    }
  }

  private fun resolveElementId(elementId: String): String {
    val cached = nodeIdMap[elementId]
    if (cached != null && !isElementStale(cached.node)) return elementId
    val fingerprint = fingerprints[elementId] ?: cached?.let {
      NodeFingerprint(it.text, it.contentDescription, it.resourceId, it.className)
    } ?: return elementId
    if (fingerprint.isEmpty()) return elementId
    currentTree()
    val matches = nodeIdMap.entries.filter { (_, info) ->
      !isElementStale(info.node) && fingerprint.matches(info)
    }
    return if (matches.size == 1) matches[0].key else elementId
  }

  private fun findFocusedEditableId(): String? {
    return nodeIdMap.entries.firstOrNull { (_, info) ->
      info.isEditable && info.isFocused && !isElementStale(info.node)
    }?.key
  }

  fun findAndClick(
    text: String = "",
    contentDescription: String = "",
    resourceId: String = "",
    className: String = "",
    editable: Boolean = false,
    clickable: Boolean = false,
    actionId: String = "",
  ): JSONObject {
    if (text.isBlank() && contentDescription.isBlank() && resourceId.isBlank() && className.isBlank() && !editable && !clickable) {
      return JSONObject().put("ok", false).put("error", "ELEMENT_NOT_FOUND").put("message", "No match criteria provided")
    }
    repeat(3) { attempt ->
      currentTree()
      val selected = selectClickTarget(text, contentDescription, resourceId, className, editable, clickable)
      if (selected.error != null) {
        return JSONObject()
          .put("ok", false)
          .put("error", selected.error)
          .put("actionId", actionId)
          .put("message", selected.message)
          .put("matches", selected.matches)
      }
      val elementId = selected.elementId ?: return JSONObject().put("ok", false).put("error", "ELEMENT_NOT_FOUND").put("actionId", actionId)
      val info = nodeIdMap[elementId] ?: return@repeat
        val before = contentSignature(screenSignature())
        val clicked = clickElementDetailed(elementId, actionId)
        if (clicked.result == FocusClickResult.SUCCESS) {
        var changed = false
        for (i in 0 until 8) {
          Thread.sleep(60)
          currentTree()
          if (contentSignature(screenSignature()) != before) {
            changed = true
            break
          }
        }
        if (!changed && !selected.uniqueControl) {
          return JSONObject()
            .put("ok", false)
            .put("error", "NO_VISIBLE_CHANGE")
            .put("actionId", actionId)
            .put("elementId", elementId)
            .put("label", info.text.ifBlank { info.contentDescription })
            .put("clickMethod", clicked.method)
            .put("clickCount", 1)
            .put("uiChanged", false)
            .put("message", "A node was clicked but the screen did not change")
        }
        return JSONObject()
          .put("ok", true)
          .put("actionId", actionId)
          .put("elementId", elementId)
          .put("label", info.text.ifBlank { info.contentDescription })
          .put("resourceId", info.resourceId)
          .put("clickMethod", clicked.method)
          .put("clickCount", 1)
          .put("uiChanged", changed)
          .put("attempts", attempt + 1)
      }
      if (clicked.dispatched) {
        return JSONObject()
          .put("ok", false)
          .put("error", clicked.result.name)
          .put("actionId", actionId)
          .put("elementId", elementId)
          .put("clickCount", 1)
          .put("message", "Click was dispatched; not retrying to avoid duplicate side effects")
      }
      if (clicked.result != FocusClickResult.ELEMENT_STALE && clicked.result != FocusClickResult.ELEMENT_NOT_FOUND) {
        return JSONObject().put("ok", false).put("error", clicked.result.name).put("elementId", elementId).put("actionId", actionId)
      }
    }
    return JSONObject().put("ok", false).put("error", "ELEMENT_STALE").put("actionId", actionId)
  }

  private data class ClickSelection(
    val elementId: String? = null,
    val error: String? = null,
    val message: String? = null,
    val matches: JSONArray = JSONArray(),
    val uniqueControl: Boolean = false,
  )

  private fun selectClickTarget(
    text: String,
    contentDescription: String,
    resourceId: String,
    className: String,
    editable: Boolean,
    clickable: Boolean,
  ): ClickSelection {
    data class Candidate(val id: String, val exact: Boolean, val editable: Boolean, val clickable: Boolean, val area: Long, val label: String)
    val candidates = mutableListOf<Candidate>()
    for ((elementId, info) in nodeIdMap) {
      if (isElementIdStale(elementId) || !info.node.isVisibleToUser) continue
      val nodeText = info.text
      val nodeDesc = info.contentDescription
      if (text.isNotEmpty()) {
        val aliases = symbolAliases(text)
        val exact = nodeText.equals(text, ignoreCase = true) || nodeDesc.equals(text, ignoreCase = true) ||
          aliases.any { alias -> nodeDesc.equals(alias, ignoreCase = true) || nodeText.equals(alias, ignoreCase = true) }
        val partial = nodeText.contains(text, ignoreCase = true) || nodeDesc.contains(text, ignoreCase = true) ||
          aliases.any { alias -> nodeDesc.contains(alias, ignoreCase = true) }
        if (!exact && !partial) continue
        val label = nodeText.ifBlank { nodeDesc }
        if (text.length <= 3 && !exact && label.length > text.length + 1) continue
        if (resourceId.isNotEmpty() && info.resourceId != resourceId) continue
        if (className.isNotEmpty() && !info.className.contains(className, ignoreCase = true)) continue
        if (editable && !info.isEditable) continue
        if (clickable && !info.isClickable) continue
        val bounds = Rect().also { info.node.getBoundsInScreen(it) }
        candidates.add(Candidate(elementId, exact, info.isEditable, info.isClickable, bounds.width().toLong() * bounds.height(), nodeText.ifBlank { nodeDesc }))
      } else {
        val id = findElementInMap(text, contentDescription, resourceId, className, editable, clickable) ?: continue
        return ClickSelection(elementId = id)
      }
    }
    if (text.isEmpty()) {
      val id = findElementInMap(text, contentDescription, resourceId, className, editable, clickable)
      return if (id == null) ClickSelection(error = "ELEMENT_NOT_FOUND") else ClickSelection(elementId = id)
    }
    if (candidates.isEmpty()) return ClickSelection(error = "ELEMENT_NOT_FOUND")
    val exact = candidates.filter { it.exact }
    val pool = if (exact.isNotEmpty()) exact else candidates.filter { it.clickable && !it.editable }.ifEmpty { candidates }
    val content = pool.filter { !it.editable }
    val chosenPool = when {
      content.size == 1 -> content
      content.size > 1 -> content
      else -> pool
    }
    if (chosenPool.size > 1) {
      val uniqueLabels = chosenPool.map { it.label.lowercase() }.toSet()
      if (uniqueLabels.size > 1) {
        val listed = JSONArray()
        chosenPool.take(6).forEach { listed.put(JSONObject().put("elementId", it.id).put("label", it.label).put("editable", it.editable)) }
        return ClickSelection(error = "MATCH_AMBIGUOUS", message = "Multiple nodes matched; pass a more specific label", matches = listed)
      }
    }
    val winner = chosenPool.minWithOrNull(
      compareBy<Candidate> { if (it.exact) 0 else 1 }
        .thenBy { it.label.length }
        .thenBy { if (it.editable) 1 else 0 }
        .thenBy { if (it.clickable) 0 else 1 }
        .thenBy { if (it.area > 0) it.area else Long.MAX_VALUE },
    )
    return if (winner == null) {
      ClickSelection(error = "ELEMENT_NOT_FOUND")
    } else {
      val sameLabel = chosenPool.count { it.label.equals(winner.label, ignoreCase = true) && it.clickable && !it.editable }
      ClickSelection(elementId = winner.id, uniqueControl = winner.exact && winner.clickable && !winner.editable && sameLabel == 1)
    }
  }

  fun screenSignature(): String {
    val tree = runCatching { JSONArray(latestTree) }.getOrDefault(JSONArray())
    val labels = buildList {
      for (index in 0 until tree.length()) {
        val node = tree.optJSONObject(index) ?: continue
        add("${node.optString("resourceId")}\u0001${node.optString("text").trim()}\u0001${node.optString("contentDescription").trim()}")
      }
    }.sorted()
    return listOf(currentPackageName(), if (isImeVisible()) "ime" else "noime", labels.size.toString(), labels.joinToString("|")).joinToString("::")
  }

  fun waitForImeChange(wasVisible: Boolean, timeoutMs: Long = 1100): Boolean {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (isImeVisible() != wasVisible) return true
      Thread.sleep(40)
    }
    return isImeVisible() != wasVisible
  }

  fun pressBack(): JSONObject {
    currentTree()
    val keyboardWasVisible = isImeVisible()
    val beforePackage = currentPackageName()
    val beforeSignature = screenSignature()
    if (!performGlobalAction(GLOBAL_ACTION_BACK)) {
      return JSONObject().put("ok", false).put("error", "ACTION_FAILED").put("action", "press_back")
    }
    if (keyboardWasVisible) {
      val dismissed = waitForImeChange(wasVisible = true)
      currentTree()
      val afterSignature = screenSignature()
      val screenChanged = contentSignature(afterSignature) != contentSignature(beforeSignature)
      return JSONObject()
        .put("ok", true)
        .put("action", "press_back")
        .put("keyboardWasVisible", true)
        .put("keyboardDismissed", dismissed)
        .put("navigated", false)
        .put("screenChanged", screenChanged)
        .put("shadeOpened", false)
        .put("fromPackage", beforePackage)
        .put("toPackage", currentPackageName())
    }
    Thread.sleep(180)
    var shadeOpened = isNotificationShadeShowing()
    if (shadeOpened) {
      dismissNotificationShade()
      Thread.sleep(120)
      shadeOpened = isNotificationShadeShowing()
      if (shadeOpened) {
        return JSONObject()
          .put("ok", false)
          .put("error", "SHADE_OPENED")
          .put("action", "press_back")
          .put("keyboardWasVisible", false)
          .put("keyboardDismissed", false)
          .put("navigated", false)
          .put("screenChanged", false)
          .put("shadeOpened", true)
      }
      if (!performGlobalAction(GLOBAL_ACTION_BACK)) {
        return JSONObject()
          .put("ok", false)
          .put("error", "ACTION_FAILED")
          .put("action", "press_back")
          .put("keyboardWasVisible", false)
          .put("keyboardDismissed", false)
          .put("navigated", false)
          .put("screenChanged", false)
          .put("shadeOpened", false)
          .put("message", "Dismissed accidental notification shade; second back failed")
      }
      Thread.sleep(180)
      if (isNotificationShadeShowing()) {
        dismissNotificationShade()
        return JSONObject()
          .put("ok", false)
          .put("error", "SHADE_OPENED")
          .put("action", "press_back")
          .put("navigated", false)
          .put("screenChanged", false)
          .put("shadeOpened", true)
      }
    }
    currentTree()
    val afterPackage = currentPackageName()
    val afterSignature = screenSignature()
    val screenChanged = contentSignature(afterSignature) != contentSignature(beforeSignature)
    val packageChanged = afterPackage.isNotBlank() && afterPackage != beforePackage
    return JSONObject()
      .put("ok", true)
      .put("action", "press_back")
      .put("keyboardWasVisible", false)
      .put("keyboardDismissed", false)
      .put("navigated", packageChanged || screenChanged)
      .put("screenChanged", screenChanged)
      .put("shadeOpened", false)
      .put("fromPackage", beforePackage)
      .put("toPackage", afterPackage)
  }

  private fun symbolAliases(query: String): List<String> {
    return when (query.trim().lowercase()) {
      "×", "*", "x" -> listOf("multiply", "times", "multiplication")
      "÷", "/" -> listOf("divide", "division")
      "+" -> listOf("plus", "add")
      "=" -> listOf("equals", "equal")
      "−", "-", "–" -> listOf("minus", "subtract")
      else -> emptyList()
    }
  }

  private fun contentSignature(signature: String): String {
    val parts = signature.split("::")
    return if (parts.size >= 3) parts[0] + "::" + parts.drop(2).joinToString("::") else signature
  }

  fun isNotificationShadeShowing(): Boolean {
    val systemUi = windows.orEmpty().any { window ->
      val root = runCatching { window.root }.getOrNull() ?: return@any false
      val pkg = root.packageName?.toString().orEmpty()
      pkg == "com.android.systemui" && (window.isActive || window.isFocused)
    }
    return systemUi || currentPackageName() == "com.android.systemui"
  }

  fun dismissNotificationShade(): Boolean {
    return if (Build.VERSION.SDK_INT >= 31) {
      performGlobalAction(GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
    } else {
      performGlobalAction(GLOBAL_ACTION_BACK)
    }
  }

  fun isImeVisible(): Boolean {
    return windows.orEmpty().any { window ->
      window.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD
    }
  }

  fun resolveChooser(preferredPackage: String, preferredLabel: String): JSONObject {
    currentTree()
    val justOnce = findElementInMap(text = "Just once") ?: findElementInMap(contentDescription = "Just once")
    val always = findElementInMap(text = "Always") ?: findElementInMap(contentDescription = "Always")
    if (justOnce == null && always == null) {
      return JSONObject().put("ok", false).put("error", "NOT_A_CHOOSER")
    }

    val reserved = setOf("just once", "always", "open with", "use a different app", "complete action using")
    val options = nodeIdMap.entries.mapNotNull { (id, info) ->
      if (isElementStale(info.node) || !info.isClickable) return@mapNotNull null
      val label = info.text.ifBlank { info.contentDescription }.trim()
      if (label.isBlank() || reserved.contains(label.lowercase())) return@mapNotNull null
      JSONObject().put("elementId", id).put("label", label).put("packageName", info.packageName)
    }

    val preferred = options.firstOrNull { option ->
      val pkg = option.optString("packageName")
      val label = option.optString("label")
      (preferredPackage.isNotBlank() && pkg.equals(preferredPackage, ignoreCase = true)) ||
        (preferredLabel.isNotBlank() && label.equals(preferredLabel, ignoreCase = true))
    }

    if (preferred != null) {
      val click = clickElement(preferred.getString("elementId"))
      if (click != FocusClickResult.SUCCESS) {
        return JSONObject().put("ok", false).put("error", click.name).put("options", JSONArray(options))
      }
      currentTree()
      val once = findElementInMap(text = "Just once")
      if (once != null) clickElement(once)
      return JSONObject().put("ok", true).put("selected", preferred).put("choice", "preferred")
    }

    if (preferredPackage.isNotBlank() || preferredLabel.isNotBlank()) {
      return JSONObject()
        .put("ok", false)
        .put("error", "CHOOSER_AMBIGUOUS")
        .put("message", "Preferred target was not listed")
        .put("options", JSONArray(options))
    }

    if (options.size > 1) {
      return JSONObject()
        .put("ok", false)
        .put("error", "CHOOSER_AMBIGUOUS")
        .put("message", "Multiple apps available; pass preferredPackage or preferredLabel")
        .put("options", JSONArray(options))
    }

    val target = justOnce ?: always
    val click = clickElement(target!!)
    return if (click == FocusClickResult.SUCCESS) {
      JSONObject().put("ok", true).put("choice", if (justOnce != null) "just_once" else "always")
    } else {
      JSONObject().put("ok", false).put("error", click.name)
    }
  }

  private fun restartStoredForegroundService() {
    val prefs = getSharedPreferences("jarvis", Context.MODE_PRIVATE)
    val url = prefs.getString(JarvisForegroundService.EXTRA_BRAIN_URL, null) ?: return
    val token = prefs.getString(JarvisForegroundService.EXTRA_AUTH_TOKEN, "") ?: ""
    if (url.isBlank() || url.startsWith("local://") || token.isBlank()) return
    if (JarvisForegroundService.instance != null) return
    ContextCompat.startForegroundService(
      this,
      Intent(this, JarvisForegroundService::class.java)
        .putExtra(JarvisForegroundService.EXTRA_BRAIN_URL, url)
        .putExtra(JarvisForegroundService.EXTRA_AUTH_TOKEN, token),
    )
  }

  fun focusElement(elementId: String): FocusClickResult {
    val resolvedId = resolveElementId(elementId)
    val nodeInfo = nodeIdMap[resolvedId]?.node
    if (nodeInfo == null) return FocusClickResult.ELEMENT_NOT_FOUND
    if (isElementStale(nodeInfo)) {
      nodeIdMap.remove(resolvedId)
      return FocusClickResult.ELEMENT_STALE
    }
    if (!nodeInfo.isEnabled) return FocusClickResult.ELEMENT_DISABLED
    if (!nodeInfo.isFocusable) return FocusClickResult.NOT_FOCUSABLE
    return if (nodeInfo.performAction(AccessibilityNodeInfo.ACTION_FOCUS, null)) {
      FocusClickResult.SUCCESS
    } else {
      FocusClickResult.ACTION_FAILED
    }
  }

  fun clickElement(elementId: String): FocusClickResult = clickElementDetailed(elementId).result

  fun clickElementDetailed(elementId: String, actionId: String = ""): ClickOutcome {
    val resolvedId = resolveElementId(elementId)
    val nodeInfo = nodeIdMap[resolvedId]?.node
    if (nodeInfo == null) return ClickOutcome(FocusClickResult.ELEMENT_NOT_FOUND)
    if (isElementStale(nodeInfo)) {
      nodeIdMap.remove(resolvedId)
      return ClickOutcome(FocusClickResult.ELEMENT_STALE)
    }
    if (!nodeInfo.isEnabled) return ClickOutcome(FocusClickResult.ELEMENT_DISABLED)

    var clickableNode: AccessibilityNodeInfo? = nodeInfo
    while (clickableNode != null && !clickableNode.isClickable) {
      val parent = clickableNode.parent
      if (parent === clickableNode) break
      clickableNode = parent
    }

    val target = clickableNode ?: nodeInfo
    if (target.isClickable && target.performAction(AccessibilityNodeInfo.ACTION_CLICK, null)) {
      android.util.Log.i("JarvisAction", "actionId=$actionId clickMethod=action_click clickCount=1 elementId=$resolvedId")
      return ClickOutcome(FocusClickResult.SUCCESS, "action_click", true)
    }
    if (gestureClick(target)) {
      android.util.Log.i("JarvisAction", "actionId=$actionId clickMethod=gesture clickCount=1 elementId=$resolvedId")
      return ClickOutcome(FocusClickResult.SUCCESS, "gesture", true)
    }
    if (clickableNode == null || !clickableNode.isClickable) return ClickOutcome(FocusClickResult.NOT_CLICKABLE)
    return ClickOutcome(FocusClickResult.ACTION_FAILED)
  }

  private fun gestureClick(node: AccessibilityNodeInfo): Boolean {
    val bounds = Rect().also { node.getBoundsInScreen(it) }
    if (bounds.width() <= 0 || bounds.height() <= 0) return false
    val latch = java.util.concurrent.CountDownLatch(1)
    var ok = false
    tap(bounds.centerX(), bounds.centerY()) { success ->
      ok = success
      latch.countDown()
    }
    return latch.await(800, java.util.concurrent.TimeUnit.MILLISECONDS) && ok
  }

  data class ClickOutcome(
    val result: FocusClickResult,
    val method: String = "",
    val dispatched: Boolean = false,
  )

  enum class FocusClickResult {
    SUCCESS,
    ELEMENT_NOT_FOUND,
    ELEMENT_STALE,
    ELEMENT_DISABLED,
    NOT_FOCUSABLE,
    NOT_CLICKABLE,
    ACTION_FAILED
  }

  private fun dispatch(path: Path, start: Long, duration: Long, callback: (Boolean) -> Unit) {
    val gesture = GestureDescription.Builder()
      .addStroke(GestureDescription.StrokeDescription(path, start, duration))
      .build()
    val accepted = dispatchGesture(
      gesture,
      object : GestureResultCallback() {
        override fun onCompleted(gestureDescription: GestureDescription?) = callback(true)
        override fun onCancelled(gestureDescription: GestureDescription?) = callback(false)
      },
      null,
    )
    if (!accepted) callback(false)
  }

  private fun observeLightweight(event: AccessibilityEvent?) {
    if (event == null) return
    val packageName = event.packageName?.toString().orEmpty()
    if (packageName.isBlank() || packageName == this.packageName) return

    val className = event.className?.toString().orEmpty()
    val now = System.currentTimeMillis()
    when (event.eventType) {
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
        overlayEnsureVisible()
        val packageChanged = packageName != lastPackageName
        val screenChanged = className.isNotBlank() && className != lastClassName
        if (packageChanged || screenChanged || now - lastWindowObservationAt > 10_000L) {
          lastPackageName = packageName
          lastClassName = className
          lastWindowObservationAt = now
          JarvisForegroundService.instance?.sendDeviceObservation(
            if (packageChanged) "app_changed" else "screen_changed",
            packageName,
            className,
            eventTypeName(event.eventType),
            now,
          )
          JarvisForegroundService.instance?.onAccessibilityChanged()
        }
      }
      AccessibilityEvent.TYPE_VIEW_CLICKED,
      AccessibilityEvent.TYPE_VIEW_FOCUSED,
      AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> {
        if (now - lastInteractionObservationAt > 5_000L) {
          lastInteractionObservationAt = now
          JarvisForegroundService.instance?.sendDeviceObservation(
            "user_interaction",
            packageName,
            className,
            eventTypeName(event.eventType),
            now,
          )
        }
      }
      AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
        if (now - lastWindowObservationAt > 15_000L) {
          lastWindowObservationAt = now
          JarvisForegroundService.instance?.sendDeviceObservation(
            "screen_activity",
            packageName,
            className,
            eventTypeName(event.eventType),
            now,
          )
          JarvisForegroundService.instance?.onAccessibilityChanged()
        }
      }
    }
  }

  private fun eventTypeName(type: Int) = when (type) {
    AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> "window_state_changed"
    AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> "window_content_changed"
    AccessibilityEvent.TYPE_VIEW_FOCUSED -> "view_focused"
    AccessibilityEvent.TYPE_VIEW_CLICKED -> "view_clicked"
    AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> "view_text_changed"
    else -> "accessibility_event"
  }

  private fun refreshTree() {
    nodeIdMap.clear()
    nextElementId = 1
    currentTreeVersion++
    val nodes = JSONArray()
    walk(activeContentRoot(), nodes, 0)
    if (nodes.length() == 0) {
      applicationWindows().forEach { window ->
        walk(runCatching { window.root }.getOrNull(), nodes, 0)
      }
    }
    latestTree = nodes.toString()
    latestPackageName = activeContentRoot()?.packageName?.toString().orEmpty()
    latestTreeAt = System.currentTimeMillis()
  }

  fun lastTreeNodeCount(): Int = runCatching { JSONArray(latestTree).length() }.getOrDefault(0)

  fun treeObservationReason(): String {
    val count = lastTreeNodeCount()
    if (count > 0) return ""
    val pkg = currentPackageName()
    if (pkg.isBlank()) return "NO_ACTIVE_WINDOW"
    return "EMPTY_TREE"
  }

  private fun applicationWindows(): List<AccessibilityWindowInfo> {
    val ownPackage = applicationContext.packageName
    return windows.orEmpty().filter { window ->
      if (window.type != AccessibilityWindowInfo.TYPE_APPLICATION) return@filter false
      val root = runCatching { window.root }.getOrNull() ?: return@filter false
      val packageName = root.packageName?.toString().orEmpty()
      packageName.isNotBlank() && packageName != ownPackage && packageName != "com.android.systemui"
    }
  }

  private fun activeContentRoot(): AccessibilityNodeInfo? {
    val ownPackage = applicationContext.packageName
    val applicationRoots = applicationWindows()
      .sortedWith(
        compareByDescending<AccessibilityWindowInfo> { it.isActive }
          .thenByDescending { it.isFocused },
      )
      .mapNotNull { runCatching { it.root }.getOrNull() }
    if (applicationRoots.isNotEmpty()) return applicationRoots.first()

    val orderedWindows = windows.orEmpty()
      .filter { it.type != AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY && it.type != AccessibilityWindowInfo.TYPE_INPUT_METHOD }
      .sortedWith(
        compareByDescending<AccessibilityWindowInfo> { it.isActive }
          .thenByDescending { it.isFocused },
      )

    return orderedWindows
      .mapNotNull { runCatching { it.root }.getOrNull() }
      .firstOrNull { root ->
        val packageName = root.packageName?.toString().orEmpty()
        packageName.isNotBlank() && packageName != ownPackage && packageName != "com.android.systemui"
      }
      ?: rootInActiveWindow
      ?: orderedWindows.mapNotNull { runCatching { it.root }.getOrNull() }.firstOrNull()
  }

  private fun walk(node: AccessibilityNodeInfo?, output: JSONArray, depth: Int): AndroidNodeInfo? {
    if (node == null || depth > MAX_TREE_DEPTH || output.length() >= MAX_TREE_NODES) return null

    val bounds = Rect().also { node.getBoundsInScreen(it) }
    val text = node.text?.toString().orEmpty()
    val description = node.contentDescription?.toString().orEmpty()
    val hasLabel = text.isNotBlank() || description.isNotBlank()
    val isUsefulControl = node.isClickable || node.isEditable || node.isCheckable || node.isFocusable
    val hasVisibleBounds = bounds.width() > 0 && bounds.height() > 0
    val elementId = if ((hasVisibleBounds || hasLabel) && (hasLabel || isUsefulControl || depth <= 1)) {
      val id = generateElementId(nextElementId)
      nextElementId = nextElementId + 1
      val androidNode = AndroidNodeInfo(node)
      nodeIdMap[id] = androidNode
      fingerprints[id] = NodeFingerprint(
        text = text,
        contentDescription = description,
        resourceId = node.viewIdResourceName.orEmpty(),
        className = node.className?.toString().orEmpty(),
      )
      id
    } else null

    if (elementId != null) {
      output.put(JSONObject().apply {
        put("elementId", elementId)
        put("text", text)
        put("contentDescription", description)
        put("className", node.className?.toString().orEmpty())
        put("packageName", node.packageName?.toString().orEmpty())
        put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
        put("clickable", node.isClickable)
        put("editable", node.isEditable)
        put("focusable", node.isFocusable)
        put("focused", node.isFocused)
        put("enabled", node.isEnabled)
      })
    }

    for (index in 0 until node.childCount) walk(node.getChild(index), output, depth + 1)
    return null
  }

  data class NodeFingerprint(
    val text: String,
    val contentDescription: String,
    val resourceId: String,
    val className: String,
  ) {
    fun isEmpty() = text.isBlank() && contentDescription.isBlank() && resourceId.isBlank()
    fun matches(info: AndroidNodeInfo): Boolean {
      if (resourceId.isNotBlank() && info.resourceId == resourceId) {
        return text.equals(info.text, ignoreCase = true) && contentDescription.equals(info.contentDescription, ignoreCase = true)
      }
      if (text.isBlank() && contentDescription.isBlank()) return false
      return text.equals(info.text, ignoreCase = true) &&
        contentDescription.equals(info.contentDescription, ignoreCase = true) &&
        className.equals(info.className, ignoreCase = true)
    }
  }

  public data class AndroidNodeInfo(val node: AccessibilityNodeInfo) {
    val text: String
      get() = node.text?.toString().orEmpty()
    val className: String
      get() = node.className?.toString().orEmpty()
    val packageName: String
      get() = node.packageName?.toString().orEmpty()
    val resourceId: String
      get() = node.viewIdResourceName?.toString().orEmpty() ?: ""
    val contentDescription: String
      get() = node.contentDescription?.toString().orEmpty()
    val isClickable: Boolean
      get() = node.isClickable
    val isEditable: Boolean
      get() = node.isEditable
    val isFocusable: Boolean
      get() = node.isFocusable
    val isFocused: Boolean
      get() = node.isFocused
    val isEnabled: Boolean
      get() = node.isEnabled
  }

  fun dismissKeyboard(): Boolean {
    return performGlobalAction(GLOBAL_ACTION_BACK)
  }

  fun goHome(): Boolean {
    return performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
  }

  fun pressEnter(): Boolean {
    val focused = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (focused.performAction(0x00002000)) return true // ACTION_IME_ENTER
    }
    val root = rootInActiveWindow ?: return false
    val labels = listOf("search", "go", "done", "next", "enter")
    fun walk(node: AccessibilityNodeInfo?): Boolean {
      if (node == null) return false
      val text = node.text?.toString().orEmpty()
      val desc = node.contentDescription?.toString().orEmpty()
      val label = (if (desc.isNotBlank()) desc else text).lowercase()
      if (labels.any { label == it } && node.isClickable && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
        return true
      }
      for (i in 0 until node.childCount) {
        if (walk(node.getChild(i))) return true
      }
      return false
    }
    return walk(root)
  }

  // Handle incoming action messages from the brain
  fun handleAction(action: String, args: JSONObject?): Boolean {
    return when (action) {
      "focus_element" -> {
        val elementId = args?.getString("elementId") ?: return false
        focusElement(elementId) == FocusClickResult.SUCCESS
      }
      "click_element" -> {
        val elementId = args?.getString("elementId") ?: return false
        clickElement(elementId) == FocusClickResult.SUCCESS
      }
      "type_text" -> {
        val text = args?.getString("text") ?: return false
        val elementId = args?.getString("elementId")
        type(text, elementId) == TypeResult.SUCCESS
      }
      else -> false
    }
  }
}