# Interaction Predictor MVP

一个最小闭环模块：从 HTTP/RTMP/本地摄像头拉流，把全局画面低频输入 Kimi 多模态模型生成场景结构化信息，用 YOLO 高频识别画面中央兴趣物，再融合二者预测前三个潜在交互行为。

## 快速启动

```bash
cp .env.example .env
# 编辑 .env，填入 MOONSHOT_API_KEY 和 CAMERA_URL
./scripts/start.sh
```

启动后打开：

```text
http://127.0.0.1:8000/
```

控制台页面可以测试所有接口，包括健康检查、摄像头快照、摄像头检测/切换、最新场景、中心兴趣物、最新预测和历史记录。

## 本机一键部署

后台部署并自动重启已有实例：

```bash
MOONSHOT_API_KEY=你的 Kimi API Key \
CAMERA_URL=/tmp/interaction-predictor-demo/demo.mp4 \
./scripts/deploy.sh
```

如果已经把配置写入 `.env`，直接运行：

```bash
./scripts/deploy.sh
```

默认使用 `nohup` 后台进程，适合本地 MVP 演示。
如果要改成 macOS LaunchAgent 托管，可以使用 `USE_LAUNCHD=1 ./scripts/deploy.sh`，但项目放在 `Documents`、`Desktop` 等受 macOS 隐私保护的目录时，需要给对应进程完整磁盘访问权限，或者把项目移动到不受保护的开发目录。

查看日志和停止服务：

```bash
tail -f runtime/server.log
./scripts/stop.sh
```

默认 LLM provider：

```text
kimi
```

默认模型：

```text
文本推理：kimi-k2.6
全局看图：kimi-k2.5
```

默认 Kimi API 地址：

```text
https://api.moonshot.cn/v1
```

## 常用配置

```bash
MOONSHOT_API_KEY=你的 Kimi API Key \
KIMI_MODEL=kimi-k2.6 \
KIMI_VISION_MODEL=kimi-k2.5 \
CAMERA_URL=rtmp://example/live/stream \
SCENE_INPUT_MODE=image \
python -m interaction_predictor
```

也可以不使用脚本，手动启动：

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
export MOONSHOT_API_KEY="你的 Kimi API Key"
python -m interaction_predictor --camera-url 0
```

也支持 `KIMI_API_KEY`，优先级低于 `MOONSHOT_API_KEY`。

## 摄像头输入源

支持这些输入：

```text
本机摄像头 index：0、1、2...
macOS AVFoundation：avfoundation:0、avfoundation:1...
浏览器摄像头：前端里选择“浏览器摄像头授权/检测”后出现
HTTP/RTSP/RTMP：rtmp://example/live/stream
本机测试视频：/tmp/interaction-predictor-demo/demo.mp4
```

控制台会调用 `GET /camera/sources` 检测本机摄像头和 demo 视频，并可通过 `POST /camera/source` 在线切换，不需要重启服务。

相关环境变量：

```bash
CAMERA_URL=0
CAMERA_PROBE_COUNT=6
CAMERA_DEMO_VIDEO=/tmp/interaction-predictor-demo/demo.mp4
OPENCV_AVFOUNDATION_SKIP_AUTH=0
```

macOS 上如果 `GET /camera/sources` 只看到测试视频，通常是当前 Python/终端进程没有摄像头权限，或者系统没有暴露可读的本机摄像头设备。
如果 Photo Booth 可用但页面持续 offline，优先在前端使用“浏览器摄像头授权/检测”。浏览器会单独请求摄像头权限，拿到帧后通过 `/camera/browser-frame` 送回本地后端。

切换摄像头源时，当前帧缓存、YOLO 兴趣物状态、场景历史和预测历史会被清空，避免旧输入源的数据污染新输入源。

`SCENE_INPUT_MODE` 支持：

- `image`：默认模式。每 15 秒把压缩后的全局画面直接传给 Kimi 多模态模型。
- `detections`：备用模式。只把当前 YOLO 检测文本交给模型，不建议作为主方案。

YOLO 在默认架构里只用于高频检测画面中央的兴趣物体，不参与全局场景理解。
融合预测不会在兴趣物每次变化时立刻触发。默认要求中心兴趣物在最近 2 秒窗口内保持稳定，且同一目标匹配比例达到 0.75，才会调用大模型预测第一人称视角下“我在该环境中可能如何与该物体交互”。

相关稳定性参数：

```bash
INTEREST_STABLE_DURATION_SEC=2
INTEREST_STABLE_MATCH_RATIO=0.75
INTEREST_STABLE_MIN_SAMPLES=4
```

如果要回退到本地 Ollama：

```bash
LLM_PROVIDER=ollama \
OLLAMA_BASE_URL=http://office.zhoudians.com:41434 \
OLLAMA_MODEL=qwen3.5:27b \
python -m interaction_predictor --camera-url 0
```

## API

服务默认运行在 `http://0.0.0.0:8000`。

前端演示控制台：

```text
GET /
GET /ui/app.js
GET /ui/styles.css
```

```text
GET /health
GET /camera/sources
GET /camera/source
POST /camera/source {"source":"0"}
GET /latest-scene
GET /latest-interest-object
GET /latest-prediction
GET /history/scenes?limit=20
GET /history/predictions?limit=20
GET /snapshot
```

## 输出文件

默认写入：

```text
data/scenes.jsonl
data/predictions.jsonl
```
