const endpointTargets = new Map([
  ["/health", "healthJson"],
  ["/latest-scene", "sceneJson"],
  ["/latest-interest-object", "objectJson"],
  ["/latest-prediction", "predictionJson"],
  ["/history/scenes?limit=20", "sceneHistoryJson"],
  ["/history/predictions?limit=20", "predictionHistoryJson"],
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
  sources: [],
};

const browserPermissionSource = "browser:request";

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
    await refreshSnapshot();
    return;
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
  const backendSources = result.body.sources || [];
  state.sources = [...backendSources, ...browserCameraSources()];
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
    meta.textContent = `camera index=${details.index}${backend} ${details.width || 0}x${details.height || 0} fps=${Math.round(details.fps || 0)} ${readable}`;
  } else if (selected.type === "browser-camera") {
    meta.textContent = `browser getUserMedia index=${details.index} device=${details.device_id ? "ready" : "unknown"}`;
  } else if (selected.type === "browser-permission") {
    meta.textContent = "点击切换按钮后授权浏览器摄像头并刷新设备列表";
  } else if (selected.type === "video") {
    meta.textContent = `${selected.available ? "ready" : "missing"} ${details.path || selected.source}`;
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
      await refreshAll();
      await refreshCameraSources();
      return;
    }
    stopBrowserCapture();
    const result = await postJson("/camera/source", { source });
    setJson("runnerJson", result.body);
    meta.textContent = result.body.changed ? `已切换 ${source}` : `仍在使用 ${source}`;
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    await refreshAll();
    await refreshCameraSources();
  } catch (error) {
    meta.textContent = `切换失败: ${error.message}`;
    setJson("runnerJson", { endpoint: "/camera/source", error: error.message });
  } finally {
    button.disabled = false;
  }
}

async function startBrowserCapture(source) {
  stopBrowserCapture();
  const deviceId = source.slice("browser:".length);
  const result = await postJson("/camera/source", { source });
  setJson("runnerJson", result.body);
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId } },
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
  }, 250);
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

async function refreshSnapshot() {
  const image = $("snapshot");
  const empty = $("snapshotEmpty");
  const url = `/snapshot?t=${Date.now()}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    image.removeAttribute("src");
    empty.style.display = "grid";
    throw new Error(`${response.status} ${response.statusText}`);
  }
  if (state.lastSnapshotUrl) {
    URL.revokeObjectURL(state.lastSnapshotUrl);
  }
  const blob = await response.blob();
  state.lastSnapshotUrl = URL.createObjectURL(blob);
  image.src = state.lastSnapshotUrl;
  empty.style.display = "none";
}

function updateHealthSummary(health) {
  const camera = health?.camera || {};
  setStatusCard(
    "cameraStatus",
    camera.connected ? "connected" : "offline",
    camera.error || camera.source || "no source",
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

    const [scene, object, prediction, sceneHistory, predictionHistory] = await Promise.allSettled([
      refreshEndpoint("/latest-scene"),
      refreshEndpoint("/latest-interest-object"),
      refreshEndpoint("/latest-prediction"),
      refreshEndpoint("/history/scenes?limit=20"),
      refreshEndpoint("/history/predictions?limit=20"),
    ]);

    if (prediction.status === "fulfilled") {
      renderPredictionSummary(prediction.value.body);
    }
    const errors = [scene, object, prediction, sceneHistory, predictionHistory]
      .filter((item) => item.status === "rejected")
      .map((item) => item.reason.message);
    if (errors.length) {
      setJson("runnerJson", { errors });
    }

    await refreshSnapshot().catch(() => undefined);
  } catch (error) {
    setJson("healthJson", { error: error.message });
  } finally {
    button.disabled = false;
  }
}

async function runSelectedEndpoint() {
  const endpoint = $("endpointSelect").value;
  const meta = $("runnerMeta");
  const output = $("runnerJson");
  const button = $("runEndpoint");
  button.disabled = true;
  meta.textContent = "running";
  try {
    if (endpoint === "/snapshot") {
      const started = performance.now();
      await refreshSnapshot();
      meta.textContent = `GET ${endpoint} 200 ${Math.round(performance.now() - started)}ms`;
      output.textContent = "snapshot refreshed";
      return;
    }
    const result = await refreshEndpoint(endpoint);
    meta.textContent = `GET ${endpoint} ${result.status} ${result.elapsed_ms}ms`;
    output.textContent = formatJson(result.body);
  } catch (error) {
    meta.textContent = `GET ${endpoint} failed`;
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
  $("cameraSourceSelect").addEventListener("change", updateSourceMeta);
  $("snapshotButton").addEventListener("click", () => refreshSnapshot().catch((error) => {
    setJson("runnerJson", { error: error.message });
  }));
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
refreshCameraSources().catch((error) => {
  $("cameraSourceMeta").textContent = `检测失败: ${error.message}`;
});
refreshAll();
state.autoTimer = window.setInterval(refreshAll, 5000);
