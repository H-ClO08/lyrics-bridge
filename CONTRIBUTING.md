# 贡献指南

> **English speakers:** this guide is written in Chinese. The essentials — **zero third-party
> dependencies is a hard rule**, run `node test/selftest.js` before opening a PR, use
> `type: summary` commit messages, attach before/after screenshots for layout changes, and never
> commit `.cache/`, `local.properties` or APKs. Issues and PRs in English are welcome.

很高兴你愿意参与。这个项目很小，流程保持简单。

## 提 Issue 之前

- 先搜一下已有 issue，避免重复
- 手机端问题请带上：**安卓版本、手机型号、App 版本号**（设置页可见）
- 歌词匹配不到某个歌，请提供 **歌名 + 歌手 + 专辑**
- 报错信息请贴完整日志，不要只贴最后一行

## 开发环境

| 部分 | 要求 |
|---|---|
| 手机端 | JDK 17、Android SDK（compileSdk 34 / build-tools 34.0.0），Gradle 用仓库自带 wrapper |
| 电脑端 | Node.js 18+，**不要引入第三方依赖** |

```bash
# 手机端
cd ncm-phone-bridge
echo 'sdk.dir=/path/to/Android/sdk' > local.properties
./gradlew assembleDebug

# 电脑端（零依赖，无需 npm install）
cd ncm-nowplaying
node src/server.js --source=mock
node test/selftest.js        # 自检
```

没有手机也能开发：`--source=mock` 会跑一个模拟播放源，网页完整可用。

## 代码约定

- **零第三方依赖是硬约束**。手机端 HTTP 服务用 `ServerSocket` 手写，电脑端只用 Node 内置模块。
  引入依赖的 PR 需要先开 issue 说明理由。
- 手机端用 Kotlin，`Weapi.java` 保持纯 Java（不依赖 Android API），这样可以用 `javac` 单独验证加密逻辑。
- 网页是单文件 `index.html`，不要拆成构建流程。
- 注释写「为什么」，不写「做了什么」。
- 布局改动请附**修改前后截图**，并说明在哪些尺寸下验证过（平板竖屏 / 横屏 / 分屏）。

## 提交信息

用 `类型: 简述` 的格式，正文用中文说明动机：

```
fix: 分屏下歌词区高度算成 0

grid 的 1fr 最小值是内容高度，头部一高就把歌词压没了。
改成 minmax(0,1fr)，横幅布局下再给 .right 补 height:100%。
```

类型：`feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `chore`。

## 提交 PR

1. 从 `main` 切分支，一个 PR 只做一件事
2. 本地跑通自检（电脑端 `node test/selftest.js`），手机端至少手动装一次
3. PR 描述里写：改了什么、为什么改、怎么验证的
4. 涉及界面的加截图

## 不要提交这些

`.cache/`（含账号 Cookie）、`local.properties`、`build/`、`tools/platform-tools/`、历史版本 APK。
`.gitignore` 已覆盖，提交前用 `git status` 确认一眼。
