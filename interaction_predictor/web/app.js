const endpointTargets = new Map([
  ["/health", "healthJson"],
  ["/latest-scene", "sceneJson"],
  ["/latest-interest-object", "objectJson"],
  ["/latest-prediction", "predictionJson"],
  ["/latest-first-person-analysis", "firstPersonAnalysisJson"],
  ["/history/scenes?limit=20", "sceneHistoryJson"],
  ["/history/predictions?limit=20", "predictionHistoryJson"],
  ["/history/first-person-analyses?limit=20", "firstPersonHistoryJson"],
]);

const state = {
  autoTimer: null,
  browserCanvas: null,
  browserCaptureTimer: null,
  browserDevices: [],
  browserFramePosting: false,
  browserStream: null,
  browserVideo: null,
  lastSnapshotUrl: null,
  liveStreamUrl: null,
  sources: [],
};

const browserPermissionSource = "browser:request";
const networkStreamSchemes = ["rtmp://", "rtmps://", "rtsp://", "http://", "https://"];
const browserFrameIntervalMs = 100;

function $(id) {
  return document.getElementById(id);
}

function formatJson(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  return JSON.stringify(value, null, 2);
}

function setJson(id, value) {
  const target = $(id);
  if (target) {
    target.textContent = formatJson(value);
  }
}

function setStatusCard(id, stateName, detail, level = "warn") {
  const value = $(id);
  const detailNode = $(`${id.replace("Status", "Detail")}`);
  const card = value?.closest(".status-card");
  if (!value || !detailNode || !card) {
    return;
  }
  card.classList.remove("status-ok", "status-warn", "status-bad");
  card.classList.add(`status-${level}`);
  value.textContent = stateName;
  detailNode.textContent = detail || "-";
}

function isNetworkStreamSource(source) {
  const value = String(source || "").trim().toLowerCase();
  return networkStreamSchemes.some((scheme) => value.startsWith(scheme));
}

function networkStreamKind(source) {
  const value = String(source || "").trim().toLowerCase();
  if (value.startsWith("rtmp://") || value.startsWith("rtmps://")) {
    return "RTMP";
  }
  if (value.startsWith("rtsp://")) {
    return "RTSP";
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return "HTTP";
  }
  return "STREAM";
}

function normalizeNetworkStreamSource(value) {
  const source = String(value || "").trim();
  if (!source) {
    throw new Error("请输入视频流地址");
  }
  if (!isNetworkStreamSource(source)) {
    throw new Error("仅支持 rtmp://、rtmps://、rtsp://、http:// 或 https:// 视频流地址");
  }
  return source;
}

async function fetchJson(endpoint) {
  const started = performance.now();
  const response = await fetch(endpoint, { cache: "no-store" });
  const elapsed = Math.round(performance.now() - started);
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body || "request failed"}`);
  }
  if (!contentType.includes("application/json")) {
    return {
      status: response.status,
      elapsed_ms: elapsed,
      body: await response.text(),
    };
  }
  const body = await response.json();
  return {
    status: response.status,
    elapsed_ms: elapsed,
    body,
  };
}

async function postJson(endpoint, payload) {
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const elapsed = Math.round(performance.now() - started);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body || "request failed"}`);
  }
  return {
    status: response.status,
    elapsed_ms: elapsed,
    body: await response.json(),
  };
}

async function refreshEndpoint(endpoint) {
  if (endpoint === "/snapshot") {
    return fetchSnapshotInfo();
  }
  const result = await fetchJson(endpoint);
  const target = endpointTargets.get(endpoint);
  if (target) {
    setJson(target, result.body);
  }
  return result;
}

async function refreshCameraSources() {
  const result = await fetchJson("/camera/sources");
  const select = $("cameraSourceSelect");
  const meta = $("cameraSourceMeta");
  setResolutionSelectValue(result.body.resolution);
  const backendSources = result.body.sources || [];
  state.sources = [...backendSources, ...browserCameraSources()];
  if (isNetworkStreamSource(result.body.current_source)) {
    $("streamSourceInput").value = result.body.current_source;
  }
  if (navigator.mediaDevices?.getUserMedia) {
    state.sources.push({
      id: browserPermissionSource,
      source: browserPermissionSource,
      label: "浏览器摄像头授权/检测",
      type: "browser-permission",
      available: true,
      details: {},
    });
  }
  select.innerHTML = "";
  if (!state.sources.length) {
    select.innerHTML = '<option value="">未检测到输入源</option>';
    meta.textContent = "可手动设置 CAMERA_URL 或确认系统摄像头权限";
    return result;
  }
  for (const source of state.sources) {
    const option = document.createElement("option");
    option.value = source.source;
    const marker = source.source === result.body.current_source ? "当前 · " : "";
    const unavailable = source.available ? "" : " · 不可用";
    option.textContent = `${marker}${source.label}${unavailable}`;
    option.disabled = source.type !== "camera" && !source.available;
    select.appendChild(option);
  }
  if (state.sources.some((source) => source.source === result.body.current_source)) {
    select.value = result.body.current_source;
  }
  updateSourceMeta();
  return result;
}

function selectedResolutionPayload() {
  const value = $("cameraResolutionSelect").value;
  if (!value) {
    return { width: null, height: null };
  }
  const [width, height] = value.split("x").map((item) => Number.parseInt(item, 10));
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { width: null, height: null };
  }
  return { width, height };
}

function resolutionLabel(resolution) {
  if (!resolution?.width || !resolution?.height) {
    return "auto";
  }
  return `${resolution.width}x${resolution.height}`;
}

function setResolutionSelectValue(resolution) {
  const select = $("cameraResolutionSelect");
  const value = resolution?.width && resolution?.height
    ? `${resolution.width}x${resolution.height}`
    : "";
  if (value && !Array.from(select.options).some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${resolution.width} x ${resolution.height}`;
    select.appendChild(option);
  }
  select.value = value;
}

function browserCameraSources() {
  return state.browserDevices.map((device, index) => ({
    id: `browser:${device.deviceId}`,
    source: `browser:${device.deviceId}`,
    label: `浏览器 · ${device.label || `摄像头 ${index + 1}`}`,
    type: "browser-camera",
    available: true,
    details: {
      backend: "browser-get-user-media",
      device_id: device.deviceId,
      group_id: device.groupId,
      index,
    },
  }));
}

async function requestBrowserCameraDevices() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前浏览器不支持摄像头访问");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  stream.getTracks().forEach((track) => track.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  state.browserDevices = devices.filter((device) => device.kind === "videoinput");
  return state.browserDevices;
}

function updateSourceMeta() {
  const select = $("cameraSourceSelect");
  const meta = $("cameraSourceMeta");
  const selected = state.sources.find((item) => item.source === select.value);
  if (!selected) {
    meta.textContent = select.value ? `自定义输入源 ${select.value}` : "-";
    return;
  }
  const details = selected.details || {};
  if (selected.type === "camera") {
    const backend = details.backend ? ` backend=${details.backend}` : "";
    const readable = details.readable === null ? "readable=not-probed" : `readable=${details.readable}`;
    meta.textContent = `camera index=${details.index}${backend} ${details.width || 0}x${details.height || 0} fps=${Math.round(details.fps || 0)} ${readable} requested=${resolutionLabel(selectedResolutionPayload())}`;
  } else if (selected.type === "browser-camera") {
    meta.textContent = `browser getUserMedia index=${details.index} device=${details.device_id ? "ready" : "unknown"} requested=${resolutionLabel(selectedResolutionPayload())}`;
  } else if (selected.type === "browser-permission") {
    meta.textContent = "点击切换按钮后授权浏览器摄像头并刷新设备列表";
  } else if (selected.type === "video") {
    meta.textContent = `${selected.available ? "ready" : "missing"} ${details.path || selected.source} requested=${resolutionLabel(selectedResolutionPayload())}`;
  } else if (selected.type === "stream") {
    $("streamSourceInput").value = selected.source;
    const backend = details.backend ? ` backend=${details.backend}` : "";
    const scheme = details.scheme || networkStreamKind(selected.source).toLowerCase();
    meta.textContent = `${scheme} stream${backend} ${selected.source} requested=${resolutionLabel(selectedResolutionPayload())}`;
  } else {
    meta.textContent = selected.source;
  }
}

async function switchCameraSource() {
  const select = $("cameraSourceSelect");
  const button = $("switchSource");
  const meta = $("cameraSourceMeta");
  const source = select.value;
  if (!source) {
    meta.textContent = "没有可切换的输入源";
    return;
  }
  button.disabled = true;
  meta.textContent = `switching to ${source}`;
  try {
    if (source === browserPermissionSource) {
      const devices = await requestBrowserCameraDevices();
      await refreshCameraSources();
      meta.textContent = `检测到 ${devices.length} 个浏览器摄像头`;
      setJson("runnerJson", {
        endpoint: "browser:getUserMedia",
        devices: devices.map((device) => device.label || device.deviceId),
      });
      return;
    }
    if (source.startsWith("browser:")) {
      await startBrowserCapture(source);
      meta.textContent = `已切换 ${source}`;
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      restartLiveView();
      await refreshAll();
      await refreshCameraSources();
      return;
    }
    stopBrowserCapture();
    const result = await postJson("/camera/source", {
      source,
      ...selectedResolutionPayload(),
    });
    setJson("runnerJson", result.body);
    meta.textContent = result.body.changed ? `已切换 ${source}` : `仍在使用 ${source}`;
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    restartLiveView();
    await refreshAll();
    await refreshCameraSources();
  } catch (error) {
    meta.textContent = `切换失败: ${error.message}`;
    setJson("runnerJson", { endpoint: "/camera/source", error: error.message });
  } finally {
    button.disabled = false;
  }
}

async function switchNetworkStreamSource() {
  const input = $("streamSourceInput");
  const button = $("switchStreamSource");
  const meta = $("cameraSourceMeta");
  let source;
  try {
    source = normalizeNetworkStreamSource(input.value);
  } catch (error) {
    meta.textContent = error.message;
    return;
  }
  button.disabled = true;
  meta.textContent = `pulling ${networkStreamKind(source)} stream`;
  try {
    stopBrowserCapture();
    const result = await postJson("/camera/source", {
      source,
      ...selectedResolutionPayload(),
    });
    setJson("runnerJson", result.body);
    meta.textContent = result.body.changed ? `已切换 ${source}` : `仍在使用 ${source}`;
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    restartLiveView();
    await refreshAll();
    await refreshCameraSources();
  } catch (error) {
    meta.textContent = `拉流失败: ${error.message}`;
    setJson("runnerJson", { endpoint: "/camera/source", source, error: error.message });
  } finally {
    button.disabled = false;
  }
}

async function startBrowserCapture(source) {
  stopBrowserCapture();
  const deviceId = source.slice("browser:".length);
  const resolution = selectedResolutionPayload();
  const result = await postJson("/camera/source", { source, ...resolution });
  setJson("runnerJson", result.body);
  const videoConstraints = { deviceId: { exact: deviceId } };
  if (resolution.width && resolution.height) {
    videoConstraints.width = { ideal: resolution.width };
    videoConstraints.height = { ideal: resolution.height };
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: false,
  });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth || !video.videoHeight) {
    await new Promise((resolve) => {
      video.onloadedmetadata = resolve;
    });
  }
  const canvas = document.createElement("canvas");
  state.browserStream = stream;
  state.browserVideo = video;
  state.browserCanvas = canvas;
  state.browserCaptureTimer = window.setInterval(() => {
    postBrowserFrame(source).catch((error) => {
      $("cameraSourceMeta").textContent = `浏览器帧上传失败: ${error.message}`;
    });
  }, browserFrameIntervalMs);
  await postBrowserFrame(source);
}

function stopBrowserCapture() {
  if (state.browserCaptureTimer) {
    window.clearInterval(state.browserCaptureTimer);
    state.browserCaptureTimer = null;
  }
  if (state.browserStream) {
    state.browserStream.getTracks().forEach((track) => track.stop());
    state.browserStream = null;
  }
  state.browserVideo = null;
  state.browserCanvas = null;
  state.browserFramePosting = false;
}

async function postBrowserFrame(source) {
  if (!state.browserVideo || !state.browserCanvas || state.browserFramePosting) {
    return;
  }
  const video = state.browserVideo;
  const canvas = state.browserCanvas;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    return;
  }
  state.browserFramePosting = true;
  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, width, height);
    const image = canvas.toDataURL("image/jpeg", 0.76);
    await postJson("/camera/browser-frame", { source, image });
  } finally {
    state.browserFramePosting = false;
  }
}

function restartLiveView() {
  const image = $("snapshot");
  const empty = $("snapshotEmpty");
  if (state.lastSnapshotUrl) {
    URL.revokeObjectURL(state.lastSnapshotUrl);
    state.lastSnapshotUrl = null;
  }
  const url = `/stream.mjpg?t=${Date.now()}`;
  state.liveStreamUrl = url;
  empty.textContent = "等待实时画面";
  empty.style.display = "grid";
  image.onload = () => {
    empty.style.display = "none";
  };
  image.onerror = () => {
    if (state.liveStreamUrl === url) {
      empty.textContent = "实时画面连接失败";
      empty.style.display = "grid";
    }
  };
  image.src = url;
}

async function fetchSnapshotInfo() {
  const url = `/snapshot?t=${Date.now()}`;
  const started = performance.now();
  const response = await fetch(url, { cache: "no-store" });
  const elapsed = Math.round(performance.now() - started);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body || "request failed"}`);
  }
  const blob = await response.blob();
  return {
    status: response.status,
    elapsed_ms: elapsed,
    body: {
      bytes: blob.size,
      content_type: blob.type || response.headers.get("content-type") || "image/jpeg",
    },
  };
}

function updateHealthSummary(health) {
  const camera = health?.camera || {};
  const actual = camera.actual_resolution
    ? ` ${resolutionLabel(camera.actual_resolution)}`
    : "";
  const requested = camera.requested_resolution
    ? ` requested=${resolutionLabel(camera.requested_resolution)}`
    : "";
  setStatusCard(
    "cameraStatus",
    camera.connected ? "connected" : "offline",
    camera.error || `${camera.source || "no source"}${actual}${requested}`,
    camera.connected ? "ok" : "bad",
  );

  const yolo = health?.yolo || {};
  setStatusCard(
    "yoloStatus",
    yolo.ready ? "ready" : "waiting",
    yolo.error || `${yolo.model || "-"} ${yolo.interest || ""}`.trim(),
    yolo.ready ? "ok" : yolo.error ? "bad" : "warn",
  );

  const scene = health?.scene_worker || {};
  setStatusCard(
    "sceneStatus",
    scene.ready ? "ready" : "waiting",
    scene.error || `${scene.provider || ""} ${scene.model || ""}`.trim() || "-",
    scene.ready ? "ok" : scene.error ? "bad" : "warn",
  );

  const prediction = health?.interaction_worker || {};
  setStatusCard(
    "predictionStatus",
    prediction.ready ? "ready" : "waiting",
    prediction.error || prediction.latest_prediction_id || "-",
    prediction.ready ? "ok" : prediction.error ? "bad" : "warn",
  );
}

function renderPredictionSummary(prediction) {
  const target = $("predictionSummary");
  if (!prediction || !Array.isArray(prediction.possible_interactions)) {
    target.innerHTML = '<div class="empty-inline">暂无预测</div>';
    return;
  }
  target.innerHTML = prediction.possible_interactions
    .slice(0, 3)
    .map((item, index) => {
      const confidence = Number(item.confidence ?? 0);
      const percent = Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : "-";
      return `
        <div class="prediction-item">
          <div class="rank">${item.rank || index + 1}</div>
          <div>
            <h3>${escapeHtml(item.action || "未知交互")}</h3>
            <p>${escapeHtml(item.reason || "无说明")}</p>
          </div>
          <div class="confidence">${percent}</div>
        </div>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });
}

async function refreshAll() {
  const button = $("refreshAll");
  button.disabled = true;
  try {
    const health = await refreshEndpoint("/health");
    updateHealthSummary(health.body);

    const [
      scene,
      object,
      prediction,
      firstPersonAnalysis,
      sceneHistory,
      predictionHistory,
      firstPersonHistory,
    ] = await Promise.allSettled([
      refreshEndpoint("/latest-scene"),
      refreshEndpoint("/latest-interest-object"),
      refreshEndpoint("/latest-prediction"),
      refreshEndpoint("/latest-first-person-analysis"),
      refreshEndpoint("/history/scenes?limit=20"),
      refreshEndpoint("/history/predictions?limit=20"),
      refreshEndpoint("/history/first-person-analyses?limit=20"),
    ]);

    if (prediction.status === "fulfilled") {
      renderPredictionSummary(prediction.value.body);
    }
    const errors = [
      scene,
      object,
      prediction,
      firstPersonAnalysis,
      sceneHistory,
      predictionHistory,
      firstPersonHistory,
    ]
      .filter((item) => item.status === "rejected")
      .map((item) => item.reason.message);
    if (errors.length) {
      setJson("runnerJson", { errors });
    }

  } catch (error) {
    setJson("healthJson", { error: error.message });
  } finally {
    button.disabled = false;
  }
}

async function runSelectedEndpoint() {
  const endpoint = $("endpointSelect").value;
  const method = endpoint === "/first-person-analysis" ? "POST" : "GET";
  const meta = $("runnerMeta");
  const output = $("runnerJson");
  const button = $("runEndpoint");
  button.disabled = true;
  meta.textContent = "running";
  try {
    if (endpoint === "/snapshot") {
      const result = await fetchSnapshotInfo();
      meta.textContent = `GET ${endpoint} ${result.status} ${result.elapsed_ms}ms`;
      output.textContent = formatJson(result.body);
      return;
    }
    if (endpoint === "/first-person-analysis") {
      const result = await postJson(
        "/first-person-analysis?require_stable=true&include_prompt=true&persist=true",
        {},
      );
      meta.textContent = `POST ${endpoint} ${result.status} ${result.elapsed_ms}ms`;
      output.textContent = formatJson(result.body);
      await refreshEndpoint("/latest-first-person-analysis").catch(() => undefined);
      await refreshEndpoint("/history/first-person-analyses?limit=20").catch(() => undefined);
      return;
    }
    const result = await refreshEndpoint(endpoint);
    meta.textContent = `GET ${endpoint} ${result.status} ${result.elapsed_ms}ms`;
    output.textContent = formatJson(result.body);
  } catch (error) {
    meta.textContent = `${method} ${endpoint} failed`;
    output.textContent = formatJson({ error: error.message });
  } finally {
    button.disabled = false;
  }
}

function setupEvents() {
  $("refreshAll").addEventListener("click", refreshAll);
  $("refreshSources").addEventListener("click", () => refreshCameraSources().catch((error) => {
    $("cameraSourceMeta").textContent = `检测失败: ${error.message}`;
    setJson("runnerJson", { endpoint: "/camera/sources", error: error.message });
  }));
  $("switchSource").addEventListener("click", switchCameraSource);
  $("switchStreamSource").addEventListener("click", switchNetworkStreamSource);
  $("cameraSourceSelect").addEventListener("change", updateSourceMeta);
  $("cameraResolutionSelect").addEventListener("change", updateSourceMeta);
  $("streamSourceInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      switchNetworkStreamSource();
    }
  });
  $("snapshotButton").addEventListener("click", restartLiveView);
  $("runEndpoint").addEventListener("click", runSelectedEndpoint);
  $("autoRefresh").addEventListener("change", (event) => {
    if (event.target.checked) {
      state.autoTimer = window.setInterval(refreshAll, 5000);
      refreshAll();
    } else if (state.autoTimer) {
      window.clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
  });

  document.querySelectorAll("[data-json]").forEach((button) => {
    button.addEventListener("click", async () => {
      const endpoint = button.getAttribute("data-json");
      button.disabled = true;
      try {
        const result = await refreshEndpoint(endpoint);
        if (endpoint === "/health") {
          updateHealthSummary(result.body);
        }
        if (endpoint === "/latest-prediction") {
          renderPredictionSummary(result.body);
        }
      } catch (error) {
        setJson("runnerJson", { endpoint, error: error.message });
      } finally {
        button.disabled = false;
      }
    });
  });
}

setupEvents();
restartLiveView();
refreshCameraSources().catch((error) => {
  $("cameraSourceMeta").textContent = `检测失败: ${error.message}`;
});
refreshAll();
state.autoTimer = window.setInterval(refreshAll, 5000);
