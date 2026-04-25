import * as THREE from "/vendor/three/build/three.module.js";
import { VRButton } from "/vendor/three/examples/jsm/webxr/VRButton.js";

const canvas = document.getElementById("stageCanvas");
const inputStatus = document.getElementById("inputStatus");
const decisionStatus = document.getElementById("decisionStatus");
const portalStatus = document.getElementById("portalStatus");
const activeSceneLabel = document.getElementById("activeSceneLabel");
const activeSceneTitle = document.getElementById("activeSceneTitle");
const activeSceneDescription = document.getElementById("activeSceneDescription");
const enterButton = document.getElementById("enterButton");
const refreshButton = document.getElementById("refreshButton");
const scoreList = document.getElementById("scoreList");
const analysisPreview = document.getElementById("analysisPreview");

let config = null;
let decision = null;
let activePortal = null;
let roomBoundaryLine = null;
let skyDome = null;
let routeGuides = null;
let activeBeam = null;
let signalCore = null;
let routePanel = null;
const portals = new Map();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10100f);
scene.fog = new THREE.Fog(0x10100f, 4.2, 10.5);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
camera.position.set(0, 1.6, 0.35);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

document.body.appendChild(VRButton.createButton(renderer, {
  requiredFeatures: ["local-floor"],
  optionalFeatures: ["bounded-floor"]
}));

const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tmpMatrix = new THREE.Matrix4();
const userPosition = new THREE.Vector3();

const controllerState = {
  hovered: null,
  desktopHovered: null
};

initEnvironment();
setupControllers();
setupEvents();
await boot();
renderer.setAnimationLoop(render);

async function boot() {
  config = await fetchJson("/api/config");
  createPortalPlaceholders(config.scenes);
  createRouteGuides(config.scenes);
  await refreshDecision();
  connectEvents();
  prewarmAssets(config.scenes);
}

function initEnvironment() {
  scene.background = new THREE.Color(0xaec7d8);
  scene.fog = new THREE.Fog(0xaec7d8, 10, 32);

  skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(28, 48, 24),
    new THREE.MeshBasicMaterial({
      map: makeSkyTexture(),
      side: THREE.BackSide,
      fog: false
    })
  );
  scene.add(skyDome);

  const ambient = new THREE.HemisphereLight(0xf8fbff, 0x6d806f, 2.0);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.position.set(-3.5, 7.5, 4.8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 22;
  key.shadow.camera.left = -8;
  key.shadow.camera.right = 8;
  key.shadow.camera.top = 8;
  key.shadow.camera.bottom = -8;
  scene.add(key);

  const portalLight = new THREE.PointLight(0x87f7ce, 2.2, 8);
  portalLight.position.set(0, 2.2, -2.2);
  scene.add(portalLight);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 14),
    new THREE.MeshStandardMaterial({
      color: 0x8aa37a,
      roughness: 0.86,
      metalness: 0.02
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const groundPlate = new THREE.Mesh(
    new THREE.PlaneGeometry(6.2, 6.2),
    new THREE.MeshStandardMaterial({
      color: 0xc8c3b3,
      roughness: 0.74,
      metalness: 0.04
    })
  );
  groundPlate.rotation.x = -Math.PI / 2;
  groundPlate.position.y = 0.012;
  groundPlate.receiveShadow = true;
  scene.add(groundPlate);

  const grid = new THREE.GridHelper(6.2, 16, 0x9d8f76, 0xd9d1bd);
  grid.material.transparent = true;
  grid.material.opacity = 0.42;
  grid.position.y = 0.028;
  scene.add(grid);

  addRoomScaleBoundary();
  addCourtyardMarkers();
  addPortalDocks();
  addSignalCore();
  addScaleProps();

  addTextPanel({
    text: "Home Stage\nRoom Scale Portal Hub",
    position: [0, 2.78, -3.35],
    width: 2.9,
    height: 0.48,
    color: "#ffffff",
    background: "rgba(18,37,48,0.76)"
  });
  routePanel = addTextPanel({
    text: "JSONL Router\nwaiting for signal",
    position: [0, 1.24, -1.08],
    width: 1.72,
    height: 0.42,
    color: "#f8fafc",
    background: "rgba(10,22,28,0.78)"
  });
}

function addRoomScaleBoundary() {
  const bounds = [
    [-2.85, 0.04, -2.85],
    [2.85, 0.04, -2.85],
    [2.85, 0.04, 2.85],
    [-2.85, 0.04, 2.85],
    [-2.85, 0.04, -2.85]
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
  roomBoundaryLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(bounds),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.88 })
  );
  scene.add(roomBoundaryLine);

  const corners = [
    [-2.85, -2.85],
    [2.85, -2.85],
    [2.85, 2.85],
    [-2.85, 2.85]
  ];
  for (const [x, z] of corners) {
    const marker = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 0.1, 20),
      new THREE.MeshStandardMaterial({
        color: 0xf8fafc,
        emissive: 0x7dd3fc,
        emissiveIntensity: 0.3,
        roughness: 0.42
      })
    );
    marker.position.set(x, 0.08, z);
    marker.castShadow = true;
    scene.add(marker);
  }
}

function addCourtyardMarkers() {
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xd6c8a8,
    roughness: 0.82,
    metalness: 0.03
  });
  const positions = [
    [-3.75, 0.45, -3.55],
    [-1.25, 0.45, -3.72],
    [1.25, 0.45, -3.72],
    [3.75, 0.45, -3.55],
    [-4.25, 0.45, 0.2],
    [4.25, 0.45, 0.2]
  ];
  for (const position of positions) {
    const block = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.9, 0.24), wallMat);
    block.position.set(...position);
    block.castShadow = true;
    block.receiveShadow = true;
    scene.add(block);
  }

  const columnMat = new THREE.MeshStandardMaterial({
    color: 0xf2e3bd,
    roughness: 0.7,
    metalness: 0.08
  });
  for (const x of [-3.4, 3.4]) {
    for (const z of [-2.8, 2.15]) {
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 2.0, 24), columnMat);
      column.position.set(x, 1.0, z);
      column.castShadow = true;
      column.receiveShadow = true;
      scene.add(column);
    }
  }
}

function addPortalDocks() {
  const docks = [
    { position: [0, 0.035, -2.55], color: 0x7dd3fc },
    { position: [-1.45, 0.035, -2.15], color: 0xf97316 },
    { position: [1.45, 0.035, -2.15], color: 0xa78bfa }
  ];
  for (const dock of docks) {
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.64, 0.64, 0.055, 64),
      new THREE.MeshStandardMaterial({
        color: dock.color,
        emissive: dock.color,
        emissiveIntensity: 0.1,
        roughness: 0.5,
        metalness: 0.18
      })
    );
    pad.position.set(...dock.position);
    pad.receiveShadow = true;
    scene.add(pad);
  }

  const homeRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.05, 0.014, 12, 96),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 })
  );
  homeRing.rotation.x = -Math.PI / 2;
  homeRing.position.y = 0.07;
  scene.add(homeRing);
}

function addSignalCore() {
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x0f241d,
    emissive: 0x22c55e,
    emissiveIntensity: 0.44,
    roughness: 0.34,
    metalness: 0.45
  });
  signalCore = new THREE.Group();
  signalCore.position.set(0, 0.28, 0);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 0.28, 48), coreMat);
  base.castShadow = true;
  signalCore.add(base);

  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 0.72, 18),
    new THREE.MeshStandardMaterial({
      color: 0xeef2ff,
      emissive: 0x7dd3fc,
      emissiveIntensity: 0.36,
      roughness: 0.28,
      metalness: 0.55
    })
  );
  antenna.position.y = 0.48;
  signalCore.add(antenna);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.012, 12, 96),
    new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.68 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.18;
  signalCore.add(ring);
  signalCore.userData.ring = ring;
  scene.add(signalCore);

  activeBeam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 1, 16),
    new THREE.MeshBasicMaterial({
      color: 0x22c55e,
      transparent: true,
      opacity: 0,
      depthWrite: false
    })
  );
  activeBeam.visible = false;
  scene.add(activeBeam);
}

function addScaleProps() {
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x7c5a35, roughness: 0.68 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x2f3b44, roughness: 0.48, metalness: 0.25 });
  for (const [x, z, rot] of [[-2.15, 1.1, 0.26], [2.1, 1.05, -0.26]]) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rot;
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.12, 0.34), benchMat);
    seat.position.y = 0.43;
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.12, 0.34), benchMat);
    back.position.set(0, 0.74, 0.18);
    back.rotation.x = -0.35;
    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.44, 0.08), metalMat);
    leftLeg.position.set(-0.48, 0.22, -0.08);
    const rightLeg = leftLeg.clone();
    rightLeg.position.x = 0.48;
    group.add(seat, back, leftLeg, rightLeg);
    group.traverse((object) => {
      if (object.isMesh) object.castShadow = true;
    });
    scene.add(group);
  }

  const treeTrunk = new THREE.MeshStandardMaterial({ color: 0x705437, roughness: 0.9 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4f8f56, roughness: 0.8 });
  for (const [x, z, scale] of [[-5.3, -1.8, 1.0], [5.25, -1.2, 0.92], [-4.8, 3.9, 0.82], [4.6, 3.7, 0.88]]) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.11 * scale, 0.16 * scale, 1.2 * scale, 16), treeTrunk);
    trunk.position.set(x, 0.6 * scale, z);
    trunk.castShadow = true;
    scene.add(trunk);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.54 * scale, 24, 16), leafMat);
    crown.position.set(x, 1.35 * scale, z);
    crown.castShadow = true;
    scene.add(crown);
  }
}

function createPortalPlaceholders(scenes) {
  for (const item of scenes) {
    const portal = createPortal(item);
    portal.visible = false;
    portals.set(item.id, portal);
    scene.add(portal);

    const position = item.portal?.position || [0, 1.25, -2.3];
    addTextPanel({
      text: item.label || item.title,
      position: [position[0], 0.28, position[2] + 0.12],
      width: 0.72,
      height: 0.18,
      color: "#aaa396",
      background: "rgba(255,255,255,0.05)"
    });
  }
}

function createRouteGuides(scenes) {
  if (routeGuides) {
    scene.remove(routeGuides);
    routeGuides.traverse((object) => {
      object.geometry?.dispose?.();
      object.material?.dispose?.();
    });
  }

  routeGuides = new THREE.Group();
  for (const item of scenes) {
    const position = item.portal?.position || [0, 1.25, -2.3];
    const color = new THREE.Color(item.portal?.color || "#22c55e");
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.105, 0),
        new THREE.Vector3(position[0], 0.105, position[2])
      ]),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.28
      })
    );
    line.userData.sceneId = item.id;
    routeGuides.add(line);
  }
  scene.add(routeGuides);
}

function createPortal(item) {
  const color = new THREE.Color(item.portal?.color || "#22c55e");
  const accent = new THREE.Color(item.portal?.accent || "#ffffff");
  const position = item.portal?.position || [0, 1.25, -2.3];
  const group = new THREE.Group();
  group.position.set(position[0], position[1], position[2]);
  group.userData.scene = item;

  const outer = new THREE.Mesh(
    new THREE.TorusGeometry(0.52, 0.032, 24, 128),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.5,
      metalness: 0.45,
      roughness: 0.25
    })
  );
  outer.userData.portalRoot = group;
  group.add(outer);

  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(0.48, 96),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  inner.userData.portalRoot = group;
  group.add(inner);

  const hit = new THREE.Mesh(
    new THREE.CircleGeometry(0.62, 48),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide
    })
  );
  hit.name = "portal-hit";
  hit.userData.portalRoot = group;
  group.add(hit);

  const particles = new THREE.Group();
  for (let i = 0; i < 36; i += 1) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 10, 10),
      new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? accent : color })
    );
    const angle = (i / 36) * Math.PI * 2;
    dot.position.set(Math.cos(angle) * 0.68, Math.sin(angle) * 0.68, -0.02);
    dot.userData.angle = angle;
    particles.add(dot);
  }
  group.add(particles);
  group.userData.outer = outer;
  group.userData.inner = inner;
  group.userData.particles = particles;
  group.userData.baseScale = 1;

  addTextToGroup(group, item.title, [0, -0.78, 0.02], 1.25, 0.24);
  return group;
}

function addTextPanel({ text, position, width, height, color, background }) {
  const mesh = textMesh(text, width, height, { color, background });
  mesh.position.set(...position);
  scene.add(mesh);
  return mesh;
}

function addTextToGroup(group, text, position, width, height) {
  const mesh = textMesh(text, width, height, {
    color: "#f4f1e8",
    background: "rgba(16,16,15,0.56)"
  });
  mesh.position.set(...position);
  group.add(mesh);
}

function textMesh(text, width, height, options = {}) {
  const texture = makePanelTexture(text, options);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide })
  );
  mesh.userData.textOptions = options;
  return mesh;
}

function updateTextPanel(mesh, text, options = null) {
  if (!mesh?.material) return;
  const nextOptions = options || mesh.userData.textOptions || {};
  mesh.material.map?.dispose?.();
  mesh.material.map = makePanelTexture(text, nextOptions);
  mesh.material.needsUpdate = true;
  mesh.userData.textOptions = nextOptions;
}

function makePanelTexture(text, options = {}) {
  const canvasEl = document.createElement("canvas");
  canvasEl.width = 1024;
  canvasEl.height = 256;
  const ctx = canvasEl.getContext("2d");
  ctx.fillStyle = options.background || "rgba(0,0,0,0.55)";
  roundRect(ctx, 0, 0, canvasEl.width, canvasEl.height, 42);
  ctx.fill();
  ctx.fillStyle = options.color || "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = String(text).split("\n");
  const fontSize = options.fontSize || (lines.length > 2 ? 42 : 58);
  const lineGap = options.lineGap || Math.min(66, fontSize * 1.24);
  ctx.font = `700 ${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
  lines.forEach((line, index) => {
    fitLine(ctx, line, canvasEl.width - 96, canvasEl.width / 2, canvasEl.height / 2 + (index - (lines.length - 1) / 2) * lineGap);
  });
  const texture = new THREE.CanvasTexture(canvasEl);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function fitLine(ctx, text, maxWidth, x, y) {
  let value = String(text);
  while (ctx.measureText(value).width > maxWidth && value.length > 8) {
    value = `${value.slice(0, -2)}...`;
  }
  ctx.fillText(value, x, y);
}

function makeSkyTexture() {
  const canvasEl = document.createElement("canvas");
  canvasEl.width = 1024;
  canvasEl.height = 512;
  const ctx = canvasEl.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, canvasEl.height);
  gradient.addColorStop(0, "#7db8e8");
  gradient.addColorStop(0.42, "#d6edf8");
  gradient.addColorStop(0.74, "#f2ead1");
  gradient.addColorStop(1, "#91a878");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

  ctx.fillStyle = "rgba(255, 255, 255, 0.68)";
  for (const cloud of [
    [170, 118, 72, 24],
    [430, 86, 96, 28],
    [730, 138, 88, 24],
    [900, 92, 70, 20]
  ]) {
    const [x, y, width, height] = cloud;
    ctx.beginPath();
    ctx.ellipse(x, y, width, height, 0, 0, Math.PI * 2);
    ctx.ellipse(x + width * 0.42, y + 8, width * 0.58, height * 0.82, 0, 0, Math.PI * 2);
    ctx.ellipse(x - width * 0.36, y + 6, width * 0.52, height * 0.74, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = "rgba(56, 90, 76, 0.22)";
  ctx.beginPath();
  ctx.moveTo(0, 374);
  for (let x = 0; x <= canvasEl.width; x += 64) {
    ctx.lineTo(x, 360 + Math.sin(x * 0.018) * 24);
  }
  ctx.lineTo(canvasEl.width, canvasEl.height);
  ctx.lineTo(0, canvasEl.height);
  ctx.closePath();
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvasEl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function setupControllers() {
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    controller.userData.index = i;
    controller.addEventListener("selectstart", () => {
      if (controllerState.hovered) enterScene(controllerState.hovered.userData.scene);
    });
    const ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1.8)
      ]),
      new THREE.LineBasicMaterial({ color: 0xf4f1e8, transparent: true, opacity: 0.55 })
    );
    ray.name = "controller-ray";
    controller.add(ray);
    scene.add(controller);
  }
}

function setupEvents() {
  window.addEventListener("resize", onResize);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", () => {
    if (controllerState.desktopHovered) enterScene(controllerState.desktopHovered.userData.scene);
  });
  enterButton.addEventListener("click", () => {
    if (decision?.scene) enterScene(decision.scene);
  });
  refreshButton.addEventListener("click", refreshDecision);
  renderer.xr.addEventListener("sessionstart", () => {
    document.body.classList.add("xr-active");
    updateBoundedFloorFromSession();
  });
  renderer.xr.addEventListener("sessionend", () => document.body.classList.remove("xr-active"));
}

async function updateBoundedFloorFromSession() {
  const session = renderer.xr.getSession();
  if (!session?.requestReferenceSpace) return;
  try {
    const boundedRefSpace = await session.requestReferenceSpace("bounded-floor");
    const geometry = boundedRefSpace.boundsGeometry || [];
    if (geometry.length < 3 || !roomBoundaryLine) return;
    const points = geometry.map((point) => new THREE.Vector3(point.x, 0.055, point.z));
    points.push(points[0].clone());
    roomBoundaryLine.geometry.dispose();
    roomBoundaryLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
    roomBoundaryLine.material.color.setHex(0x22c55e);
    roomBoundaryLine.material.opacity = 0.95;
  } catch {
    // Quest browsers that do not expose bounded-floor still keep the local-floor scene usable.
  }
}

async function refreshDecision() {
  decision = await fetchJson("/api/decision");
  applyDecision(decision);
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.addEventListener("decision", (event) => {
    decision = JSON.parse(event.data);
    applyDecision(decision);
  });
  source.addEventListener("config", (event) => {
    decision = JSON.parse(event.data);
    applyDecision(decision);
  });
  source.onerror = () => {
    inputStatus.textContent = "reconnecting";
  };
}

function applyDecision(nextDecision) {
  inputStatus.textContent = nextDecision.inputExists ? `line ${nextDecision.line || 0}` : "missing";
  decisionStatus.textContent = nextDecision.ok ? nextDecision.reason : nextDecision.reason || "waiting";
  analysisPreview.textContent = JSON.stringify(summarizeAnalysis(nextDecision.analysis), null, 2);
  renderScores(nextDecision.scores || []);
  updateRoutePanel(nextDecision);

  for (const portal of portals.values()) {
    portal.visible = false;
  }

  if (!nextDecision.scene) {
    activePortal = null;
    portalStatus.textContent = "closed";
    activeSceneLabel.textContent = "等待输入";
    activeSceneTitle.textContent = "No portal";
    activeSceneDescription.textContent = "等待 first_person_analyses.jsonl 写入新的分析结果。";
    enterButton.disabled = true;
    setActiveBeam(null);
    return;
  }

  activePortal = portals.get(nextDecision.scene.id) || null;
  if (activePortal) {
    activePortal.userData.scene = nextDecision.scene;
    activePortal.visible = true;
    setActiveBeam(activePortal, nextDecision.scene);
  } else {
    setActiveBeam(null);
  }

  portalStatus.textContent = nextDecision.scene.label || nextDecision.scene.title;
  activeSceneLabel.textContent = nextDecision.scene.label || nextDecision.scene.id;
  activeSceneTitle.textContent = nextDecision.scene.title;
  activeSceneDescription.textContent = nextDecision.scene.description || nextDecision.scene.url;
  enterButton.disabled = false;
}

function updateRoutePanel(nextDecision) {
  const lineText = nextDecision.inputExists ? `jsonl line ${nextDecision.line || 0}` : "jsonl missing";
  const sceneText = nextDecision.scene
    ? `${nextDecision.scene.label || nextDecision.scene.id} / ${nextDecision.reason || "ready"}`
    : nextDecision.reason || "waiting";
  updateTextPanel(routePanel, `JSONL Router\n${lineText}\n${sceneText}`, {
    color: "#f8fafc",
    background: "rgba(10,22,28,0.78)",
    fontSize: 42,
    lineGap: 60
  });
}

function setActiveBeam(portal, sceneConfig = null) {
  if (!activeBeam) return;
  if (!portal) {
    activeBeam.visible = false;
    activeBeam.material.opacity = 0;
    return;
  }
  const color = new THREE.Color(sceneConfig?.portal?.color || "#22c55e");
  activeBeam.visible = true;
  activeBeam.material.color.copy(color);
  activeBeam.material.opacity = 0.48;
  const start = new THREE.Vector3(0, 0.13, 0);
  const end = new THREE.Vector3(portal.position.x, 0.13, portal.position.z);
  setCylinderBetween(activeBeam, start, end);
}

function setCylinderBetween(mesh, start, end) {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  if (length <= 0.001) return;
  mesh.position.copy(start).addScaledVector(direction, 0.5);
  mesh.scale.set(1, length, 1);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
}

function summarizeAnalysis(analysis) {
  if (!analysis) return {};
  return {
    id: analysis.id,
    trigger: analysis.trigger,
    source: analysis.source,
    scene: analysis.scene?.scene_guess || analysis.scene,
    interest_object: analysis.interest_object,
    possible_interactions: analysis.prediction?.possible_interactions
  };
}

function renderScores(scores) {
  scoreList.innerHTML = "";
  for (const item of scores.slice(0, 3)) {
    const row = document.createElement("div");
    row.className = "score-row";
    row.innerHTML = `
      <div>
        <span>${escapeHtml(item.scene.label || item.scene.id)}</span>
        <strong>${escapeHtml(item.scene.title)}</strong>
      </div>
      <strong>${item.score}</strong>
    `;
    scoreList.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function onPointerMove(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  controllerState.desktopHovered = findPortalHit(raycaster);
  document.body.style.cursor = controllerState.desktopHovered ? "pointer" : "default";
}

function updateControllerRaycasts() {
  controllerState.hovered = null;
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    tmpMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMatrix);
    const hit = findPortalHit(raycaster);
    const ray = controller.getObjectByName("controller-ray");
    if (ray) ray.material.opacity = hit ? 0.95 : 0.45;
    if (hit) controllerState.hovered = hit;
  }
}

function findPortalHit(activeRaycaster) {
  if (!activePortal || !activePortal.visible) return null;
  const targets = [];
  activePortal.traverse((object) => {
    if (object.name === "portal-hit") targets.push(object);
  });
  const hit = activeRaycaster.intersectObjects(targets, false)[0];
  return hit?.object?.userData?.portalRoot || null;
}

function checkWalkThroughPortal() {
  if (!renderer.xr.isPresenting || !activePortal) return;
  camera.getWorldPosition(userPosition);
  const portalPos = activePortal.getWorldPosition(new THREE.Vector3());
  const horizontalDistance = Math.hypot(userPosition.x - portalPos.x, userPosition.z - portalPos.z);
  if (horizontalDistance < (config.homeStage?.portalActivationDistance || 0.75)) {
    enterScene(activePortal.userData.scene);
  }
}

let navigating = false;
function enterScene(sceneConfig) {
  if (!sceneConfig || navigating) return;
  navigating = true;
  portalStatus.textContent = "opening";
  window.location.href = sceneConfig.url;
}

function render() {
  const elapsed = clock.getElapsedTime();
  if (skyDome) {
    skyDome.rotation.y = elapsed * 0.006;
  }
  if (signalCore) {
    signalCore.rotation.y = elapsed * 0.18;
    signalCore.userData.ring.material.opacity = 0.54 + Math.sin(elapsed * 2.4) * 0.14;
  }
  if (activeBeam?.visible) {
    activeBeam.material.opacity = 0.38 + Math.sin(elapsed * 4.2) * 0.1;
  }
  if (activePortal?.visible) {
    activePortal.rotation.z = Math.sin(elapsed * 0.8) * 0.03;
    activePortal.scale.setScalar(1 + Math.sin(elapsed * 2.1) * 0.025);
    activePortal.userData.inner.material.opacity = 0.16 + Math.sin(elapsed * 2.8) * 0.045;
    const particles = activePortal.userData.particles;
    particles.children.forEach((dot, index) => {
      const angle = dot.userData.angle + elapsed * (0.38 + (index % 4) * 0.035);
      const radius = 0.65 + Math.sin(elapsed * 1.7 + index) * 0.04;
      dot.position.x = Math.cos(angle) * radius;
      dot.position.y = Math.sin(angle) * radius;
    });
  }
  updateControllerRaycasts();
  checkWalkThroughPortal();
  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function prewarmAssets(scenes = []) {
  const urls = new Set([
    "/styles.css",
    "/vendor/three/build/three.module.js",
    "/vendor/three/build/three.core.js",
    "/vendor/three/examples/jsm/webxr/VRButton.js",
    "/vendor/webxr-input-profiles/profiles/profilesList.json"
  ]);

  for (const item of scenes) {
    if (item.url && isLocalAsset(item.url)) urls.add(item.url);
    if (item.media?.videoUrl && isLocalAsset(item.media.videoUrl)) urls.add(item.media.videoUrl);
    if (item.media?.audioUrl && isLocalAsset(item.media.audioUrl)) urls.add(item.media.audioUrl);
    if (item.url === "/scenes/cinema.html") urls.add("/scenes/cinema.js");
    if (item.url === "/scenes/garage-ktv.html") urls.add("/scenes/garage-ktv.js");
    if (item.url === "/game/") {
      urls.add("/game/assets/index-Ber1T3uz.js");
      urls.add("/game/assets/xrImmersiveScene-B3qtTzLF.js");
    }
  }

  for (const url of urls) {
    addPreloadHint(url);
  }

  const warm = () => {
    for (const url of urls) {
      warmFetch(url);
    }
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(warm, { timeout: 1800 });
  } else {
    window.setTimeout(warm, 600);
  }
}

function addPreloadHint(url) {
  const link = document.createElement("link");
  link.href = url;
  if (url.endsWith(".js")) {
    link.rel = "modulepreload";
  } else if (url.endsWith(".mp4")) {
    link.rel = "preload";
    link.as = "video";
  } else if (/\.(mp3|wav|ogg)$/.test(url)) {
    link.rel = "preload";
    link.as = "audio";
  } else {
    link.rel = "prefetch";
  }
  document.head.appendChild(link);
}

function warmFetch(url) {
  const media = /\.(mp4|m4v|webm|mp3|wav|ogg)$/.test(url);
  const headers = media ? { Range: "bytes=0-262143" } : undefined;
  fetch(url, { cache: "force-cache", headers }).catch(() => undefined);
}

function isLocalAsset(url) {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}
