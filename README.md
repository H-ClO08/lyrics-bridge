# 歌词桥 · LyricsBridge

[English](README.en.md) | **简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/H-ClO08/lyrics-bridge?color=blue.svg)](https://github.com/H-ClO08/lyrics-bridge/releases)
[![Platform](https://img.shields.io/badge/platform-Android%208.0%2B%20%7C%20Node%2018%2B-blue.svg)](#快速开始)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](CONTRIBUTING.md)

把**安卓手机上正在播放的网易云音乐**，实时变成**平板 / 电脑浏览器上的动态歌词**，
并且在平板和电脑上就能**切歌、暂停、收藏** —— 不需要电脑当中转，也不需要开 USB 调试。

> 手机上放歌，平板上看歌词、点红心。两台设备就够了。

---

## 两个子项目

| 目录 | 是什么 | 需要什么 |
|---|---|---|
| [`ncm-phone-bridge/`](ncm-phone-bridge/) | **手机端 App**（Android）。读取本机播放状态，内置 HTTP 服务，自己是数据源 | 一台 Android 8.0+ 手机，装 APK |
| [`ncm-nowplaying/`](ncm-nowplaying/) | **电脑端服务**（Node.js）。ADB / 推送 / SMTC 三种取数方式，自带浏览器歌词页 | Node.js 18+，零第三方依赖 |

两者可以**独立使用**，也可以串起来用：

```
手机（网易云音乐）
   │  通知使用权 → MediaSession
   ▼
歌词桥 App ── HTTP :8787 ──▶ 平板 / 电脑浏览器
   │                          歌词页 + 播放控制条
   └──▶ 网易云接口（歌词匹配 / 收藏 / 扫码登录）
```

手机端是**默认推荐的链路**：adb 完全不需要，权限面最小。
电脑端适合已经在用 ADB、或者想让 BetterLyrics 这类桌面歌词软件接管显示的场景。

---

## 快速开始

### 方案一：只装手机 App（推荐）

1. 下载 [`ncm-phone-bridge-v1.5.6.apk`](https://github.com/H-ClO08/lyrics-bridge/releases/download/v1.5.6/ncm-phone-bridge-v1.5.6.apk) 并安装
2. 打开 App，按提示授予**通知使用权**（读播放状态必需）
3. 平板 / 电脑浏览器打开 App 首页显示的地址，例如 `http://192.168.1.23:8787`
4. 想用平板收藏和切歌 → App 内扫码登录网易云账号

完整说明见 [手机端 README](ncm-phone-bridge/README.md)。

### 方案二：电脑端服务

```bash
cd ncm-nowplaying
node src/server.js          # 默认 http://localhost:8787
node src/server.js --source=mock   # 没有手机也能先看效果
```

三种取数方式（ADB 轮询 / HTTP 推送 / 伪装成 Windows 媒体会话给 BetterLyrics）见
[电脑端 README](ncm-nowplaying/README.md)。

---

## 能做什么

- **逐行 / 逐字歌词**：按「歌名 + 歌手 + 时长」到网易云匹配，封面、进度、翻译一并显示；有 YRC 的曲目做逐字高亮
- **平板直控**：上一首 / 播放暂停 / 下一首 / 红心收藏，全部走手机本地，不经过电脑
- **响应式布局**：分屏、横幅、竖屏三种布局，控制条与封面居中对齐，页面锁定不滚动
- **零第三方依赖**：手机端纯 Java/Kotlin 手写 HTTP 服务；电脑端只用 Node 内置模块
- **界面可调**：字号、主题、模糊、歌词偏移等，配置存本地

---

## 权限与隐私

| 权限 | 用途 | 是否必须 |
|---|---|---|
| 通知使用权 | 读取当前媒体会话（歌名/歌手/进度/封面） | 是 |
| 局域网访问 | 给平板提供歌词页 | 是 |
| 网易云账号（扫码登录） | 收藏（红心）与需要登录态的接口 | 否，仅收藏需要 |

- 登录 Cookie 只存在手机本地（`SharedPreferences`），**不会**下发给浏览器页面
- 电脑端的登录态与歌词缓存写在 `.cache/`，已在 `.gitignore` 中排除
- 歌词页仅监听局域网，不做公网穿透；接口对写操作做了来源校验

---

## 目录结构

```
.
├── ncm-phone-bridge/        # Android App
│   ├── app/src/main/java/com/ncm/phonebridge/
│   │   ├── BridgeService.kt        前台服务 + 媒体监听
│   │   ├── BridgeHttpServer.kt     内置 HTTP 服务与路由
│   │   ├── NeteaseAccount.kt       扫码登录 / 收藏
│   │   └── Weapi.java              网易云 weapi 加密（纯 Java）
│   ├── app/src/main/assets/index.html   手机内置歌词页
│   └── ncm-phone-bridge-v1.5.6.apk      当前发布版
└── ncm-nowplaying/          # Node.js 电脑端
    ├── src/                 服务、Hub、歌词匹配、来源适配
    ├── public/index.html    浏览器歌词页
    ├── smtc/                Windows 媒体会话桥（PowerShell）
    ├── tools/               自检、延迟测量、安全体检
    └── test/                自检用例
```

---

## 已知限制

- 仅适配**网易云音乐**的媒体会话与歌词源，其它播放器需要自行改匹配逻辑
- 手机与平板需在**同一局域网**；部分路由器的 AP 隔离会阻断直连
- 通知使用权在部分定制 ROM 上被限制，需要「允许受限设置」
- 歌词匹配依赖网易云搜索接口，冷门曲目可能匹配不到，可在页面上手动纠正

## 贡献

欢迎 issue 与 PR —— 先读 [贡献指南](CONTRIBUTING.md)。安全问题请按 [安全策略](SECURITY.md) 私密报告，不要开公开 issue。

## 许可证

代码以 [MIT](LICENSE) 授权，© 2026 H-ClO08。你可以自由使用、修改、商用、闭源分发，只需保留版权声明。

**歌词、封面与歌曲元数据的版权归各自权利人**，不在本项目的授权范围内。本项目与网易云音乐官方无关，
是一个个人自用的局域网投屏工具，请勿用它分发这些内容。
