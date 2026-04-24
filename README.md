# Interaction Predictor MVP

一个用于第一人称摄像头画面的潜在交互行为预测模块。项目从摄像头、RTMP/RTSP/HTTP 视频流或本机测试视频中获取画面，低频调用 Kimi 多模态模型理解全局场景，高频使用 YOLO 识别画面中央的兴趣物体，再把“环境”和“当前关注物体”融合为第一人称交互预测。

这个仓库当前定位是最小可运行 MVP：便于本机演示、调试接口、验证提示词和后续集成到更大的系统中。

## 项目目标

- 把第一人称摄像头画面转成可存储、可检索的结构化场景文本。
- 持续识别画面中央附近的兴趣物体，避免所有画面都走大模型造成高延迟和高成本。
- 当中心兴趣物稳定停留超过一段时间后，推测“我在当前环境中可能如何与这个物体交互”。
- 提供可视化 Web 控制台，快速测试摄像头切换、实时画面、场景理解、兴趣物识别、预测结果和历史数据。
- 提供一键启动和本机后台部署脚本，方便上传 GitHub 后快速复现。

## 核心思路

系统把同一段视频流拆成两条不同频率的分析链路：

1. 全局场景链路：每隔 `SCENE_INTERVAL_SEC` 秒取一帧全图，压缩后直接传给 Kimi 多模态模型，得到当前环境、主要事物和场景推测，并写入 `data/scenes.jsonl`。
2. 中心兴趣物链路：用 YOLO 高频检测画面里的物体，优先选择靠近画面中心、面积和置信度合理的目标，抽象为“用户当前视野关注点”。
3. 交互预测链路：只有当中心兴趣物在最近窗口内足够稳定，才把最新场景和兴趣物输入大模型，输出前三个第一人称潜在交互行为，并写入 `data/predictions.jsonl`。

提示词的核心问题是：

```text
如果我在这样一个<环境>中，我的视野关注点在一个<object>上，我可能对这个<object>产生的潜在交互行为是什么？
```

## 架构

```mermaid
flowchart LR
  Camera["Camera / RTMP / RTSP / HTTP / demo.mp4"] --> Reader["CameraReader"]
  Reader --> Buffer["FrameBuffer"]
  Buffer --> Stream["MJPEG /stream.mjpg"]
  Stream --> UI["Web Console"]
  Buffer --> SceneWorker["GlobalSceneWorker<br/>low frequency"]
  SceneWorker --> KimiVision["Kimi Vision"]
  KimiVision --> SceneStore["data/scenes.jsonl"]
  Buffer --> YoloWorker["YOLO Worker<br/>high frequency"]
  YoloWorker --> InterestState["InterestObjectState"]
  SceneStore --> InteractionWorker["InteractionWorker"]
  InterestState --> InteractionWorker
  InteractionWorker --> KimiText["Kimi Text"]
  KimiText --> PredictionStore["data/predictions.jsonl"]
  SceneStore --> API["FastAPI"]
  InterestState --> API
  PredictionStore --> API
  API --> UI
```

主要模块：

| 模块 | 作用 |
| --- | --- |
| `interaction_predictor/camera.py` | 摄像头、本机视频、RTMP/RTSP/HTTP 拉流，本机设备检测和浏览器摄像头帧接入 |
| `interaction_predictor/scene_worker.py` | 低频全局场景理解，默认把真实图像传给 Kimi 多模态 |
| `interaction_predictor/yolo_worker.py` | 高频 YOLO 检测，选择中心兴趣物并维护稳定状态 |
| `interaction_predictor/interaction_worker.py` | 融合场景和兴趣物，预测前三个潜在交互行为 |
| `interaction_predictor/prompts.py` | 场景理解和第一人称交互预测提示词 |
| `interaction_predictor/app.py` | FastAPI 服务、API、MJPEG 实时流和 Web UI 托管 |
| `interaction_predictor/web/` | 本地演示控制台 |

## 技术栈

- Python 3.10+
- FastAPI + Uvicorn：本地 API 服务和 Web UI 托管
- OpenCV：摄像头、本地视频和网络视频流读取
- Ultralytics YOLO：中心兴趣物检测
- Kimi 中国站 API：多模态场景理解和文本交互预测
- Pydantic：结构化数据模型
- 原生 HTML/CSS/JavaScript：无前端构建步骤的演示控制台
- JSONL：MVP 阶段的场景和预测结果持久化

项目也保留了 Ollama provider，方便回退到本地模型做文本链路验证。

## 快速启动

```bash
git clone <your-repo-url>
cd interaction-predictor-mvp
cp .env.example .env
```

编辑 `.env`，至少填入：

```bash
MOONSHOT_API_KEY=你的 Kimi API Key
CAMERA_URL=/tmp/interaction-predictor-demo/demo.mp4
```

启动：

```bash
./scripts/start.sh
```

打开控制台：

```text
http://127.0.0.1:8000/
```

控制台可以直接测试健康检查、实时画面、摄像头检测/切换、最新场景、中心兴趣物、最新预测、第一人称按需分析和历史记录。

## 一键部署

后台部署并自动重启已有实例：

```bash
./scripts/deploy.sh
```

查看日志：

```bash
tail -f runtime/server.log
```

停止服务：

```bash
./scripts/stop.sh
```

默认使用 `nohup` 后台进程，适合本地 MVP 演示。macOS 上也可以用 LaunchAgent 托管：

```bash
USE_LAUNCHD=1 ./scripts/deploy.sh
```

如果项目放在 `Documents`、`Desktop` 等受 macOS 隐私保护的目录，LaunchAgent 或 Python 进程可能需要完整磁盘访问权限。摄像头权限也可能按浏览器、终端或 Python 进程分别授权。

## 常用配置

`.env.example` 提供了默认配置。常用项如下：

```bash
MOONSHOT_API_KEY=replace_with_your_key
LLM_PROVIDER=kimi
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=kimi-k2.6
KIMI_VISION_MODEL=kimi-k2.5

CAMERA_URL=0
CAMERA_DEMO_VIDEO=/tmp/interaction-predictor-demo/demo.mp4
CAMERA_PROBE_COUNT=6
OPENCV_AVFOUNDATION_SKIP_AUTH=0

SCENE_INPUT_MODE=image
SCENE_INTERVAL_SEC=15
STREAM_FPS=10

YOLO_MODEL=yolo11n.pt
YOLO_FPS=5
INTEREST_STABLE_DURATION_SEC=2
INTEREST_STABLE_MATCH_RATIO=0.75
INTEREST_STABLE_MIN_SAMPLES=4
```

手动启动方式：

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
export MOONSHOT_API_KEY="你的 Kimi API Key"
python -m interaction_predictor --camera-url 0
```

回退到本地 Ollama：

```bash
LLM_PROVIDER=ollama \
OLLAMA_BASE_URL=http://office.zhoudians.com:41434 \
OLLAMA_MODEL=qwen3.5:27b \
python -m interaction_predictor --camera-url 0
```

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

macOS 上如果 `GET /camera/sources` 只看到测试视频，通常是当前 Python/终端进程没有摄像头权限，或者系统没有暴露可读的本机摄像头设备。如果 Photo Booth 可用但页面持续 offline，优先在前端使用“浏览器摄像头授权/检测”。浏览器会单独请求摄像头权限，拿到帧后通过 `/camera/browser-frame` 送回本地后端。

切换摄像头源时，当前帧缓存、YOLO 兴趣物状态、场景历史和预测历史会被清空，避免旧输入源的数据污染新输入源。

## API

服务默认运行在 `http://0.0.0.0:8000`。

```text
GET /
GET /health
GET /camera/sources
GET /camera/source
POST /camera/source {"source":"0"}
POST /camera/browser-frame
GET /latest-scene
GET /latest-interest-object
GET /latest-prediction
POST /first-person-analysis?require_stable=true&include_prompt=true&persist=false
GET /history/scenes?limit=20
GET /history/predictions?limit=20
GET /snapshot
GET /stream.mjpg
```

前端主画面使用 `GET /stream.mjpg` 持续显示 MJPEG 实时流，和大模型推理、历史查询刷新解耦。`GET /snapshot` 只用于单帧调试。

`POST /first-person-analysis` 会按需调用大模型，使用最新场景和当前稳定中心兴趣物，返回实际发送给大模型的 `prompt`、`raw_llm_output` 和标准化后的 `prediction`。设置 `persist=true` 时会写入预测历史。

## 输出文件

默认写入：

```text
data/scenes.jsonl
data/predictions.jsonl
```

这些文件用于 MVP 调试和回放分析，默认不建议提交到仓库。

## 项目结构

```text
interaction_predictor/
  app.py                 FastAPI API、Web UI、实时流
  camera.py              视频源读取和设备检测
  config.py              环境变量和启动配置
  interaction_worker.py  第一人称潜在交互预测
  kimi.py                Kimi API client
  ollama.py              Ollama API client
  prompts.py             大模型提示词
  scene_worker.py        全局场景理解
  storage.py             JSONL 存储
  web/                   本地演示控制台
  yolo_worker.py         YOLO 中心兴趣物检测
scripts/
  start.sh               前台启动
  deploy.sh              后台部署或 LaunchAgent 部署
  stop.sh                停止后台服务
```

## 当前 MVP 边界

- 默认用 JSONL 做持久化，没有引入数据库。
- YOLO 只做兴趣物检测，不做全局场景理解。
- 第一人称预测是概率性推测，不代表真实用户意图。
- 多摄像头在 macOS 上可能受到系统权限、浏览器权限和 OpenCV AVFoundation 后端限制。
