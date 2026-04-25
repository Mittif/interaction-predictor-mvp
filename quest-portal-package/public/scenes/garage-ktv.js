import * as THREE from "/vendor/three/build/three.module.js";
import { VRButton } from "/vendor/three/examples/jsm/webxr/VRButton.js";

const canvas = document.getElementById("stageCanvas");
const homeButton = document.getElementById("homeButton");
const songButton = document.getElementById("songButton");
const lightButton = document.getElementById("lightButton");
const musicButton = document.getElementById("musicButton");

const songs = [
  "夜色里的车库派对",
  "家庭 KTV 模式",
  "霓虹副歌练习",
  "午夜合唱"
];

let songIndex = 0;
let lightMode = 0;
let hoveredTarget = null;
let musicPlaying = false;
let audioListener = null;
let positionalAudio = null;
const ktvAudio = new Audio("/media/garage-ktv-loop.wav");
ktvAudio.loop = true;
ktvAudio.preload = "auto";
ktvAudio.volume = 0.45;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14110e);
scene.fog = new THREE.Fog(0x14110e, 4, 12);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 80);
camera.position.set(0, 1.58, 1.2);
audioListener = new THREE.AudioListener();
camera.add(audioListener);

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

const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const tmpMatrix = new THREE.Matrix4();
const interactive = [];
const neonLights = [];
const speakerPulses = [];
let lyricPanel = null;

buildGarage();
setupControllers();
setupEvents();
renderer.setAnimationLoop(render);

function buildGarage() {
  const ambient = new THREE.HemisphereLight(0xf7e7c7, 0x20140f, 1.1);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xfff3dc, 1.9);
  key.position.set(2.4, 4.2, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(7.5, 0.08, 7.5),
    new THREE.MeshStandardMaterial({ color: 0x2b2924, roughness: 0.84, metalness: 0.1 })
  );
  floor.position.y = -0.04;
  floor.receiveShadow = true;
  scene.add(floor);

  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(7.5, 3.2, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x211c17, roughness: 0.9 })
  );
  backWall.position.set(0, 1.6, -3.15);
  backWall.receiveShadow = true;
  scene.add(backWall);

  const leftWall = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 3.2, 7.5),
    new THREE.MeshStandardMaterial({ color: 0x1c1915, roughness: 0.92 })
  );
  leftWall.position.set(-3.75, 1.6, 0);
  scene.add(leftWall);

  const rightWall = leftWall.clone();
  rightWall.position.x = 3.75;
  scene.add(rightWall);

  const garageDoor = new THREE.Mesh(
    new THREE.BoxGeometry(4.4, 2.25, 0.08),
    new THREE.MeshStandardMaterial({
      color: 0x3b342b,
      roughness: 0.55,
      metalness: 0.25
    })
  );
  garageDoor.position.set(0, 1.35, 3.42);
  garageDoor.rotation.y = Math.PI;
  scene.add(garageDoor);

  for (let i = 0; i < 7; i += 1) {
    const slat = new THREE.Mesh(
      new THREE.BoxGeometry(4.48, 0.025, 0.04),
      new THREE.MeshBasicMaterial({ color: 0x6f6252, transparent: true, opacity: 0.42 })
    );
    slat.position.set(0, 0.45 + i * 0.28, 3.36);
    scene.add(slat);
  }

  createKtvScreen();
  createSpeakers();
  createSofa();
  createCarSilhouette();
  createMicrophones();
  createControlButtons();
  createNeon();
}

function createKtvScreen() {
  const screenFrame = new THREE.Mesh(
    new THREE.BoxGeometry(2.55, 1.18, 0.08),
    new THREE.MeshStandardMaterial({
      color: 0x090807,
      roughness: 0.35,
      metalness: 0.28,
      emissive: 0x110a03,
      emissiveIntensity: 0.4
    })
  );
  screenFrame.position.set(0, 1.84, -3.02);
  screenFrame.castShadow = true;
  scene.add(screenFrame);

  lyricPanel = makeTextPlane(screenText(), 2.35, 0.94, {
    color: "#fff7ed",
    background: "#1c1209",
    accent: "#f97316"
  });
  lyricPanel.position.set(0, 1.84, -2.965);
  scene.add(lyricPanel);
}

function createSpeakers() {
  const cabinetMat = new THREE.MeshStandardMaterial({
    color: 0x0b0b0b,
    roughness: 0.38,
    metalness: 0.22,
    emissive: 0x1f0b02,
    emissiveIntensity: 0.2
  });
  const coneMat = new THREE.MeshStandardMaterial({
    color: 0xf97316,
    emissive: 0xf97316,
    emissiveIntensity: 0.28,
    roughness: 0.5
  });

  for (const x of [-1.68, 1.68]) {
    const speaker = new THREE.Group();
    speaker.position.set(x, 1.22, -2.92);
    const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.78, 0.26), cabinetMat);
    cabinet.castShadow = true;
    speaker.add(cabinet);

    for (const y of [-0.18, 0.18]) {
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.045, 32), coneMat);
      cone.rotation.x = Math.PI / 2;
      cone.position.set(0, y, 0.15);
      speaker.add(cone);
    }

    const pulse = new THREE.Mesh(
      new THREE.TorusGeometry(0.24, 0.006, 8, 64),
      new THREE.MeshBasicMaterial({
        color: 0xf97316,
        transparent: true,
        opacity: 0.18,
        depthWrite: false
      })
    );
    pulse.position.z = 0.165;
    speaker.add(pulse);
    speakerPulses.push(pulse);
    scene.add(speaker);
  }

  const emitter = new THREE.Group();
  emitter.position.set(0, 1.32, -2.86);
  scene.add(emitter);
  setupSpatialAudio(emitter);
}

function setupSpatialAudio(parent) {
  if (!audioListener) return;
  try {
    positionalAudio = new THREE.PositionalAudio(audioListener);
    positionalAudio.setMediaElementSource(ktvAudio);
    positionalAudio.setRefDistance(1.05);
    positionalAudio.setRolloffFactor(1.75);
    positionalAudio.setDistanceModel("inverse");
    positionalAudio.setMaxDistance(7);
    if (typeof positionalAudio.setDirectionalCone === "function") {
      positionalAudio.setDirectionalCone(160, 230, 0.28);
    }
    parent.add(positionalAudio);
  } catch {
    positionalAudio = null;
  }
}

function createSofa() {
  const sofaMat = new THREE.MeshStandardMaterial({
    color: 0x644331,
    roughness: 0.72,
    metalness: 0.05
  });
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.34, 0.72), sofaMat);
  base.position.set(-1.05, 0.38, -1.55);
  base.castShadow = true;
  scene.add(base);
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.48, 0.86, 0.18), sofaMat);
  back.position.set(-1.05, 0.84, -1.86);
  back.castShadow = true;
  scene.add(back);
  for (let i = 0; i < 3; i += 1) {
    const cushion = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.18, 0.62),
      new THREE.MeshStandardMaterial({ color: 0x7a5039, roughness: 0.82 })
    );
    cushion.position.set(-1.78 + i * 0.72, 0.63, -1.44);
    cushion.castShadow = true;
    scene.add(cushion);
  }
}

function createCarSilhouette() {
  const carGroup = new THREE.Group();
  carGroup.position.set(1.5, 0.28, -0.82);
  carGroup.rotation.y = -0.16;
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x32343a,
    roughness: 0.42,
    metalness: 0.52
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.46, 0.86), bodyMat);
  body.castShadow = true;
  carGroup.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.44, 0.7), bodyMat);
  cabin.position.set(-0.08, 0.4, 0);
  cabin.castShadow = true;
  carGroup.add(cabin);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.7 });
  for (const x of [-0.72, 0.72]) {
    for (const z of [-0.46, 0.46]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.12, 32), wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, -0.24, z);
      carGroup.add(wheel);
    }
  }
  scene.add(carGroup);
}

function createMicrophones() {
  const standMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.7, roughness: 0.25 });
  const micMat = new THREE.MeshStandardMaterial({ color: 0xf4f1e8, metalness: 0.5, roughness: 0.32 });
  for (const x of [-0.34, 0.34]) {
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.05, 16), standMat);
    stand.position.set(x, 0.72, -0.62);
    scene.add(stand);
    const mic = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.26, 8, 16), micMat);
    mic.position.set(x, 1.28, -0.62);
    mic.rotation.z = Math.PI / 2.8;
    mic.castShadow = true;
    scene.add(mic);
  }
}

function createControlButtons() {
  addActionButton({
    id: "song",
    label: "换歌",
    position: [-0.42, 1.1, -2.35],
    color: 0xf97316,
    action: nextSong
  });
  addActionButton({
    id: "lights",
    label: "灯光",
    position: [0.42, 1.1, -2.35],
    color: 0x22c55e,
    action: nextLightMode
  });
  addActionButton({
    id: "music",
    label: "音乐",
    position: [0.9, 0.86, -2.35],
    color: 0x38bdf8,
    action: toggleMusic
  });
  addActionButton({
    id: "home",
    label: "Home",
    position: [0, 0.62, -2.35],
    color: 0xa78bfa,
    action: goHome
  });
}

function addActionButton({ id, label, position, color, action }) {
  const group = new THREE.Group();
  group.position.set(...position);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.44, 0.18, 0.08),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.32,
      roughness: 0.45,
      metalness: 0.2
    })
  );
  mesh.userData.action = action;
  mesh.userData.id = id;
  mesh.castShadow = true;
  group.add(mesh);
  const text = makeTextPlane(label, 0.36, 0.1, {
    color: "#fff7ed",
    background: "rgba(0,0,0,0)"
  });
  text.position.z = 0.047;
  group.add(text);
  interactive.push(mesh);
  scene.add(group);
}

function createNeon() {
  const colors = [0xf97316, 0x22c55e, 0xa78bfa];
  for (let i = 0; i < 3; i += 1) {
    const light = new THREE.PointLight(colors[i], 1.4, 4.2);
    light.position.set(-2.0 + i * 2, 2.75, -1.4);
    neonLights.push(light);
    scene.add(light);
    const tube = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.035, 0.035),
      new THREE.MeshBasicMaterial({ color: colors[i] })
    );
    tube.position.copy(light.position);
    tube.rotation.z = i % 2 === 0 ? 0.25 : -0.25;
    scene.add(tube);
  }
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
        new THREE.Vector3(0, 0, -1.8)
      ]),
      new THREE.LineBasicMaterial({ color: 0xfff7ed, transparent: true, opacity: 0.55 })
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
  songButton.addEventListener("click", nextSong);
  lightButton.addEventListener("click", nextLightMode);
  musicButton.addEventListener("click", toggleMusic);
}

function nextSong() {
  songIndex = (songIndex + 1) % songs.length;
  updateScreen();
}

function nextLightMode() {
  lightMode = (lightMode + 1) % 3;
  updateLights();
}

async function toggleMusic() {
  if (musicPlaying) {
    ktvAudio.pause();
    musicPlaying = false;
    musicButton.textContent = "音乐";
    return;
  }
  try {
    await audioListener?.context?.resume?.();
    await ktvAudio.play();
    musicPlaying = true;
    musicButton.textContent = "暂停音乐";
  } catch {
    musicPlaying = false;
  }
}

function goHome() {
  ktvAudio.pause();
  window.location.href = "/";
}

function updateScreen() {
  if (!lyricPanel) return;
  lyricPanel.material.map.dispose();
  lyricPanel.material.map = makeTextTexture(screenText(), {
    color: "#fff7ed",
    background: "#1c1209",
    accent: "#f97316"
  });
  lyricPanel.material.needsUpdate = true;
}

function screenText() {
  return `${songs[songIndex]}\n手柄射线选择按钮\nTrigger: 换歌 / 灯光 / Home`;
}

function updateLights() {
  const palettes = [
    [0xf97316, 0x22c55e, 0xa78bfa],
    [0xef4444, 0xfacc15, 0x38bdf8],
    [0xffffff, 0xf97316, 0x22c55e]
  ];
  neonLights.forEach((light, index) => {
    light.color.setHex(palettes[lightMode][index]);
    light.intensity = 1.25 + lightMode * 0.45;
  });
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
  const elapsed = clock.getElapsedTime();
  neonLights.forEach((light, index) => {
    light.intensity += Math.sin(elapsed * 2 + index) * 0.01;
  });
  speakerPulses.forEach((pulse, index) => {
    const wave = musicPlaying ? (Math.sin(elapsed * 5.2 + index) + 1) * 0.5 : 0;
    pulse.scale.setScalar(1 + wave * 0.26);
    pulse.material.opacity = musicPlaying ? 0.16 + wave * 0.34 : 0.08;
  });
  updateControllerRaycasts();
  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function makeTextPlane(text, width, height, options) {
  const texture = makeTextTexture(text, options);
  return new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide })
  );
}

function makeTextTexture(text, options = {}) {
  const canvasEl = document.createElement("canvas");
  canvasEl.width = 1024;
  canvasEl.height = 512;
  const ctx = canvasEl.getContext("2d");
  ctx.fillStyle = options.background || "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
  if (options.accent) {
    ctx.fillStyle = options.accent;
    ctx.fillRect(0, 0, canvasEl.width, 18);
  }
  ctx.fillStyle = options.color || "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 54px system-ui, -apple-system, Segoe UI, sans-serif";
  const lines = String(text).split("\n");
  lines.forEach((line, index) => {
    ctx.fillText(line, canvasEl.width / 2, 150 + index * 92);
  });
  const texture = new THREE.CanvasTexture(canvasEl);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
