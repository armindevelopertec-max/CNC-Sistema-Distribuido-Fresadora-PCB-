import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
      minX: Infinity, maxX: -Infinity,
      minY: Infinity, maxY: -Infinity,
      minZ: Infinity, maxZ: -Infinity
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
    this.lastCommand = 'G0';
  }
  parse(text) {
    this.reset();
    if (!text) return { segments: [], bounds: this.trajectory.bounds };
    const lines = text.split(/\r?\n/).map(ln => ln.replace(/\(.*?\)/g, '').trim()).filter(Boolean);
    for (const line of lines) {
      const tokens = line.split(/\s+/);
      let cmd = tokens[0].toUpperCase();
      
      if (cmd === 'G90') { this.mode = 'absolute'; continue; }
      if (cmd === 'G91') { this.mode = 'relative'; continue; }
      
      const isMove = ['G0', 'G00', 'G1', 'G01'].includes(cmd);
      const isServo = cmd === 'M300';
      const startsWithCoord = /^[XYZ]/.test(cmd);

      if (isMove || startsWithCoord) {
        if (isMove) this.lastCommand = cmd;
        const target = this.extractTarget(startsWithCoord ? tokens : tokens.slice(1));
        this.addLinearSegment(target, this.lastCommand.startsWith('G0'));
      } else if (isServo) {
        const sToken = tokens.find(t => t.toUpperCase().startsWith('S'));
        if (sToken) {
          const sVal = parseFloat(sToken.slice(1));
          // S30 = Down (Cut), S50 = Up (Travel)
          this.position.z = sVal <= 35 ? -1 : 5;
        }
      }
    }
    return { segments: this.trajectory.segments, bounds: this.trajectory.bounds };
  }
  extractTarget(tokens) {
    const result = { ...this.position };
    for (const t of tokens) {
      const axis = t[0].toUpperCase();
      const val = parseFloat(t.slice(1));
      if (isNaN(val)) continue;
      if (axis === 'X') result.x = this.mode === 'relative' ? this.position.x + val : val;
      if (axis === 'Y') result.y = this.mode === 'relative' ? this.position.y + val : val;
      if (axis === 'Z') result.z = this.mode === 'relative' ? this.position.z + val : val;
    }
    return result;
  }
  addLinearSegment(target, isRapid) {
    this.trajectory.addSegment(new TrajectorySegment([{...this.position}, {...target}], { isRapid, isCut: target.z < 0 }));
    this.position = target;
  }
}

const LAYER_COLORS = {
  traces: 0xffd700, // Gold
  outline: 0xff4500, // Red-Orange
  pads: 0x00ffff,    // Cyan
  default: 0xffffff
};

class GCodeViewer {
    constructor(canvasId, color = LAYER_COLORS.default) {
        console.log(`Initializing viewer for ${canvasId}`);
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            console.error(`Canvas ${canvasId} not found`);
            return;
        }

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x050505);
        
        // Initial aspect, will be updated in resize
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
        this.camera.position.set(0, 0, 100);
        
        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.enableDamping = true;

        this.group = new THREE.Group();
        this.scene.add(this.group);
        
        // Tool representation
        this.tool = new THREE.Mesh(
            new THREE.SphereGeometry(1, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0xffffff })
        );
        this.tool.visible = false;
        this.scene.add(this.tool);
        
        this.scene.add(new THREE.GridHelper(200, 20, 0x333333, 0x222222).rotateX(Math.PI/2));
        
        this.parser = new GCodeParser();
        this.color = color;
        this.segments = [];
        this.isPlaying = false;
        this.progress = 0;

        this.animate = this.animate.bind(this);
        this.animate();

        // Use ResizeObserver for more robust sizing
        if (this.canvas.parentElement) {
            const resizeObserver = new ResizeObserver(() => this.resize());
            resizeObserver.observe(this.canvas.parentElement);
        }

        window.addEventListener('resize', () => this.resize());
        // Use a small delay for initial resize to ensure DOM is rendered
        setTimeout(() => this.resize(), 100);
    }

    resize() {
        if (!this.canvas || !this.canvas.parentElement) return;
        
        const parent = this.canvas.parentElement;
        const width = parent.clientWidth;
        const height = parent.clientHeight;
        
        if (width > 0 && height > 0) {
            if (this.canvas.width !== width || this.canvas.height !== height) {
                this.renderer.setSize(width, height, false);
                this.camera.aspect = width / height;
                this.camera.updateProjectionMatrix();
            }
        }
    }

    animate() {
        requestAnimationFrame(this.animate);
        if (this.isPlaying && this.segments.length > 0) {
            this.progress += 0.5; // Speed of simulation
            if (this.progress > 100) this.progress = 100;
            this.drawProgress(this.progress);
            
            // Dispatch event for UI progress bar
            this.canvas.dispatchEvent(new CustomEvent('viewer-progress', { detail: { progress: this.progress } }));
            
            if (this.progress >= 100) this.isPlaying = false;
        }
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    clear() {
        this.group.clear();
        this.segments = [];
        this.progress = 0;
        this.isPlaying = false;
        this.tool.visible = false;
    }

    async loadGCode(text) {
        console.log(`Loading G-code text (${text ? text.length : 0} bytes)`);
        this.clear();
        const parsed = this.parser.parse(text);
        if (parsed.segments.length === 0) {
            console.warn("No segments parsed from G-code");
            return;
        }

        this.segments = parsed.segments;
        console.log(`Loaded ${this.segments.length} segments`);
        this.drawProgress(100); // Show everything initially
        this.autoCenter();
    }

    drawProgress(percent) {
        this.group.clear();
        if (this.segments.length === 0) return;

        const count = Math.floor((this.segments.length * percent) / 100);
        const positions = [];
        
        for (let i = 0; i < count; i++) {
            const seg = this.segments[i];
            positions.push(seg.points[0].x, seg.points[0].y, seg.points[0].z);
            positions.push(seg.points[1].x, seg.points[1].y, seg.points[1].z);
            
            // Update tool position
            if (i === count - 1) {
                this.tool.position.set(seg.points[1].x, seg.points[1].y, seg.points[1].z);
                this.tool.visible = true;
            }
        }

        if (positions.length > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            const mat = new THREE.LineBasicMaterial({ color: this.color });
            this.group.add(new THREE.LineSegments(geo, mat));
        } else {
            this.tool.visible = false;
        }
    }

    play() {
        this.progress = 0;
        this.isPlaying = true;
    }

    stop() {
        this.isPlaying = false;
    }

    setProgress(percent) {
        this.progress = percent;
        this.drawProgress(percent);
    }

    autoCenter() {
        const box = new THREE.Box3().setFromObject(this.group);
        if (box.isEmpty()) return;

        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);

        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = this.camera.fov * (Math.PI / 180);
        let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
        cameraZ *= 1.5;

        this.camera.position.set(center.x, center.y, cameraZ || 100);
        this.controls.target.copy(center);
        this.controls.update();
    }
}

export function initViewer({ apiBase = '/api', clientId = null } = {}) {
  const scopeUrl = (url) => {
    if (!clientId) return url;
    const joiner = url.includes('?') ? '&' : '?';
    return `${url}${joiner}client_id=${encodeURIComponent(clientId)}`;
  };

  const viewers = {
      traces: new GCodeViewer('canvas-traces', LAYER_COLORS.traces),
      outline: new GCodeViewer('canvas-outline', LAYER_COLORS.outline),
      pads: new GCodeViewer('canvas-pads', LAYER_COLORS.pads)
  };

  const loadJobLayers = async (job) => {
    console.log("Loading job layers:", job);
    // Clear all viewers first to avoid ghost layers from previous jobs
    Object.values(viewers).forEach(v => v.clear());

    if (!job.layers || !Array.isArray(job.layers)) {
      console.warn("No layers found in job data:", job);
      return;
    }

    for (const layer of job.layers) {
      const viewer = viewers[layer.type];
      if (!viewer) continue;

      try {
        console.log(`Fetching G-code for ${layer.type}: ${layer.name}`);
        const jobId = job.id ?? job.jobId ?? null;
        const query = new URLSearchParams({
          layer: layer.type,
        });
        if (jobId !== null && jobId !== undefined) {
          query.set('job_id', jobId);
        }
        if (layer.name) query.set('name', layer.name);
        const resp = await fetch(scopeUrl(`${apiBase}/viewer/gcode?${query.toString()}`));
        if (!resp.ok) throw new Error(`HTTP error! status: ${resp.status}`);
        const text = await resp.text();
        await viewer.loadGCode(text);
      } catch (e) { 
          console.error("Error loading layer", layer.type, e); 
      }
    }
  };

  const refreshFiles = async () => {
    try {
        const resp = await fetch(scopeUrl(`${apiBase}/viewer/files`));
        const jobs = await resp.json();
        // Since we don't have a global select anymore in the template, 
        // we might just load the most recent one if requested or wait for job upload.
        return jobs;
    } catch (e) {
        console.error("Error fetching files", e);
    }
  };

  const applyRuntimeUpdate = (data) => {
    // Mover la herramienta en todos los visores activos
    Object.values(viewers).forEach(viewer => {
        if (data.x !== undefined && data.y !== undefined && data.z !== undefined) {
            viewer.tool.position.set(data.x, data.y, data.z);
            viewer.tool.visible = true;
            
            // Opcional: centrar cámara suavemente si está muy lejos
            // viewer.controls.target.lerp(new THREE.Vector3(data.x, data.y, data.z), 0.1);
        }
    });
  };

  const setRealtimeActive = (active) => {
    console.log("Realtime mode:", active);
    Object.values(viewers).forEach(v => {
        v.isPlaying = false; // Detener simulaciones si entra en modo real
    });
  };

  return { refreshFiles, loadJobLayers, viewers, applyRuntimeUpdate, setRealtimeActive };
}
