package com.wacilimonster.dyapp

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

/**
 * 返回键协议：
 *  - 页面注册了 window.__dyBack() 就把决定权交给它（返回 true = 已消费）；
 *  - 页面没注册 / 返回 false（连按两次表示确认退出）→ 走系统默认（结束 Activity）。
 * 层次收起的顺序（弹层 → 抽屉 → 全屏页 → 双按退出）全部在 app.js 里维护，
 * Kotlin 侧只做转发，避免两处各维护一份状态。
 */
class MainActivity : TauriActivity() {
  private var dyWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    dyWebView = webView
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val w = dyWebView
        if (w == null) {
          finish()
          return
        }
        w.evaluateJavascript("(window.__dyBack ? window.__dyBack() : false)") { result ->
          if (result != "true") finish()
        }
      }
    })
  }
}
