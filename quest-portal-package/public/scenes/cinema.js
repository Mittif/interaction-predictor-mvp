import * as THREE from "/vendor/three/build/three.module.js";
import { VRButton } from "/vendor/three/examples/jsm/webxr/VRButton.js";

const canvas = document.getElementById("stageCanvas");
const video = document.getElementById("cinemaVideo");
const homeButton = document.getElementById("homeButton");
const playButton = document.getElementById("playButton");
const muteButton = document.getElementById("muteButton");

let hoveredTarget = null;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060606);
scene.fog = new THREE.Fog(0x060606, 5, 18);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 80);
camera.position.set(0, 1.55, 2.2);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(VRButton.createButton(renderer, {
  requiredFeatures: ["local-floor"],
  optionalFeatures: ["bounded-floor"]
}));

const raycaster = new THREE.Raycaster();
const tmpMatrix = new THREE.Matrix4();
const interactive = [];
const videoTexture = new THREE.VideoTexture(video);
videoTexture.colorSpace = THREE.SRGBColorSpace;
videoTexture.minFilter = THREE.LinearFilter;
videoTexture.magFilter = THREE.LinearFilter;
const screenPlaceholderTexture = makeScreenPlaceholderTexture();
let screenMaterial = null;

buildCinema();
setupControllers();
setupEvents();
renderer.setAnimationLoop(render);

function buildCinema() {
  const ambient = new THREE.HemisphereLight(0xc7d2fe, 0x050505, 0.72);
  scene.add(ambient);

  const projector = new THREE.SpotLight(0xcfe8ff, 4.2, 9, Math.PI / 6, 0.5, 1.2);
  projector.position.set(0, 2.8, 2.45);
  projector.target.position.set(0, 1.55, -3.1);
  scene.add(projector);
  scene.add(projector.target);

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(8.4, 0.08, 9.2),
    new THREE.MeshStandardMaterial({ color: 0x181818, roughness: 0.9 })
  );
  floor.position.y = -0.04;
  floor.receiveShadow = true;
  scene.add(floor);

  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(8.4, 3.5, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.92 })
  );
  backWall.position.set(0, 1.75, -3.55);
  scene.add(backWall);

  const screenFrame = new THREE.Mesh(
    new THREE.BoxGeometry(4.5, 2.62, 0.08),
    new THREE.MeshStandardMaterial({
      color: 0x030303,
      roughness: 0.28,
      metalness: 0.36,
      emissive: 0x050505,
      emissiveIntensity: 0.8
    })
  );
  screenFrame.position.set(0, 1.72, -3.42);
  scene.add(screenFrame);

  screenMaterial = new THREE.MeshBasicMaterial({ map: screenPlaceholderTexture, toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(4.24, 2.38), screenMaterial);
  screen.position.set(0, 1.72, -3.365);
  scene.add(screen);

  createSeats();
  createControls();
}

function createSeats() {
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x512020, roughness: 0.78 });
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const group = new THREE.Group();
      group.position.set((col - 2) * 0.72, 0.18 + row * 0.1, 0.1 + row * 0.82);
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.22, 0.46), seatMat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.58, 0.12), seatMat);
      back.position.set(0, 0.32, 0.24);
      group.add(base, back);
      scene.add(group);
    }
  }
}

function createControls() {
  addActionButton({
    label: "播放",
    position: [-0.54, 0.8, -2.22],
    color: 0x7dd3fc,
    action: togglePlay
  });
  addActionButton({
    label: "静音",
    position: [0.08, 0.8, -2.22],
    color: 0xa78bfa,
    action: toggleMute
  });
  addActionButton({
    label: "Home",
    position: [0.7, 0.8, -2.22],
    color: 0x22c55e,
    action: goHome
  });
}

function addActionButton({ label, position, color, action }) {
  const group = new THREE.Group();
  group.position.set(...position);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.48, 0.18, 0.08),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.28,
      roughness: 0.45,
      metalness: 0.22
    })
  );
  mesh.userData.action = action;
  mesh.castShadow = true;
  group.add(mesh);
  const text = makeTextPlane(label, 0.38, 0.1);
  text.position.z = 0.047;
  group.add(text);
  interactive.push(mesh);
  scene.add(group);
}

function setupControllers() {
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    controller.addEventListener("selectstart", () => {
      if (hoveredTarget?.userData?.action) hoveredTarget.userData.action();
    });
    const ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -2)
      ]),
      new THREE.LineBasicMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.55 })
    );
    ray.name = "controller-ray";
    controller.add(ray);
    scene.add(controller);
  }
}

function setupEvents() {
  window.addEventListener("resize", onResize);
  renderer.xr.addEventListener("sessionstart", () => document.body.classList.add("xr-active"));
  renderer.xr.addEventListener("sessionend", () => document.body.classList.remove("xr-active"));
  homeButton.addEventListener("click", goHome);
  playButton.addEventListener("click", togglePlay);
  muteButton.addEventListener("click", toggleMute);
  video.addEventListener("play", () => {
    playButton.textContent = "暂停";
    if (screenMaterial?.map !== videoTexture) {
      screenMaterial.map = videoTexture;
      screenMaterial.needsUpdate = true;
    }
  });
  video.addEventListener("pause", () => {
    playButton.textContent = "播放";
  });
}

async function togglePlay() {
  if (video.paused) {
    try {
      await video.play();
    } catch {
      video.muted = true;
      await video.play().catch(() => undefined);
    }
    return;
  }
  video.pause();
}

function toggleMute() {
  video.muted = !video.muted;
  muteButton.textContent = video.muted ? "取消静音" : "静音";
}

function goHome() {
  video.pause();
  window.location.href = "/";
}

function updateControllerRaycasts() {
  hoveredTarget = null;
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    tmpMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMatrix);
    const hit = raycaster.intersectObjects(interactive, false)[0];
    const ray = controller.getObjectByName("controller-ray");
    if (ray) ray.material.opacity = hit ? 0.95 : 0.45;
    if (hit) hoveredTarget = hit.object;
  }
  interactive.forEach((mesh) => {
    mesh.scale.setScalar(mesh === hoveredTarget ? 1.12 : 1);
  });
}

function render() {
  updateControllerRaycasts();
  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function makeTextPlane(text, width, height) {
  const canvasEl = document.createElement("canvas");
  canvasEl.width = 512;
  canvasEl.height = 160;
  const ctx = canvasEl.getContext("2d");
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.fillStyle = "#f8fafc";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 56px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(text, canvasEl.width / 2, canvasEl.height / 2);
  const texture = new THREE.CanvasTexture(canvasEl);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide })
  );
}

function makeScreenPlaceholderTexture() {
  const canvasEl = document.createElement("canvas");
  canvasEl.width = 1280;
  canvasEl.height = 720;
  const ctx = canvasEl.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, canvasEl.width, canvasEl.height);
  gradient.addColorStop(0, "#0f172a");
  gradient.addColorStop(0.55, "#111827");
  gradient.addColorStop(1, "#082f49");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.fillStyle = "rgba(125, 211, 252, 0.18)";
  ctx.fillRect(0, canvasEl.height * 0.58, canvasEl.width, 6);
  ctx.fillStyle = "#e0f2fe";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 72px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText("Cinema Ready", canvasEl.width / 2, canvasEl.height / 2 - 24);
  ctx.font = "500 36px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = "#bae6fd";
  ctx.fillText("Press Play or use controller trigger", canvasEl.width / 2, canvasEl.height / 2 + 58);
  const texture = new THREE.CanvasTexture(canvasEl);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
