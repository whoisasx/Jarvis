package com.yourname.jarvis

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

object JarvisFlowLog {
  private const val TAG = "JarvisFlow"
  private const val MAX_ENTRIES = 400
  private val worker = Executors.newSingleThreadExecutor()
  @Volatile private var filesDir: File? = null

  fun attach(context: Context) {
    filesDir = context.applicationContext.filesDir
  }

  fun event(
    step: String,
    phase: String,
    detail: String,
    flowId: String = "",
    taskId: String = "",
    error: String? = null,
    extra: Map<String, Any?> = emptyMap(),
  ) {
    val payload = JSONObject()
      .put("ts", System.currentTimeMillis())
      .put("flowId", flowId)
      .put("taskId", taskId)
      .put("step", step)
      .put("phase", phase)
      .put("detail", redact(detail))
    if (!error.isNullOrBlank()) payload.put("error", redact(error))
    extra.forEach { (key, value) ->
      if (value != null) payload.put(key, redact(value.toString()))
    }
    val line = payload.toString()
    Log.i(TAG, line)
    persist(line)
  }

  fun appendJson(raw: String) {
    persist(redact(raw).replace('\n', ' '))
  }

  fun recent(limit: Int = 80): String {
    val file = logFile() ?: return "[]"
    if (!file.exists()) return "[]"
    return runCatching {
      val lines = file.readLines().takeLast(limit.coerceAtLeast(1))
      "[${lines.joinToString(",")}]"
    }.getOrDefault("[]")
  }

  private fun persist(line: String) {
    val file = logFile() ?: return
    worker.execute {
      runCatching {
        file.parentFile?.mkdirs()
        file.appendText(line.trim() + "\n")
        trim(file)
      }
    }
  }

  private fun trim(file: File) {
    val lines = file.readLines()
    if (lines.size <= MAX_ENTRIES) return
    file.writeText(lines.takeLast(MAX_ENTRIES).joinToString("\n") + "\n")
  }

  private fun logFile(): File? {
    val root = filesDir ?: return null
    return File(root, "jarvis_logs/flow.jsonl")
  }

  private fun redact(value: String): String {
    var next = value
    listOf(
      Regex("(?i)(api[_-]?key|token|authorization|bearer)\\s*[:=]\\s*[^\\s\"']+"),
      Regex("(?i)cursor_[a-z0-9]{16,}"),
      Regex("(?i)\\bsk-[a-z0-9_-]{8,}"),
    ).forEach { pattern ->
      next = pattern.replace(next, "***")
    }
    return next.take(4000)
  }
}
