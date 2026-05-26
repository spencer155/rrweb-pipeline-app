# RRWeb 视频导出

一个基于 Electron 的本地桌面工具，用于将 rrweb 录制产生的 JSON 文件批量导出为 MP4，并按 JSON 顺序自动合并为一个视频文件。

## 功能特性

- 选择包含 `*.json` 的工作文件夹后，一键执行转换流程
- 自动跳过 `package.json`、`package-lock.json`、`tsconfig.json`、`rrvideo.defaults.json` 和 `*.config.json`
- 支持设置导出帧率：`10 fps`、`15 fps`、`24 fps`
- 支持设置并发数：`1`、`2`、`4`
- 使用 `ffmpeg-static` 内置 ffmpeg，无需额外安装系统 ffmpeg
- macOS 下优先使用 `h264_videotoolbox` 硬件编码
- 导出完成后自动将成功生成的片段合并为一个 MP4
- 界面展示实时日志和进度

## 技术栈

- Electron
- Node.js CommonJS
- rrvideo
- ffmpeg-static
- electron-builder

## 目录结构

```text
.
├── main.cjs                 # Electron 主进程，负责文件扫描、转换、合并和打包路径处理
├── preload.cjs              # 安全暴露 IPC API 给渲染进程
├── renderer/                # 页面、样式和交互逻辑
├── vendor/                  # 本地依赖包
├── entitlements.mac.plist   # macOS 打包权限配置
├── package.json             # 项目脚本、依赖和 electron-builder 配置
└── package-lock.json        # npm 锁定文件
```

## 环境要求

- Node.js 18 或更高版本
- npm

如果需要执行 macOS 打包，建议在 macOS 环境中运行对应命令。

## 安装依赖

```bash
npm install
```

项目依赖 `vendor/rrvideo-0.2.1.tgz` 这个本地包，请确保该文件存在后再安装依赖。

## 本地 rrvideo 包说明

`vendor/rrvideo-0.2.1.tgz` 是从 `local-rrvideo` 项目打包出来的本地依赖包，当前项目通过 `package.json` 中的 `file:vendor/rrvideo-0.2.1.tgz` 引用它。

当 `local-rrvideo` 有代码变更时，需要在 `local-rrvideo` 项目中重新打包，并将新的 `.tgz` 文件复制到当前项目的 `vendor/` 目录。如果文件名或版本号发生变化，需要同步更新当前项目 `package.json` 中的 `rrvideo` 依赖路径，然后重新安装依赖。

常见更新流程：

```bash
# 在 local-rrvideo 项目中执行
npm pack

# 将生成的 rrvideo-*.tgz 复制到本项目 vendor/ 目录
# 如文件名变化，同步修改 package.json 中的 rrvideo 依赖路径

# 回到本项目重新安装依赖
npm install
```

## 本地运行

```bash
npm start
```

启动后在界面中选择一个工作文件夹。该文件夹中应放置 rrweb 导出的 JSON 文件。

## 使用说明

1. 点击“浏览...”选择包含 rrweb JSON 的文件夹。
2. 确认或修改合并后的 MP4 文件名。
3. 选择帧率和并发数。
4. 点击“开始”执行导出。
5. 转换完成后，应用会按 JSON 文件排序顺序自动合并成功导出的 MP4 片段。

转换过程中会在界面右侧显示日志和进度。单个 JSON 转换失败时会记录错误，并继续处理其他文件。

## 可选配置

可以在工作文件夹中放置 `rrvideo.defaults.json`，用于覆盖默认的 rrvideo / ffmpeg 配置。应用会在运行时将该配置与界面选择的帧率、自动探测的编码器配置合并。

示例：

```json
{
  "renderDelayMs": 10,
  "ffmpeg": {
    "bitrate": "4M"
  }
}
```

## 打包

生成未压缩的应用目录：

```bash
npm run pack
```

生成正式安装包：

```bash
npm run dist
```

仅构建 macOS arm64：

```bash
npm run dist:arm64
```

仅构建 macOS x64：

```bash
npm run dist:x64
```

构建 Windows x64 安装包：

```bash
npm run dist:win
```

打包产物默认输出到 `release/` 目录。

## 注意事项

- 输入目录中的 JSON 文件会按数字文件名优先排序，例如 `1.json`、`2.json`、`10.json`。
- 合并视频时只会合并转换成功的片段。
- 如果生成的片段编码参数不一致，ffmpeg 直接合并可能失败，需要先重编码后再合并。
- 不建议将输入 JSON、生成的 MP4 或打包产物提交到仓库。

