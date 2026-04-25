import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const CONFIG_PATH = process.env.PORTAL_CONFIG || path.join(ROOT_DIR, "config", "portal.config.json");
const HTTP_PORT = Number.parseInt(process.env.PORT || process.env.HTTP_PORT || "8787", 10);
const HTTPS_PORT = Number.parseInt(process.env.HTTPS_PORT || "9443", 10);
const HOST = process.env.HOST || "0.0.0.0";

const clients = new Set();
let cachedConfig = await loadConfig();
let cachedDecision = await buildDecision();
let watchHandle = null;
let pollTimer = null;
let lastSignature = "";

startWatcher();

const requestHandler = async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }

    if (requestUrl.pathname === "/api/health") {
      const predictor = await fetchPredictorHealth();
      sendJson(res, 200, {
        ok: true,
        service: cachedConfig.name,
        inputFile: cachedConfig.inputFile,
        inputExists: fs.existsSync(cachedConfig.inputFile),
        predictor,
        decision: cachedDecision
      });
      return;
    }

    if (requestUrl.pathname === "/api/config") {
      sendJson(res, 200, publicConfig());
      return;
    }

    if (requestUrl.pathname === "/api/latest" || requestUrl.pathname === "/api/decision") {
      cachedDecision = await buildDecision();
      sendJson(res, 200, cachedDecision);
      return;
    }

    if (requestUrl.pathname === "/api/reload-config" && req.method === "POST") {
      cachedConfig = await loadConfig();
      await restartWatcher();
      cachedDecision = await buildDecision();
      broadcast("config", cachedDecision);
      sendJson(res, 200, { ok: true, config: publicConfig(), decision: cachedDecision });
      return;
    }

    if (requestUrl.pathname === "/api/events") {
      openEventStream(req, res);
      return;
    }

    if (
      (requestUrl.pathname === "/api/strategic-hint" ||
        requestUrl.pathname === "/game/api/strategic-hint") &&
      req.method === "POST"
    ) {
      await readBody(req);
      sendJson(res, 200, {
        hint: {
          message: "Local fallback: aim for the largest visible cluster.",
          rationale: "Quest Portal Hub is serving the packaged arcade scene without cloud AI keys."
        },
        debug: {
          provider: "local-fallback",
          model: "quest-portal-package",
          timestamp: new Date().toISOString()
        }
      });
      return;
    }

    await serveStatic(requestUrl.pathname, req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
};

http.createServer(requestHandler).listen(HTTP_PORT, HOST, () => {
  printUrl("HTTP", HTTP_PORT);
});

const httpsOptions = loadHttpsOptions();
if (httpsOptions) {
  https.createServer(httpsOptions, requestHandler).listen(HTTPS_PORT, HOST, () => {
    printUrl("HTTPS", HTTPS_PORT);
  });
} else {
  console.warn("HTTPS disabled: certs/cert.pem and certs/key.pem were not found.");
}

async function loadConfig() {
  const raw = await fsp.readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);
  if (!path.isAbsolute(config.inputFile)) {
    config.inputFile = path.resolve(ROOT_DIR, config.inputFile);
  }
  config.pollMs = Number(config.pollMs || 1500);
  config.scenes = Array.isArray(config.scenes) ? config.scenes : [];
  return config;
}

function publicConfig() {
  return {
    name: cachedConfig.name,
    inputFile: cachedConfig.inputFile,
    pollMs: cachedConfig.pollMs,
    homeStage: cachedConfig.homeStage,
    fallbackSceneId: cachedConfig.fallbackSceneId,
    scenes: cachedConfig.scenes
  };
}

async function fetchPredictorHealth() {
  if (!cachedConfig.predictorHealthUrl || typeof fetch !== "function") {
    return { ok: null, skipped: true };
  }
  try {
    const response = await fetch(cachedConfig.predictorHealthUrl, { signal: AbortSignal.timeout(900) });
    return {
      ok: response.ok,
      status: response.status,
      url: cachedConfig.predictorHealthUrl
    };
  } catch (error) {
    return {
      ok: false,
      url: cachedConfig.predictorHealthUrl,
      error: error.message || String(error)
    };
  }
}

async function buildDecision() {
  const latest = await readLatestJsonLine(cachedConfig.inputFile);
  if (!latest.record) {
    return {
      ok: false,
      inputFile: cachedConfig.inputFile,
      inputExists: latest.exists,
      line: latest.line,
      updatedAt: latest.updatedAt,
      scene: null,
      scores: [],
      analysis: null,
      reason: latest.exists ? "waiting_for_jsonl_record" : "input_file_missing"
    };
  }

  const scores = scoreScenes(latest.record, cachedConfig.scenes);
  const winner = scores.find((item) => item.score > 0)?.scene ||
    cachedConfig.scenes.find((scene) => scene.id === cachedConfig.fallbackSceneId) ||
    cachedConfig.scenes[0] ||
    null;

  return {
    ok: Boolean(winner),
    inputFile: cachedConfig.inputFile,
    inputExists: latest.exists,
    line: latest.line,
    updatedAt: latest.updatedAt,
    scene: winner,
    scores,
    analysis: latest.record,
    reason: scores.some((item) => item.score > 0) ? "matched_rules" : "fallback_scene"
  };
}

async function readLatestJsonLine(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    const raw = await fsp.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (!lines.length) {
      return {
        exists: true,
        record: null,
        line: 0,
        updatedAt: stat.mtime.toISOString(),
        signature: `${stat.size}:${stat.mtimeMs}`
      };
    }
    const line = lines[lines.length - 1];
    return {
      exists: true,
      record: JSON.parse(line),
      line: lines.length,
      updatedAt: stat.mtime.toISOString(),
      signature: `${stat.size}:${stat.mtimeMs}`
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, record: null, line: 0, updatedAt: null, signature: "missing" };
    }
    return {
      exists: true,
      record: null,
      line: 0,
      updatedAt: null,
      signature: `error:${error.message}`,
      error: error.message
    };
  }
}

function scoreScenes(record, scenes) {
  const text = flattenText(record).toLowerCase();
  return scenes
    .map((scene) => {
      const matched = [];
      let score = 0;
      for (const rule of scene.rules || []) {
        const weight = Number(rule.weight || 1);
        for (const term of rule.terms || []) {
          const normalized = String(term).toLowerCase();
          if (normalized && text.includes(normalized)) {
            score += weight;
            matched.push({ term, weight });
          }
        }
      }
      return { scene, score, matched };
    })
    .sort((a, b) => b.score - a.score || a.scene.id.localeCompare(b.scene.id));
}

function flattenText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return ` ${value}`;
  }
  if (Array.isArray(value)) {
    return value.map(flattenText).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value).map(flattenText).join(" ");
  }
  return "";
}

function startWatcher() {
  const inputFile = cachedConfig.inputFile;
  const watchDir = path.dirname(inputFile);
  const watchBase = path.basename(inputFile);

  pollTimer = setInterval(async () => {
    const latest = await readLatestJsonLine(inputFile);
    if (latest.signature && latest.signature !== lastSignature) {
      lastSignature = latest.signature;
      cachedDecision = await buildDecision();
      broadcast("decision", cachedDecision);
    }
  }, cachedConfig.pollMs);

  try {
    watchHandle = fs.watch(watchDir, async (_eventType, filename) => {
      if (!filename || filename.toString() === watchBase) {
        cachedDecision = await buildDecision();
        broadcast("decision", cachedDecision);
      }
    });
  } catch (error) {
    console.warn(`File watch disabled for ${watchDir}: ${error.message}`);
  }
}

async function restartWatcher() {
  if (watchHandle) {
    watchHandle.close();
    watchHandle = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  startWatcher();
}

function openEventStream(req, res) {
  res.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream"
  });
  res.write(`event: decision\ndata: ${JSON.stringify(cachedDecision)}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

async function serveStatic(pathname, req, res) {
  let decodedPath = decodeURIComponent(pathname);
  if (decodedPath === "/") decodedPath = "/index.html";
  if (decodedPath === "/game") {
    sendRedirect(res, "/game/");
    return;
  }
  if (decodedPath.endsWith("/")) decodedPath += "index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, decodedPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      send(res, 404, "Not found");
      return;
    }
    if (isRangeCapable(filePath)) {
      if (req.headers.range) {
        await sendRange(filePath, req.headers.range, res);
      } else {
        sendStream(filePath, stat, req, res);
      }
      return;
    }
    if (req.method === "HEAD") {
      send(res, 200, "", contentType(filePath), cacheControl(filePath), {
        "Content-Length": String(stat.size)
      });
      return;
    }
    const content = await fsp.readFile(filePath);
    send(res, 200, content, contentType(filePath), cacheControl(filePath));
  } catch (error) {
    if (error.code === "ENOENT") {
      send(res, 404, "Not found");
      return;
    }
    throw error;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 6_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function sendRange(filePath, rangeHeader, res) {
  const stat = await fsp.stat(filePath);
  const total = stat.size;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
  if (!match) {
    res.writeHead(416, {
      "Access-Control-Allow-Origin": "*",
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${total}`
    });
    res.end();
    return;
  }
  let start;
  let end;
  if (!match[1] && !match[2]) {
    res.writeHead(416, {
      "Access-Control-Allow-Origin": "*",
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${total}`
    });
    res.end();
    return;
  }
  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2], 10);
    start = Math.max(total - suffixLength, 0);
    end = total - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.writeHead(416, {
      "Access-Control-Allow-Origin": "*",
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${total}`
    });
    res.end();
    return;
  }
  end = Math.min(end, total - 1);
  res.writeHead(206, {
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl(filePath),
    "Content-Length": String(end - start + 1),
    "Content-Range": `bytes ${start}-${end}/${total}`,
    "Content-Type": contentType(filePath)
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function sendStream(filePath, stat, req, res) {
  res.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl(filePath),
    "Content-Length": String(stat.size),
    "Content-Type": contentType(filePath)
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

function isRangeCapable(filePath) {
  return [".mp4", ".m4v", ".webm", ".mp3", ".wav", ".ogg"].includes(path.extname(filePath).toLowerCase());
}

function cacheControl(filePath) {
  const normalized = filePath.replaceAll(path.sep, "/");
  if (normalized.includes("/vendor/") || normalized.includes("/assets/") || normalized.includes("/media/")) {
    return "public, max-age=31536000, immutable";
  }
  return contentType(filePath).includes("text/html") ? "no-store" : "public, max-age=60";
}

function send(res, status, body, type = "text/plain; charset=utf-8", cache = null, extraHeaders = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": cache || (type.includes("text/html") ? "no-store" : "public, max-age=60"),
    "Content-Type": type,
    ...extraHeaders
  });
  res.end(body);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg"
  };
  return types[ext] || "application/octet-stream";
}

function loadHttpsOptions() {
  const certPath = process.env.CERT_PATH || path.join(ROOT_DIR, "certs", "cert.pem");
  const keyPath = process.env.KEY_PATH || path.join(ROOT_DIR, "certs", "key.pem");
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  };
}

function lanAddresses() {
  const addresses = [];
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

function printUrl(label, port) {
  const local = `${label.toLowerCase()}://localhost:${port}/`;
  const lans = lanAddresses().map((ip) => `${label.toLowerCase()}://${ip}:${port}/`);
  console.log(`${label} ready: ${local}`);
  for (const url of lans) {
    console.log(`${label} LAN:   ${url}`);
  }
}
