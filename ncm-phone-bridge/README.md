# 歌词桥 · 手机版（NcmPhoneBridge）

把**安卓手机正在播放的音乐**（歌名 / 歌手 / 封面 / 进度）实时变成一个小型局域网服务，
**平板 / 电脑浏览器**直接打开就能看**动态歌词** —— 全程**不需要电脑**，也**不需要开 USB 调试**。

## 它解决什么问题

原来的方案：手机 →（adb / 无线调试）→ 电脑（Node 服务）→ 平板。
需要一直开着开发者选项与无线调试，权限面也偏大。

本 App 把"读播放信息 + 提供网页服务"整体搬进手机内部：
**手机 App →（HTTP）→ 平板 / 电脑**，adb 彻底不需要了。

**v1.5 起，平板上的切歌与收藏也不再需要电脑**：控制条在手机内置页面里，
收藏用的网易云账号（扫码登录 + weapi 加密）同样跑在手机上。
换句话说：**手机 + 平板，两台设备就够了。**

## 工作原理

```
手机 App（前台服务）
  ├─ 通过「通知使用权」读取当前播放的媒体会话（MediaSession）
  │     · 歌名 / 歌手 / 专辑 / 时长 / 播放进度 / 封面位图
  ├─ 内置 HTTP 服务（默认端口 8787，纯手写、零第三方依赖）
  │     · /            歌词显示页（大字歌词 + 动效，可自定义）
  │     · /api/state   播放状态 + 已匹配的 LRC 歌词
  │     · /api/search  网易云搜索（用于手动纠正匹配）
  │     · /api/cover   封面代理（解决跨域）
  └─ 内置背景线程：歌曲变化时按「歌名+歌手+时长」去网易云匹配歌词
平板 / 电脑浏览器 ── HTTP ──▶ 手机
```

## 安装

1. 把 `app-debug.apk` 传到手机（微信/QQ/网盘/数据线均可），点击安装
   - 首次会提示"未知来源"，允许即可
2. 打开 App「歌词桥」

## 使用（3 步）

1. **授权**：点「去授权（通知使用权）」，在系统设置里找到「歌词桥」并打开开关
   - 这是安卓的硬性要求：只有拿到这个权限，App 才能读到"正在播放什么"
2. **启动服务**：点「启动服务」，App 会显示一个地址，例如 `http://192.168.1.23:8787`
3. **平板打开**：平板连上**同一个 Wi-Fi**，浏览器打开上面那个地址

之后手机放歌，平板页面就会显示封面 + 逐行高亮歌词 + 进度。

### 在平板上切歌 / 收藏（v1.5）

封面与进度条下面有一条半透明的控制条：**上一首 · 播放暂停 · 下一首 · 红心**。
它平时是暗的，手指碰一下会亮 3 秒，不抢歌词。

- **切歌 / 播放暂停**：指令直接从平板发回手机，由 App 用「通知使用权」拿到的
  MediaController 下发给正在播放的音乐 App。不经过电脑。
- **收藏**：点红心 → 设置面板里出二维码 → 用**手机上的网易云 App** 扫一下确认。
  二维码是手机向网易云申请的，登录态也只存在手机里；之后长期有效，不用反复扫。
- 设置里可以整条关掉控制条（「显示控制条」开关）。

> 为什么收藏要先登录：它写的是账号数据，必须带登录态。歌词、封面、切歌都不需要。

> **电脑也可以看（两种方式）**：
>
> - **推送（v1.1 新增，推荐）**：App 里「可选 · 推送到电脑」填入电脑地址，手机会主动把播放状态
>   推给电脑。电脑端把 `config.json` 的 `phoneUrl` 留空、`source` 保持 `auto`，双击 `start.bat` 即可 ——
>   网页和 BetterLyrics 都能显示，**手机 IP 怎么变都不影响**（手机是主动方，不需要被找到）。
> - **拉取**：把 App 显示的地址填进 `config.json` 的 `phoneUrl`，电脑主动来拉。
>   缺点是手机 IP 变了要重填。
>
> 详见桌面版 README 的「最省事的用法：手机 App 直连」。

## 授权时提示「出于安全考虑，此设置目前暂不可用」怎么办

这是安卓 13+ 的**受限设置（Restricted Settings）**机制在起作用，**不是 App 有问题**：
系统默认禁止从浏览器 / 文件管理器等"非应用商店"渠道安装的应用开启无障碍、通知使用权这类高权限
（目的是防诈骗）。

### 解法一：允许受限设置（推荐）

1. 先照常去开「通知使用权」，**让它失败一次** —— 系统要见你点过一次，才会放出下面的选项
2. 回到 **设置 → 应用 → 应用管理 → 歌词桥**
3. 点右上角 **⋮**（部分机型叫「更多」，或在页面底部）
4. 选「**允许受限设置**」（也可能叫「允许此来源的应用设置」「解除限制」）
5. 再回去把「通知使用权」打开，这次就能开了

各机型差异：

- **vivo / iQOO**：设置 → 更多设置 → 权限管理 → 找到「歌词桥」→ 右上角「…」→ 允许受限设置
- **小米 / 红米**：除上面步骤外，还需在开发者选项里打开「USB 调试（安全设置）」
- 找不到入口时，直接在设置顶部搜「**受限**」或「**特殊权限**」，多数 ROM 能跳到对应页面

### 解法二：用 adb 一条命令直接授权（如果还能连 adb）

```bash
adb shell cmd notification allow_listener com.ncm.phonebridge/com.ncm.phonebridge.MediaNotificationListener
```

执行后无需再操作系统设置界面。

## 注意事项

- **必须同一个局域网**（同一个 Wi-Fi / 同一路由器）。
- **显示页的个性化设置会自动存在手机里**（App 内的 `/api/prefs`），所以手机 IP 变了、或换设备打开，
  字号 / 字体 / 布局这些设置都不会丢。设置面板底部还有「复制当前设置 / 粘贴恢复」可跨设备迁移。
- 手机息屏后系统可能暂停服务，建议在系统设置里把「歌词桥」加入**电池优化白名单**，
  这样锁屏放歌也能持续供数据。
- 歌词匹配靠"歌名 + 歌手"模糊搜索，冷门翻唱偶尔会认错；
  页面设置里可用「标题匹配」手动搜索并指定正确的歌曲。
- 歌词/封面来自网易云**公开接口**，属于非官方用法，接口变动时可能暂时失效（会自动降级为只显示歌名）。

## 接口一览（供二次开发）

| 路径 | 说明 |
|---|---|
| `GET /` | 歌词显示页（含全部个性化设置） |
| `GET /api/state` | `{status, track, lyrics[], anchor}`，前端每 1 秒轮询 |
| `GET /api/nowplaying` | 精简版：`{title, artist, album, positionMs, durationMs, playing}` |
| `GET /api/search?q=` | 网易云搜索，返回 `{songId, title, artist, album, duration}` |
| `POST /api/pin` | `{songId}` 手动指定当前曲目对应的歌曲 |
| `POST /api/refresh` | 清空匹配缓存，重新匹配 |
| `GET /api/cover?url=` | 封面代理（仅放行网易云图床域名） |
| `GET /api/art` | 当前曲目的封面位图（JPEG） |
| `GET /api/info` | 运行状态 |
| `POST /api/control` | **v1.4**：`{"action":"next"\|"prev"\|"toggle"\|"play"\|"pause"}`，用通知使用权拿到的 MediaController 下发指令（也支持 `?action=next`，方便 curl） |
| `GET /api/account` | 网易云登录状态：`{loggedIn, nickname, likedKnown}`，**不含任何凭据** |
| `POST /api/account/qr` | **v1.5**：向网易云申请登录二维码，返回 `{key, url}`，`url` 给页面渲染成二维码 |
| `GET /api/account/qr?key=` | **v1.5**：轮询扫码结果，`800` 过期 / `801` 等待 / `802` 待确认 / `803` 成功 |
| `POST /api/account/logout` | **v1.5**：退出登录，删除 App 内的登录态 |
| `POST /api/like` | **v1.5**：`{"songId":123,"liked":true}` 加入 / 移出「我喜欢的音乐」 |

所有接口都带 `Access-Control-Allow-Origin: *`，可被任意局域网页面直接调用。

> `/api/control` 依赖「通知使用权」：没有它拿不到 MediaController。
> Android 不回报播放器是否真的执行了（`skipToNext()` 返回 void），所以 `ok:true`
> 只代表指令已发出。错误码：`no-listener` / `no-session` / `no-manager` / `bad-action` / `exception`。
>
> `/api/account/*` 与 `/api/like` 走的是网易云网页端私有接口（weapi，AES + RSA），
> 属于个人使用的自动化。对方调整时可能失效 —— 失效只影响收藏，歌词不受影响。

## 与桌面版的关系

`ncm-nowplaying`（桌面版）仍然可用。做完本 App 后，桌面版也可以把数据源从
`adb` 换成 `HTTP`（直接 `GET` 手机的 `/api/nowplaying`），从而**不再需要平台工具与无线调试**。

## 技术要点

- **零第三方依赖**：只用 Android SDK 与 Kotlin 标准库；HTTP 服务用 `ServerSocket` 手写。
- **鉴权**：不设密码，仅监听局域网。属于家用可信网络场景；如需公网暴露请自行加反向代理与鉴权。
- **端口**：默认 `8787`（可通过 `BridgeService.PORT` 修改）。

## 从源码构建

需要 JDK 17、Android SDK（compileSdk 34 / build-tools 34.0.0），Gradle 由 wrapper 自带。

```bash
# local.properties 里写本机 SDK 路径（该文件不入库）
echo 'sdk.dir=/path/to/Android/sdk' > local.properties

./gradlew assembleDebug        # 产物：app/build/outputs/apk/debug/app-debug.apk
```

Gradle 发行版从 `services.gradle.org` 下载较慢时，可临时把
`gradle/wrapper/gradle-wrapper.properties` 里的 `distributionUrl` 换成
`https://mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip`。

