import * as THREE from "/vendor/three/build/three.module.js";
import { VRButton } from "/vendor/three/examples/jsm/webxr/VRButton.js";

const canvas = document.getElementById("stageCanvas");
const video = document.getElementById("cinemaVideo");
const homeButton = document.getElementById("homeButton");
const playButton = document.getElementById("playButton");
const muteButton = document.getElementById("muteButton");

let hoveredTarget = null;
const aisleLights = [];
const xrControlButtons = [];
let playIconHolder = null;
let muteIconHolder = null;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060606);
scene.fog = new THREE.Fog(0x060606, 5, 18);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 80);
camera.position.set(0, 1.28, 2.24);

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
const clock = new THREE.Clock();
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
    new THREE.MeshStandardMaterial({ color: 0x151313, roughness: 0.86 })
  );
  floor.position.y = -0.04;
  floor.receiveShadow = true;
  scene.add(floor);

  createRoomShell();
  createAisleAndWallDetails();

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

  createCurtainsAndScreenGlow();
  createSeats();
  createViewerSeat();
  createControls();
}

function createRoomShell() {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.88 });
  const sideWallLeft = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.5, 9.2), wallMat);
  sideWallLeft.position.set(-4.2, 1.75, 0);
  scene.add(sideWallLeft);
  const sideWallRight = sideWallLeft.clone();
  sideWallRight.position.x = 4.2;
  scene.add(sideWallRight);

  const rearWall = new THREE.Mesh(new THREE.BoxGeometry(8.4, 3.5, 0.12), wallMat);
  rearWall.position.set(0, 1.75, 4.58);
  scene.add(rearWall);

  const ceiling = new THREE.Mesh(
    new THREE.BoxGeometry(8.4, 0.1, 9.2),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.82 })
  );
  ceiling.position.set(0, 3.46, 0);
  scene.add(ceiling);

  for (const z of [-2.7, -1.2, 0.3, 1.8, 3.3]) {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(8.0, 0.06, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x24201d, roughness: 0.72, metalness: 0.08 })
    );
    beam.position.set(0, 3.36, z);
    scene.add(beam);
  }
}

function createAisleAndWallDetails() {
  const carpet = new THREE.Mesh(
    new THREE.PlaneGeometry(1.16, 6.2),
    new THREE.MeshStandardMaterial({ color: 0x2c0d13, roughness: 0.95 })
  );
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.set(0, 0.012, 1.22);
  scene.add(carpet);

  const trimMat = new THREE.MeshStandardMaterial({ color: 0x352923, roughness: 0.7 });
  for (const x of [-3.95, 3.95]) {
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 8.4), trimMat);
    trim.position.set(x, 0.28, 0.25);
    scene.add(trim);
  }

  const panelMat = new THREE.MeshStandardMaterial({ color: 0x221d1d, roughness: 0.94 });
  for (const x of [-4.12, 4.12]) {
    for (const z of [-2.0, -0.75, 0.5, 1.75, 3.0]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.82, 0.58), panelMat);
      panel.position.set(x, 1.68, z);
      panel.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2;
      scene.add(panel);
    }
  }

  for (const x of [-0.72, 0.72]) {
    for (const z of [-0.8, 0.25, 1.3, 2.35]) {
      const lamp = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.055, 0.035, 24),
        new THREE.MeshStandardMaterial({
          color: 0xffdca8,
          emissive: 0xff9f3f,
          emissiveIntensity: 0.65,
          roughness: 0.45
        })
      );
      lamp.position.set(x, 0.045, z);
      lamp.rotation.x = Math.PI / 2;
      aisleLights.push(lamp);
      scene.add(lamp);
    }
  }
}

function createCurtainsAndScreenGlow() {
  const curtainMat = new THREE.MeshStandardMaterial({
    color: 0x3f1117,
    roughness: 0.92,
    metalness: 0.02
  });
  for (const x of [-2.5, 2.5]) {
    const curtain = new THREE.Mesh(new THREE.BoxGeometry(0.42, 2.7, 0.12), curtainMat);
    curtain.position.set(x, 1.68, -3.32);
    curtain.castShadow = true;
    scene.add(curtain);
    for (let i = 0; i < 4; i += 1) {
      const fold = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.62, 12), curtainMat);
      fold.position.set(x + (i - 1.5) * 0.1, 1.68, -3.24);
      scene.add(fold);
    }
  }

  const glow = new THREE.PointLight(0x7dd3fc, 1.5, 4.8);
  glow.position.set(0, 1.72, -2.72);
  scene.add(glow);
}

function createSeats() {
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x512020, roughness: 0.78 });
  const armMat = new THREE.MeshStandardMaterial({ color: 0x120b0b, roughness: 0.64, metalness: 0.12 });
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const group = new THREE.Group();
      group.position.set((col - 2) * 0.72, 0.18 + row * 0.1, 0.1 + row * 0.82);
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.22, 0.46), seatMat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.58, 0.12), seatMat);
      back.position.set(0, 0.32, 0.24);
      const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.46), armMat);
      leftArm.position.set(-0.3, 0.11, 0);
      const rightArm = leftArm.clone();
      rightArm.position.x = 0.3;
      group.add(base, back, leftArm, rightArm);
      group.traverse((object) => {
        if (object.isMesh) object.castShadow = true;
      });
      scene.add(group);
    }
  }
}

function createViewerSeat() {
  const group = new THREE.Group();
  group.position.set(0, 0, 2.02);

  const seatMat = new THREE.MeshStandardMaterial({
    color: 0x5c2027,
    roughness: 0.78,
    metalness: 0.02
  });
  const armMat = new THREE.MeshStandardMaterial({
    color: 0x120909,
    roughness: 0.58,
    metalness: 0.18
  });
  const cupMat = new THREE.MeshStandardMaterial({
    color: 0x030303,
    roughness: 0.38,
    metalness: 0.52
  });

  const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.16, 0.72), seatMat);
  cushion.position.set(0, 0.34, 0.04);
  const frontLip = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.16, 0.12), seatMat);
  frontLip.position.set(0, 0.42, -0.32);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.82, 0.14), seatMat);
  back.position.set(0, 0.76, 0.45);
  back.rotation.x = -0.08;

  const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.82), armMat);
  leftArm.position.set(-0.58, 0.58, 0.03);
  const rightArm = leftArm.clone();
  rightArm.position.x = 0.58;

  for (const x of [-0.58, 0.58]) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.075, 0.04, 28), cupMat);
    cup.position.set(x, 0.76, -0.22);
    cup.rotation.x = Math.PI / 2;
    group.add(cup);
  }

  group.add(cushion, frontLip, back, leftArm, rightArm);
  group.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  scene.add(group);
}

function createControls() {
  addActionButton({
    id: "play",
    icon: "play",
    position: [0.82, 0.78, 1.62],
    rotationY: -0.55,
    color: 0x7dd3fc,
    action: togglePlay
  });
  addActionButton({
    id: "mute",
    icon: "speaker",
    position: [0.82, 0.62, 1.62],
    rotationY: -0.55,
    color: 0xa78bfa,
    action: toggleMute
  });
  addActionButton({
    id: "home",
    icon: "home",
    position: [0.82, 0.46, 1.62],
    rotationY: -0.55,
    color: 0x22c55e,
    action: goHome
  });
}

function addActionButton({ id, icon, position, rotationY = 0, color, action }) {
  const group = new THREE.Group();
  group.position.set(...position);
  group.rotation.y = rotationY;
  group.visible = false;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.12, 0.06),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.28,
      roughness: 0.45,
      metalness: 0.22
    })
  );
  mesh.userData.action = action;
  mesh.userData.id = id;
  mesh.castShadow = true;
  group.add(mesh);
  const iconHolder = new THREE.Group();
  iconHolder.position.z = 0.036;
  iconHolder.scale.setScalar(0.78);
  setIcon(iconHolder, icon);
  group.add(iconHolder);
  if (id === "play") playIconHolder = iconHolder;
  if (id === "mute") muteIconHolder = iconHolder;
  interactive.push(mesh);
  xrControlButtons.push(group);
  scene.add(group);
}

function setIcon(holder, icon) {
  while (holder.children.length > 0) {
    holder.remove(holder.children[0]);
  }
  holder.add(...createIconParts(icon));
  holder.userData.icon = icon;
}

function createIconParts(icon) {
  const material = new THREE.MeshBasicMaterial({
    color: 0xf8fafc,
    transparent: true,
    opacity: 0.95,
    side: THREE.DoubleSide
  });
  if (icon === "pause") {
    const left = new THREE.Mesh(new THREE.PlaneGeometry(0.055, 0.14), material);
    left.position.x = -0.04;
    const right = left.clone();
    right.position.x = 0.04;
    return [left, right];
  }
  if (icon === "speaker" || icon === "muted") {
    const speakerShape = new THREE.Shape();
    speakerShape.moveTo(-0.12, -0.045);
    speakerShape.lineTo(-0.055, -0.045);
    speakerShape.lineTo(0.025, -0.095);
    speakerShape.lineTo(0.025, 0.095);
    speakerShape.lineTo(-0.055, 0.045);
    speakerShape.lineTo(-0.12, 0.045);
    speakerShape.lineTo(-0.12, -0.045);
    const speaker = new THREE.Mesh(new THREE.ShapeGeometry(speakerShape), material);
    if (icon === "muted") {
      const slash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.022), material);
      slash.rotation.z = -0.78;
      return [speaker, slash];
    }
    const wave = new THREE.Mesh(new THREE.RingGeometry(0.085, 0.105, 24, 1, -0.76, 1.52), material);
    wave.position.x = 0.015;
    return [speaker, wave];
  }
  if (icon === "home") {
    const homeShape = new THREE.Shape();
    homeShape.moveTo(-0.11, -0.07);
    homeShape.lineTo(-0.11, 0.015);
    homeShape.lineTo(0, 0.1);
    homeShape.lineTo(0.11, 0.015);
    homeShape.lineTo(0.11, -0.07);
    homeShape.lineTo(0.045, -0.07);
    homeShape.lineTo(0.045, -0.005);
    homeShape.lineTo(-0.045, -0.005);
    homeShape.lineTo(-0.045, -0.07);
    homeShape.lineTo(-0.11, -0.07);
    return [new THREE.Mesh(new THREE.ShapeGeometry(homeShape), material)];
  }
  const playShape = new THREE.Shape();
  playShape.moveTo(-0.07, -0.09);
  playShape.lineTo(-0.07, 0.09);
  playShape.lineTo(0.09, 0);
  playShape.lineTo(-0.07, -0.09);
  return [new THREE.Mesh(new THREE.ShapeGeometry(playShape), material)];
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
    setPlayVisual(true);
    if (screenMaterial?.map !== videoTexture) {
      screenMaterial.map = videoTexture;
      screenMaterial.needsUpdate = true;
    }
  });
  video.addEventListener("pause", () => {
    setPlayVisual(false);
  });
  video.addEventListener("volumechange", () => setMuteVisual(video.muted));
  setPlayVisual(!video.paused);
  setMuteVisual(video.muted);
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
  setMuteVisual(video.muted);
}

function setPlayVisual(isPlaying) {
  playButton.classList.toggle("is-playing", isPlaying);
  playButton.setAttribute("aria-label", isPlaying ? "暂停" : "播放");
  if (playIconHolder) setIcon(playIconHolder, isPlaying ? "pause" : "play");
}

function setMuteVisual(isMuted) {
  muteButton.classList.toggle("is-muted", isMuted);
  muteButton.setAttribute("aria-label", isMuted ? "取消静音" : "静音");
  if (muteIconHolder) setIcon(muteIconHolder, isMuted ? "muted" : "speaker");
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
  const elapsed = clock.getElapsedTime();
  aisleLights.forEach((lamp, index) => {
    lamp.material.emissiveIntensity = 0.55 + Math.sin(elapsed * 1.7 + index) * 0.06;
  });
  xrControlButtons.forEach((group) => {
    group.visible = renderer.xr.isPresenting;
  });
  updateControllerRaycasts();
  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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
  ctx.font = "700 72px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText("ASCII HELLO WORLD", canvasEl.width / 2, canvasEl.height / 2 - 24);
  ctx.font = "500 36px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = "#bae6fd";
  ctx.fillText("Use the visual play button or controller trigger", canvasEl.width / 2, canvasEl.height / 2 + 58);
  const texture = new THREE.CanvasTexture(canvasEl);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
