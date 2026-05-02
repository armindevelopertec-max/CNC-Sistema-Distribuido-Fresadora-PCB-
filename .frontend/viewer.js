import * as THREE from 'three';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.155.0/examples/jsm/controls/OrbitControls.js';

const exampleGCode = `
G90
G0 X0 Y0 Z5
G1 Z-1 F300
G1 X45 Y0
G2 X75 Y30 I15 J0
G3 X45 Y60 I-15 J0
G1 X0 Y60
G1 X0 Y0
G0 Z5`;

class TrajectorySegment {
  constructor(points, metadata = {}) {
    this.points = points;
    this.metadata = metadata;
  }
}

class TrajectoryStore {
  constructor() {
    this.segments = [];
    this.resetBounds();
  }

  resetBounds() {
    this.bounds = {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity
    };
  }

  addSegment(segment) {
    this.segments.push(segment);
    for (const pt of segment.points) {
      if (pt.x < this.bounds.minX) this.bounds.minX = pt.x;
      if (pt.x > this.bounds.maxX) this.bounds.maxX = pt.x;
      if (pt.y < this.bounds.minY) this.bounds.minY = pt.y;
      if (pt.y > this.bounds.maxY) this.bounds.maxY = pt.y;
      if (pt.z < this.bounds.minZ) this.bounds.minZ = pt.z;
      if (pt.z > this.bounds.maxZ) this.bounds.maxZ = pt.z;
    }
  }
}

class GCodeParser {
  constructor() {
    this.reset();
  }

  reset() {
    this.position = { x: 0, y: 0, z: 0 };
    this.mode = 'absolute';
    this.trajectory = new TrajectoryStore();
    this.penDown = false;
    this.penDownAngle = 30;
    this.penUpAngle = 50;
  }

  parse(text) {
    this.reset();
    const lines = text
      .split(/\r?\n/)
      .map((ln) => ln.replace(/\s*\([^)]*\)/g, '').trim())
      .map((ln) => ln.replace(/;.*$/, '').trim())
      .filter(Boolean);

    for (const line of lines) {
      const tokens = line.split(/\s+/);
      const rawCommand = tokens[0].toUpperCase();
      const command =
        rawCommand.startsWith('G') && rawCommand.length > 1
          ? `G${Number(rawCommand.slice(1)).toString()}`
          : rawCommand;
      if (command === 'G90') {
        this.mode = 'absolute';
        continue;
      }
      if (command === 'G91') {
        this.mode = 'relative';
        continue;
      }
      if (rawCommand.startsWith('M300')) {
        const sToken = tokens.find((tok) => tok[0].toUpperCase() === 'S');
        const angle = sToken ? parseFloat(sToken.slice(1)) : NaN;
        if (!Number.isNaN(angle)) {
          this.penDown = angle <= this.penDownAngle;
        }
        continue;
      }

      if (command === 'G0' || command === 'G1') {
        const target = this.extractTarget(tokens.slice(1));
        this.addLinearSegment(target, command === 'G0');
      } else if (command === 'G2' || command === 'G3') {
        const target = this.extractTarget(tokens.slice(1));
        const centerOffset = this.extractCenterOffset(tokens.slice(1));
        const clockwise = command === 'G2';
        this.addArcSegment(target, centerOffset, clockwise);
      }
    }

    return {
      segments: this.trajectory.segments,
      bounds: this.trajectory.bounds,
      currentPoint: { ...this.position }
    };
  }

  extractTarget(tokens) {
    const result = { ...this.position };
    for (const token of tokens) {
      const letter = token[0].toUpperCase();
      const value = parseFloat(token.slice(1));
      if (Number.isNaN(value)) continue;
      if (letter === 'X') {
        result.x = this.mode === 'relative' ? this.position.x + value : value;
      }
      if (letter === 'Y') {
        result.y = this.mode === 'relative' ? this.position.y + value : value;
      }
      if (letter === 'Z') {
        result.z = this.mode === 'relative' ? this.position.z + value : value;
      }
    }
    return result;
  }

  extractCenterOffset(tokens) {
    const offset = { i: 0, j: 0 };
    for (const token of tokens) {
      const letter = token[0].toUpperCase();
      const value = parseFloat(token.slice(1));
      if (Number.isNaN(value)) continue;
      if (letter === 'I') offset.i = value;
      if (letter === 'J') offset.j = value;
    }
    return offset;
  }

  addLinearSegment(target, isRapid) {
    const segment = new TrajectorySegment(
      [{ ...this.position }, { ...target }],
      {
        isRapid,
        isCut: target.z < 0,
        penDown: this.penDown
      }
    );
    this.trajectory.addSegment(segment);
    this.position = target;
  }

  addArcSegment(target, centerOffset, clockwise) {
    const center = {
      x: this.position.x + centerOffset.i,
      y: this.position.y + centerOffset.j
    };
    const startAngle = Math.atan2(this.position.y - center.y, this.position.x - center.x);
    const endAngle = Math.atan2(target.y - center.y, target.x - center.x);
    let sweep = endAngle - startAngle;
    if (clockwise && sweep > 0) sweep -= 2 * Math.PI;
    if (!clockwise && sweep < 0) sweep += 2 * Math.PI;
    const segments = Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI / 60)));
    const points = [];
    const radius = Math.hypot(this.position.x - center.x, this.position.y - center.y);
    for (let i = 0; i <= segments; i += 1) {
      const angle = startAngle + (sweep * i) / segments;
      points.push({
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
        z: this.position.z
      });
    }
    if (points.length) {
      points[points.length - 1] = { ...target };
    }
    const segment = new TrajectorySegment(points, {
      isRapid: false,
      isCut: target.z < 0,
      penDown: this.penDown
    });
    this.trajectory.addSegment(segment);
    this.position = target;
  }
}

class TrajectorySimulator {
  constructor(steps = []) {
    this.steps = steps;
    this.reset();
  }

  setSteps(steps) {
    this.steps = steps;
    this.reset();
  }

  reset() {
    this.currentStepIndex = 0;
    this.progress = 0;
    this.isPlaying = false;
    this.speedFactor = 1;
  }

  update(deltaSec) {
    if (!this.isPlaying || this.steps.length === 0) return false;
    let remaining = deltaSec * this.speedFactor;
    while (remaining > 0 && this.currentStepIndex < this.steps.length) {
      const step = this.steps[this.currentStepIndex];
      const left = step.length - this.progress;
      if (remaining < left) {
        this.progress += remaining;
        remaining = 0;
      } else {
        remaining -= left;
        this.currentStepIndex += 1;
        this.progress = 0;
      }
    }
    if (this.currentStepIndex >= this.steps.length) {
      this.currentStepIndex = this.steps.length - 1;
      this.progress = this.steps[this.currentStepIndex]?.length || 0;
      this.isPlaying = false;
    }
    return true;
  }

  step() {
    if (this.steps.length === 0) return;
    this.currentStepIndex = Math.min(this.currentStepIndex + 1, this.steps.length - 1);
    this.progress = 0;
    this.isPlaying = false;
  }

  setSpeed(factor) {
    this.speedFactor = Math.max(0.25, Math.min(4, factor));
  }

  getPosition() {
    if (this.steps.length === 0) return null;
    const step = this.steps[this.currentStepIndex];
    if (!step) return null;
    const t = step.length ? this.progress / step.length : 0;
    return {
      x: THREE.MathUtils.lerp(step.start.x, step.end.x, t),
      y: THREE.MathUtils.lerp(step.start.y, step.end.y, t),
      z: THREE.MathUtils.lerp(step.start.z, step.end.z, t),
      progress: t,
      total: this.steps.length,
      index: this.currentStepIndex
    };
  }

  getCurrentMetadata() {
    return this.steps[this.currentStepIndex]?.metadata ?? null;
  }
}

const axisColors = {
  servoDown: new THREE.Color(0xff9f3d),
  servoUp: new THREE.Color(0x4aa6ff),
  servoIdle: new THREE.Color(0xfffe7b)
};

const createLineGeometry = (segments) => {
  const positions = [];
  const colors = [];
  for (const segment of segments) {
    const color = segment.metadata ? colorForSegment(segment.metadata) : axisColors.servoIdle;
    for (let i = 1; i < segment.points.length; i += 1) {
      const start = segment.points[i - 1];
      const end = segment.points[i];
      positions.push(start.x, start.y, start.z);
      positions.push(end.x, end.y, end.z);
      colors.push(color.r, color.g, color.b);
      colors.push(color.r, color.g, color.b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2 }));
};

const colorForSegment = (metadata) => {
  if (metadata.penDown) return axisColors.servoDown;
  if (metadata.isRapid) return axisColors.servoUp;
  if (metadata.isCut) return new THREE.Color(0xff5d5d);
  return new THREE.Color(0xb0b0b0);
};

const buildPlaybackSteps = (segments) => {
  const steps = [];
  for (const segment of segments) {
    for (let i = 1; i < segment.points.length; i += 1) {
      const start = segment.points[i - 1];
      const end = segment.points[i];
      const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
      steps.push({ start, end, length, metadata: segment.metadata });
    }
  }
  return steps;
};

const fitCamera = (camera, controls, bounds) => {
  if (!bounds) return;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const size = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ, 1);
  const offset = size * 1.4;
  camera.position.set(centerX + offset, centerY - offset, centerZ + offset * 0.8);
  controls.target.set(centerX, centerY, centerZ);
  controls.update();
};

const adjustToolHeadScale = (toolHead, bounds) => {
  if (!bounds) return;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ, 1);
  const scale = Math.max(0.05, span * 0.02);
  toolHead.scale.setScalar(scale);
};

const formatBoundsInfo = (bounds, currentPoint) => {
  if (!bounds) return 'Sin datos todavía.';
  const sizeX = bounds.maxX - bounds.minX;
  const sizeY = bounds.maxY - bounds.minY;
  const sizeZ = bounds.maxZ - bounds.minZ;
  return `Bounding box XY: [${bounds.minX.toFixed(2)}, ${bounds.minY.toFixed(2)}] - [${bounds.maxX.toFixed(2)}, ${bounds.maxY.toFixed(2)}] · Z: ${bounds.minZ.toFixed(2)} / ${bounds.maxZ.toFixed(2)} · Dimensiones ${sizeX.toFixed(2)} × ${sizeY.toFixed(2)} × ${sizeZ.toFixed(2)} · Cabezal (${currentPoint.x.toFixed(2)}, ${currentPoint.y.toFixed(2)}, ${currentPoint.z.toFixed(2)})`;
};

const createStatusMessage = (simulator) => {
  const pos = simulator.getPosition();
  const metadata = simulator.getCurrentMetadata();
  const servoLabel = metadata ? (metadata.penDown ? 'abajo' : 'arriba') : 'esperando';
  if (!pos) {
    return `Simulación pausada · servo ${servoLabel}`;
  }
  const percent = Math.round(pos.progress * 100);
  const status = simulator.isPlaying ? '▶ Reproduciendo' : '‖ Pausado';
  return `${status} · servo ${servoLabel} · segmento ${pos.index + 1}/${pos.total} · ${percent}% · ${simulator.speedFactor.toFixed(2)}x`;
};

export function initViewer({ apiBase = '/api' } = {}) {
  const viewerRoot = document.getElementById('gcode-viewer');
  if (!viewerRoot) {
    console.warn('El visor de G-code no está disponible en esta página.');
    return null;
  }

  const infoEl = document.getElementById('info');
  const simStatusEl = document.getElementById('simStatus');
  const playPauseButton = document.getElementById('playPauseButton');
  const stepButton = document.getElementById('stepButton');
  const resetButton = document.getElementById('resetButton');
  const loadButton = document.getElementById('loadButton');
  const speedRange = document.getElementById('speedRange');
  const speedValue = document.getElementById('speedValue');
  const gcodeInput = document.getElementById('gcodeInput');
  const fileInput = document.getElementById('fileInput');
  const gcodeFileSelect = document.getElementById('gcodeFileSelect');
  const refreshFilesButton = document.getElementById('refreshFilesButton');
  const viewerStatus = document.getElementById('viewer-status');
  const uploadManualGcode = async (file) => {
    if (!file) return;
    try {
      const form = new FormData();
      form.append('gcode', file);
      const response = await fetch(`${apiBase}/gcode/import`, {
        method: 'POST',
        body: form
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.error || 'No se pudo subir el G-code.');
      }
      const payload = await response.json();
      if (viewerStatus) viewerStatus.textContent = payload.message || 'G-code cargado.';
      window.dispatchEvent(new CustomEvent('gcode-uploaded', { detail: payload.upload }));
    } catch (error) {
      console.error(error);
      if (viewerStatus) viewerStatus.textContent = error.message;
    }
  };
  const canvas = document.getElementById('renderCanvas');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.screenSpacePanning = true;
  camera.position.set(60, -80, 80);
  controls.target.set(0, 0, 0);
  controls.update();

  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  const directional = new THREE.DirectionalLight(0xffffff, 0.9);
  directional.position.set(50, 80, 100);
  scene.add(ambient, directional);

  const gridHelper = new THREE.GridHelper(200, 40, 0x202020, 0x101010);
  gridHelper.position.z = 0;
  gridHelper.rotateX(Math.PI / 2);
  scene.add(gridHelper);

  const headMaterial = new THREE.MeshStandardMaterial({ color: axisColors.servoIdle.clone() });
  const headGeometry = new THREE.SphereGeometry(1, 12, 12);
  const toolHead = new THREE.Mesh(headGeometry, headMaterial);
  toolHead.visible = false;
  scene.add(toolHead);

  const parser = new GCodeParser();
  let lineObject = null;
  let boxHelper = null;
  let playbackSteps = [];
  const simulator = new TrajectorySimulator();
  let lastFrameTime = performance.now();
  let runtimeModeActive = false;
  let runtimeData = null;
  let runtimeMetadata = null;
  let currentGcodeName = '';

  gcodeInput.value = exampleGCode;

  const resizeRenderer = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const updateInfo = (bounds, currentPoint) => {
    if (!infoEl) return;
    if (runtimeModeActive && runtimeData) {
      const source = runtimeData.source ?? runtimeData.command ?? '—';
      infoEl.textContent = `Posición en vivo · X:${(runtimeData.x ?? 0).toFixed(2)} Y:${(runtimeData.y ?? 0).toFixed(2)} Z:${(runtimeData.z ?? 0).toFixed(2)} · ${source}`;
      return;
    }
    infoEl.textContent = formatBoundsInfo(bounds, currentPoint);
  };

  const updateSimStatus = () => {
    if (!simStatusEl) return;
    if (runtimeModeActive && runtimeMetadata) {
      const servoLabel = runtimeMetadata.penDown ? 'abajo' : 'arriba';
      simStatusEl.textContent = `Tiempo real · servo ${servoLabel}`;
      return;
    }
    simStatusEl.textContent = createStatusMessage(simulator);
  };

  const updateViewerStatus = (text) => {
    if (viewerStatus) viewerStatus.textContent = text;
  };

  const updateServoVisual = (metadata) => {
    if (!metadata) {
      toolHead.material.color.copy(axisColors.servoIdle);
      return;
    }
    const targetColor = metadata.penDown ? axisColors.servoDown : axisColors.servoUp;
    toolHead.material.color.copy(targetColor);
  };

  const setControlState = (disabled) => {
    if (playPauseButton) playPauseButton.disabled = disabled;
    if (stepButton) stepButton.disabled = disabled;
    if (resetButton) resetButton.disabled = disabled;
    if (speedRange) speedRange.disabled = disabled;
  };

  const setRealtimeActive = (enabled) => {
    runtimeModeActive = enabled;
    setControlState(enabled);
    if (runtimeModeActive) {
      simulator.isPlaying = false;
    }
    updateSimStatus();
  };

  const applyRuntimeUpdate = (data) => {
    runtimeData = data;
    runtimeMetadata = data
      ? {
          penDown: data.servo === 'down',
          isRapid: `${data.command ?? ''}`.startsWith('G0'),
          isCut: (data.z ?? 0) < 0
        }
      : null;
    if (!runtimeModeActive || !runtimeData) return;
    toolHead.visible = true;
    toolHead.position.set(runtimeData.x ?? 0, runtimeData.y ?? 0, runtimeData.z ?? 0);
    updateServoVisual(runtimeMetadata);
    updateInfo(null, runtimeData);
    updateSimStatus();
  };

  const loadGCode = () => {
    const raw = gcodeInput.value;
    const parsed = parser.parse(raw);
    if (lineObject) {
      scene.remove(lineObject);
      lineObject.geometry.dispose();
    }
    if (boxHelper) {
      scene.remove(boxHelper);
    }
    playbackSteps = [];
    simulator.setSteps(playbackSteps);
    toolHead.visible = false;
    playPauseButton.disabled = true;
    stepButton.disabled = true;
    resetButton.disabled = true;
    speedRange.disabled = true;
    simStatusEl.textContent = 'Sin datos';
    speedValue.textContent = `${parseFloat(speedRange.value || 1).toFixed(2)}x`;
    if (parsed.segments.length === 0) {
      updateInfo(null);
      return;
    }
    lineObject = createLineGeometry(parsed.segments);
    scene.add(lineObject);

    const box3 = new THREE.Box3(
      new THREE.Vector3(parsed.bounds.minX, parsed.bounds.minY, parsed.bounds.minZ),
      new THREE.Vector3(parsed.bounds.maxX, parsed.bounds.maxY, parsed.bounds.maxZ)
    );
    boxHelper = new THREE.Box3Helper(box3, 0xffffff);
    scene.add(boxHelper);

    fitCamera(camera, controls, parsed.bounds);
    updateInfo(parsed.bounds, parsed.currentPoint);
    adjustToolHeadScale(toolHead, parsed.bounds);

    playbackSteps = buildPlaybackSteps(parsed.segments);
    simulator.setSteps(playbackSteps);
    toolHead.visible = playbackSteps.length > 0;
    const sliderSpeed = parseFloat(speedRange.value) || 1;
    simulator.setSpeed(sliderSpeed);
    speedValue.textContent = `${sliderSpeed.toFixed(2)}x`;
    if (toolHead.visible) {
      const firstPoint = playbackSteps[0]?.start ?? parsed.currentPoint;
      toolHead.position.set(firstPoint.x, firstPoint.y, firstPoint.z);
    }
    updateSimStatus();
    playPauseButton.disabled = playbackSteps.length === 0;
    stepButton.disabled = playbackSteps.length === 0;
    resetButton.disabled = playbackSteps.length === 0;
    speedRange.disabled = playbackSteps.length === 0;
    playPauseButton.textContent = 'Play';
    if (playbackSteps.length === 0) {
      updateViewerStatus('El G-code no generó trayectorias reconocidas.');
    }
  };

  const broadcastViewerFileChange = (name) => {
    if (!name) return;
    window.dispatchEvent(new CustomEvent('viewer-file-change', { detail: { name } }));
  };

  const loadServerFile = async (name) => {
    if (!name) return;
    try {
      updateViewerStatus(`Cargando ${name}...`);
      const response = await fetch(`${apiBase}/viewer/gcode?name=${encodeURIComponent(name)}`);
      if (!response.ok) {
        throw new Error('No se pudo recuperar el archivo desde el servidor.');
      }
      const text = await response.text();
      gcodeInput.value = text;
      loadGCode();
      currentGcodeName = name;
      broadcastViewerFileChange(name);
    } catch (error) {
      console.error(error);
      updateViewerStatus(error.message);
    }
  };

  const populateFileSelect = (files) => {
    if (!gcodeFileSelect) return;
    if (files.length === 0) {
      gcodeFileSelect.innerHTML = '<option value="">— No hay G-code generados aún —</option>';
      gcodeFileSelect.disabled = true;
      return;
    }
    gcodeFileSelect.innerHTML = files
      .map((file) => `<option value="${file.name}">${file.name} (${file.size} bytes)</option>`)
      .join('');
    gcodeFileSelect.value = files[0].name;
    gcodeFileSelect.disabled = false;
  };

  const refreshFiles = async ({ skipLoad = false } = {}) => {
    if (gcodeFileSelect) {
      gcodeFileSelect.disabled = true;
      gcodeFileSelect.innerHTML = '<option value="">— Cargando archivos —</option>';
    }
    updateViewerStatus('Actualizando lista de G-code...');
    try {
      const response = await fetch(`${apiBase}/viewer/files`);
      if (!response.ok) {
        throw new Error('No se pudo listar los G-code disponibles.');
      }
      const files = await response.json();
      populateFileSelect(files);
      if (files.length > 0) {
        updateViewerStatus(`NCViewer listo con ${files.length} archivo${files.length > 1 ? 's' : ''}.`);
        if (!skipLoad) {
          loadServerFile(files[0].name);
        }
      } else {
        updateViewerStatus('Aún no hay G-code listos para el visor.');
      }
      return files;
    } catch (error) {
      console.error(error);
      updateViewerStatus('Error al cargar los G-code.');
      return [];
    }
  };

  loadButton?.addEventListener('click', loadGCode);
  fileInput?.addEventListener('change', async (evt) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    gcodeInput.value = text;
    loadGCode();
    uploadManualGcode(file);
  });
  gcodeFileSelect?.addEventListener('change', () => {
    const selected = gcodeFileSelect.value;
    if (selected) {
      loadServerFile(selected);
    }
  });
  refreshFilesButton?.addEventListener('click', () => refreshFiles({ skipLoad: false }));

  playPauseButton?.addEventListener('click', () => {
    if (simulator.isPlaying) {
      simulator.isPlaying = false;
      playPauseButton.textContent = 'Play';
    } else {
      simulator.isPlaying = true;
      playPauseButton.textContent = 'Pause';
    }
    updateSimStatus();
  });

  stepButton?.addEventListener('click', () => {
    simulator.step();
    updateSimStatus();
  });

  resetButton?.addEventListener('click', () => {
    simulator.reset();
    simulator.setSteps(playbackSteps);
    toolHead.visible = playbackSteps.length > 0;
    const pos = simulator.getPosition();
    if (pos) {
      toolHead.position.set(pos.x, pos.y, pos.z);
    }
    playPauseButton.textContent = 'Play';
    const sliderSpeed = parseFloat(speedRange.value) || 1;
    simulator.setSpeed(sliderSpeed);
    speedValue.textContent = `${sliderSpeed.toFixed(2)}x`;
    updateSimStatus();
  });

  speedRange?.addEventListener('input', (evt) => {
    const value = parseFloat(evt.target.value);
    simulator.setSpeed(value);
    speedValue.textContent = `${value.toFixed(2)}x`;
    updateSimStatus();
  });

  const animate = (time) => {
    const delta = (time - lastFrameTime) / 1000;
    lastFrameTime = time;
    resizeRenderer();
    if (runtimeModeActive) {
      if (runtimeData) {
        toolHead.position.set(runtimeData.x ?? 0, runtimeData.y ?? 0, runtimeData.z ?? 0);
        updateServoVisual(runtimeMetadata);
      }
      updateSimStatus();
    } else {
      if (simulator.update(delta)) {
        updateSimStatus();
      }
      const currentPos = simulator.getPosition();
      if (currentPos) {
        toolHead.position.set(currentPos.x, currentPos.y, currentPos.z);
      }
      updateServoVisual(simulator.getCurrentMetadata());
    }
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  };

  window.addEventListener('resize', resizeRenderer);
  requestAnimationFrame(animate);
  refreshFiles();

  const currentGcode = () => currentGcodeName;
  return {
    refreshFiles,
    setRealtimeActive,
    applyRuntimeUpdate,
    currentGcode
  };
}
