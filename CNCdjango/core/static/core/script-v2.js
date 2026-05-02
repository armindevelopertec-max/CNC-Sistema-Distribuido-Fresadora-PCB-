const API_BASE = window.API_BASE || '/api';
const pageId = document.body?.dataset.page;
const isPanel = pageId === 'panel';

let viewerController = null;
let activeViewerGcode = null;
let currentJobId = null;
let currentStep = 1;
let realtimeMode = false;
let viewerInitPromise = null;

const urlParams = new URLSearchParams(window.location.search);
const currentMode = urlParams.get('mode') || 'saas';
document.body.dataset.mode = currentMode;

const CLIENT_ID_KEY = 'cnc.workstation.client-id';
const CLIENT_LABEL_KEY = 'cnc.workstation.client-label';

const generateClientId = () => {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `client-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

const clientScope = currentMode === 'saas' ? null : (() => {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = generateClientId();
      localStorage.setItem(CLIENT_ID_KEY, id);
    }

    let label = localStorage.getItem(CLIENT_LABEL_KEY);
    if (!label) {
      label = `Estación ${id.slice(0, 8)}`;
      localStorage.setItem(CLIENT_LABEL_KEY, label);
    }

    return { id, label };
  } catch (err) {
    const id = generateClientId();
    return { id, label: `Estación ${id.slice(0, 8)}` };
  }
})();

const withClientScope = (url) => {
  if (!clientScope?.id) return url;
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}client_id=${encodeURIComponent(clientScope.id)}`;
};

const withClientFormData = (formData) => {
  if (!clientScope?.id) return formData;
  formData.append('client_id', clientScope.id);
  formData.append('client_label', clientScope.label);
  return formData;
};

const withClientJson = (payload = {}) => {
  if (!clientScope?.id) return payload;
  return {
    ...payload,
    client_id: clientScope.id,
    client_label: clientScope.label,
  };
};

const describeClient = (item) => {
  if (!item) return '';
  if (item.clientLabel) return item.clientLabel;
  if (item.clientId) return `Estación ${item.clientId.slice(0, 8)}`;
  return '';
};

const ensureViewerController = async () => {
  if (!isPanel) return null;
  if (viewerController) return viewerController;

  if (!viewerInitPromise) {
    viewerInitPromise = import('./viewer-v2.js')
      .then((mod) => {
        viewerController = mod.initViewer({ apiBase: API_BASE, clientId: clientScope?.id || null });
        initViewerControls();
        return viewerController;
      })
      .catch((err) => {
        console.error('No se pudo cargar el visor 3D.', err);
        const statusBadge = document.getElementById('viewer-status');
        if (statusBadge) {
          statusBadge.textContent = 'Visor no disponible';
          statusBadge.className = 'badge status';
        }
        return null;
      });
  }

  return viewerInitPromise;
};

// DOM Elements
const uploadForm = document.getElementById('upload-form');
const fileInput = document.getElementById('file-input');
const dropZone = document.getElementById('drop-zone');
const fileListPreview = document.getElementById('file-list-preview');
const submitProjectBtn = document.getElementById('submit-project-btn');
const configForm = document.getElementById('config-form');
const uploadFeedback = document.getElementById('upload-feedback');
const uploadMetadata = document.getElementById('upload-metadata');
const uploadsList = document.getElementById('uploads-list');
const confirmButton = document.getElementById('confirm-send-btn');
const confirmFeedback = document.getElementById('confirm-feedback');
const navSerialStatus = document.getElementById('nav-serial-status');
const realtimeToggle = document.getElementById('realtime-toggle');
const resetCncButton = document.getElementById('reset-cnc-btn');
const executionLayersList = document.getElementById('execution-layers-list');
const activeLayerInfo = document.getElementById('active-layer-info');
const continueToSimBtn = document.getElementById('continue-to-sim-btn');
const jobVerificationKey = document.getElementById('job-verification-key');
const jobMonitorStatus = document.getElementById('job-monitor-status');
const jobCompletedAt = document.getElementById('job-completed-at');
const jobMonitorNote = document.getElementById('job-monitor-note');

let currentJobLayers = [];

const applyModeCopy = () => {
    const isPrintShop = currentMode === 'printshop';
    const stepItems = document.querySelectorAll('.workflow-nav .step-item');
    
    let visibleIndex = 1;
    stepItems.forEach(item => {
        const numSpan = item.querySelector('.step-number');
        const labelSpan = item.querySelector('.step-label');

        // Visibilidad base
        if (item.id === 'nav-step-nest' && isPrintShop) {
            item.style.display = 'none';
        } else {
            item.style.display = 'flex';
        }

        // Si es visible, numeramos y nombramos
        if (item.style.display !== 'none') {
            if (numSpan) numSpan.textContent = visibleIndex++;
            
            if (isPrintShop) {
                if (item.id === 'nav-step-cam' && labelSpan) labelSpan.textContent = 'Precio';
                if (item.id === 'nav-step-sim' && labelSpan) labelSpan.textContent = 'Simulación';
                if (item.id === 'nav-step-exec' && labelSpan) labelSpan.textContent = 'Estado';
            } else {
                if (item.id === 'nav-step-cam' && labelSpan) labelSpan.textContent = 'CAM / Prep';
                if (item.id === 'nav-step-sim' && labelSpan) labelSpan.textContent = 'Simulación';
                if (item.id === 'nav-step-exec' && labelSpan) labelSpan.textContent = 'Ejecución';
            }
        }
    });

    if (isPrintShop) {
        // Títulos de tarjetas
        const step3Title = document.querySelector('#step-3 .config-card .card-header h2');
        if (step3Title) step3Title.textContent = 'Parámetros de Fabricación';
        
        const configFormEl = document.getElementById('config-form');
        if (configFormEl) configFormEl.style.display = ''; // MOSTRAR form en PrintShop

        const step5Title = document.querySelector('#step-5 .card-header h2');
        if (step5Title) step5Title.textContent = 'Seguimiento del trabajo';

        if (continueToSimBtn) continueToSimBtn.textContent = 'Seguir a simulación';
        if (confirmButton) confirmButton.textContent = 'CONFIRMAR Y ENVIAR AL OPERADOR';
        if (confirmFeedback) confirmFeedback.textContent = 'Revisa el precio, la simulación y la llave antes de enviar.';
        if (jobMonitorNote) jobMonitorNote.textContent = 'El diseño está en borrador hasta que lo confirmes.';
    } else {
        const configFormEl = document.getElementById('config-form');
        if (configFormEl) configFormEl.style.display = '';
    }
};

const getConfirmButtonLabel = () => currentMode === 'printshop' ? 'CONFIRMAR Y ENVIAR AL OPERADOR' : 'APROBAR Y FABRICAR';

// Multi-file handling
let selectedFiles = new Map();

const collectSelectedFiles = () => {
    const files = [];
    const seen = new Set();
    const addFile = (file) => {
        if (!file) return;
        const key = `${file.name}::${file.size}::${file.lastModified || 0}`;
        if (seen.has(key)) return;
        seen.add(key);
        files.push(file);
    };

    Array.from(selectedFiles.values()).forEach(addFile);
    Array.from(fileInput?.files || []).forEach(addFile);

    return files;
};

const inferLayerType = (filename) => {
    const name = (filename || '').toLowerCase();

    if (
        name.endsWith('.gb1') ||
        name.endsWith('.gtl') ||
        name.includes('gb1') ||
        /(f[_-]?cu|b[_-]?cu|front|back|top|bottom|copper|trace|traces|signal|gtl|gbl|cmp|sol|bot|layer1|layer2)/.test(name)
    ) {
        return 'traces';
    }

    if (
        name.endsWith('.gb0') ||
        name.endsWith('.gko') ||
        name.includes('gb0') ||
        /(edge[_-]?cuts|outline|contour|cut|edge|gko|gml|gm1|oln)/.test(name)
    ) {
        return 'outline';
    }

    if (
        name.endsWith('.gb2') ||
        name.endsWith('.drl') ||
        name.includes('gb2') ||
        /(pads?|drill|via|holes?|pth|drl|drd)/.test(name)
    ) {
        return 'pads';
    }

    return null;
};

const clearSelectedFiles = () => {
    selectedFiles.clear();
    if (fileInput) fileInput.value = '';
    updateFilePreview();
};

const updateFilePreview = () => {
    if (!fileListPreview) return;
    const files = collectSelectedFiles();
    const hasFiles = files.length > 0;
    const hasTraces = files.some(f => inferLayerType(f.name) === 'traces');
    fileListPreview.innerHTML = files.map(file => {
        const ext = file.name.split('.').pop().toLowerCase();
        const layer = inferLayerType(file.name);
        let role = 'Gerber';
        if (layer === 'traces') role = 'Pistas';
        else if (layer === 'outline') role = 'Contorno';
        else if (layer === 'pads') role = 'Pads';

        return `
            <div class="file-item-pill">
                <div class="file-info">
                    <span class="ext-badge">${ext}</span>
                    <span class="name">${file.name}</span>
                    <small style="color: #94a3b8; margin-left: 0.5rem;">(${role})</small>
                </div>
                <div class="success-tick" title="Archivo aceptado">✓</div>
            </div>
        `;
    }).join('');

    if (submitProjectBtn) submitProjectBtn.disabled = !hasFiles;
    if (uploadFeedback) {
        if (!hasFiles) {
            uploadFeedback.textContent = 'Agrega archivos Gerber para continuar.';
            uploadFeedback.style.color = '#94a3b8';
        } else if (hasTraces) {
            uploadFeedback.textContent = 'Archivos listos. El servidor identificará las capas al enviar.';
            uploadFeedback.style.color = '#22c55e';
        } else {
            uploadFeedback.textContent = 'No identifiqué una pista por nombre, pero los archivos igual se pueden enviar.';
            uploadFeedback.style.color = '#f59e0b';
        }
    }
};

if (fileInput) {
    fileInput.onchange = (e) => {
        for (const file of e.target.files) {
            selectedFiles.set(file.name, file);
        }
        updateFilePreview();
    };
}

if (dropZone) {
    dropZone.ondragover = (e) => { 
        e.preventDefault(); 
        e.stopPropagation();
        dropZone.classList.add('dragover'); 
    };
    dropZone.ondragleave = (e) => { 
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragover'); 
    };
    dropZone.ondrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragover');
        console.log("Files dropped:", e.dataTransfer.files);
        for (const file of e.dataTransfer.files) {
            console.log(`Adding dropped file: ${file.name}, size: ${file.size}`);
            selectedFiles.set(file.name, file);
        }
        updateFilePreview();
    };
}

// Per-layer configuration
let layerConfigs = {
  traces: { depth: '-0.06', feedRate: '120', toolDiameter: '0.1', millSpeed: '10000', isolationWidth: '0.25', isolationSteps: '2' },
  outline: { depth: '-1.6', feedRate: '80', toolDiameter: '0.8', millSpeed: '10000', isolationWidth: '0', isolationSteps: '0' },
  pads: { depth: '-0.06', feedRate: '120', toolDiameter: '0.1', millSpeed: '10000', isolationWidth: '0', isolationSteps: '0' }
};

let currentConfig = {
  pcbWidth: '',
  pcbHeight: '',
  depth: '-0.06',
  feedRate: '120',
  toolDiameter: '0.1',
  millSpeed: '10000',
  isolationWidth: '0.25',
  isolationSteps: '2'
};

const workflowSteps = document.querySelectorAll('.workflow-step');
const stepItems = document.querySelectorAll('.step-item');
applyModeCopy();

// Workflow Logic
const setStep = (step) => {
    // Si estamos en printshop y saltamos al paso 2 (nesting), ir directo al 3
    if (currentMode === 'printshop' && step === 2) {
        setStep(3);
        return;
    }

    currentStep = step;
    workflowSteps.forEach((el, idx) => {
        el.classList.toggle('active', idx + 1 === step);
    });
    stepItems.forEach((el, idx) => {
        el.classList.toggle('active', idx + 1 === step);
        el.classList.toggle('completed', idx + 1 < step);
    });
    // Force resize for 3D viewers if entering simulation step
    if (step === 4) { // Ahora Simulación es el paso 4
        setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

const isStepValid = (step) => {
    if (step === 1) return !!currentJobId;
    if (step === 2) return currentMode === 'printshop' || true; // Nesting siempre válido o ignorado
    if (step === 3) return true; // CAM
    if (step === 4) return !!activeViewerGcode; // Simulación
    return true;
};

document.querySelectorAll('[data-step-target]').forEach(item => {
    item.addEventListener('click', () => {
        const target = parseInt(item.dataset.stepTarget);
        if (target < currentStep || isStepValid(currentStep)) {
            setStep(target);
        }
    });
});

document.querySelectorAll('[data-step-prev]').forEach(btn => {
    btn.addEventListener('click', () => {
        let prev = currentStep - 1;
        if (currentMode === 'printshop' && prev === 2) prev = 1;
        // Si estamos en el paso 3 y vamos atrás en printshop, ir al 1
        setStep(prev);
    });
});

// Helper Functions
const formatBytes = (value) => {
  if (!value) return '0 KB';
  if (value > 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${(value / 1024).toFixed(1)} KB`;
};

const renderUploads = (items) => {
  if (!uploadsList) return;
  if (!items || items.length === 0) {
    uploadsList.innerHTML = '<tr><td colspan="4" class="placeholder" style="text-align: center; padding: 1rem;">No hay trabajos registrados.</td></tr>';
    return;
  }

  // Filtrar trabajos completados para el historial
  const history = items.filter(i => ['READY', 'SENDING', 'COMPLETED'].includes(i.status));
  // Filtrar trabajos nuevos para la cola de producción (solo si es operador)
  const pending = items.filter(i => i.status === 'RECEIVED');

  const productionQueue = document.getElementById('production-queue-list');
  const queueCount = document.getElementById('queue-count');

  if (productionQueue && currentMode === 'saas') {
      if (pending.length === 0) {
          productionQueue.innerHTML = '<div class="placeholder">Esperando nuevos diseños de la red...</div>';
          if (queueCount) queueCount.textContent = '0 Pendientes';
      } else {
          if (queueCount) queueCount.textContent = `${pending.length} Pendientes`;
          productionQueue.innerHTML = pending.map(job => `
            <div class="queue-item-card">
                <div class="job-info">
                    <span class="designer-name">${job.alias || 'Anónimo'}</span>
                    <span class="file-name">${job.filename}</span>
                    ${job.verificationKey ? `<span class="job-meta">Llave: ${job.verificationKey}</span>` : ''}
                    ${describeClient(job) ? `<span class="job-meta">Origen: ${describeClient(job)}</span>` : ''}
                    <span class="job-meta">Recibido: ${new Date(job.uploadedAt).toLocaleTimeString()}</span>
                </div>
                <button class="btn-process" onclick="window.prepareJob(${job.id})">Preparar Trabajo</button>
            </div>
          `).join('');
      }
  }

  uploadsList.innerHTML = history.map((item) => {
      const uploadedAt = new Date(item.uploadedAt).toLocaleTimeString('es-ES');
      const stageClass = item.status === 'COMPLETED' ? 'info' : 
                         item.status === 'FAILED' ? 'status' : 'neutral';
      return `
        <tr>
          <td><strong style="color: var(--accent);">${item.alias || 'Anónimo'}</strong></td>
          <td>
            <div style="font-weight: 600; color: #fff;">${item.filename}</div>
            ${item.verificationKey ? `<div style="font-size: 0.75rem; color: #94a3b8;">Llave: ${item.verificationKey}</div>` : ''}
            ${describeClient(item) ? `<div style="font-size: 0.75rem; color: #94a3b8;">Origen: ${describeClient(item)}</div>` : ''}
            <div style="font-size: 0.75rem; color: #94a3b8;">${uploadedAt}</div>
          </td>
          <td><span class="badge ${stageClass}" style="font-size: 0.7rem;">${item.stage}</span></td>
        </tr>
      `;
    }).join('');
};

window.prepareJob = async (jobId) => {
    console.log(`Preparando trabajo: ${jobId} en modo ${currentMode}`);
    const statusBadge = document.getElementById('viewer-status');
    
    try {
        currentJobId = jobId;
        
        if (currentMode === 'printshop') {
            if (statusBadge) {
                statusBadge.textContent = "Procesando Gerber...";
                statusBadge.className = "badge info";
            }
            const response = await fetch(withClientScope(`${API_BASE}/process/${jobId}`), { method: 'POST' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            
            updateExecutionList(data);
            if (data.combined_gcode) setActiveViewerGcode(data.combined_gcode);
            ensureViewerController().then((vc) => {
                if (vc?.loadJobLayers) vc.loadJobLayers(data);
            });
            setStep(3); // Ir a CAM (Análisis de Precio)
        } else {
            // MODO SaaS / Education
            if (statusBadge) {
                statusBadge.textContent = "Midiendo PCB...";
                statusBadge.className = "badge info";
            }
            // Solo medir para tener dimensiones iniciales
            const response = await fetch(withClientScope(`${API_BASE}/measure/${jobId}`), { method: 'POST' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            
            renderRecentFile({
                dimensions: { widthMm: data.dimensions.width_mm, heightMm: data.dimensions.height_mm },
                area_mm2: data.dimensions.area_mm2,
                price_bs: data.dimensions.price_bs,
                uploadedAt: new Date().toISOString(),
                status: 'RECEIVED',
                stage: 'Recibido',
                filename: 'Proyecto',
                alias: 'Anónimo'
            });

            setStep(2); // Ir a Panelización
            refreshSheetPreview();
            if (statusBadge) {
                statusBadge.textContent = "Esperando ubicación";
                statusBadge.className = "badge neutral";
            }
        }
        
        fetchStatus();
        fetchUploads();
    } catch (err) {
        console.error("Error al preparar trabajo", err);
        alert("Error al procesar: " + err.message);
    }
};

// Nesting Logic
const autoNestBtn = document.getElementById('auto-nest-btn');
const refreshSheetBtn = document.getElementById('refresh-sheet-btn');
const nestingMarginInput = document.getElementById('nesting-margin');
const nestingFeedback = document.getElementById('nesting-feedback');
const sheetPreviewImg = document.getElementById('sheet-preview-img');
const continueToCamBtn = document.getElementById('continue-to-cam-btn');

const refreshSheetPreview = () => {
    if (sheetPreviewImg) {
        sheetPreviewImg.src = `${API_BASE}/sheet/preview?t=${Date.now()}`;
    }
};

if (autoNestBtn) {
    autoNestBtn.onclick = async () => {
        if (!currentJobId) return;
        
        autoNestBtn.disabled = true;
        nestingFeedback.textContent = "Midiendo y buscando espacio...";
        nestingFeedback.className = "feedback info";

        try {
            // Primero medir si no tiene dimensiones
            const measureRes = await fetch(withClientScope(`${API_BASE}/measure/${currentJobId}`), { method: 'POST' });
            if (!measureRes.ok) throw new Error("Error al medir el PCB");
            
            // Luego Nest
            const margin = nestingMarginInput?.value || 2.0;
            const nestRes = await fetch(withClientScope(`${API_BASE}/nest/${currentJobId}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(withClientJson({ margin }))
            });
            const nestData = await nestRes.json();
            
            if (!nestRes.ok) throw new Error(nestData.error || "No se pudo colocar el PCB");

            nestingFeedback.textContent = "PCB colocado con éxito.";
            nestingFeedback.className = "feedback success";
            refreshSheetPreview();
            if (continueToCamBtn) continueToCamBtn.disabled = false;
        } catch (err) {
            nestingFeedback.textContent = err.message;
            nestingFeedback.className = "feedback error";
        } finally {
            autoNestBtn.disabled = false;
        }
    };
}

if (refreshSheetBtn) {
    refreshSheetBtn.onclick = refreshSheetPreview;
}

if (continueToCamBtn) {
    continueToCamBtn.onclick = () => setStep(3);
}

const renderRecentFile = (upload) => {
  if (!uploadMetadata || !upload) return;
  const uploadedAt = new Date(upload.uploadedAt).toLocaleString('es-ES');
  const processLabel = upload.completedAt
    ? 'Completado'
    : upload.status === 'SENDING'
      ? 'En proceso'
      : upload.publishedToOperator
        ? 'En cola del operador'
        : upload.stage;

  const config = upload.config || {};
  const t = config.traces || {};
  const o = config.outline || {};
  const p = config.pads || {};

  // Cantidad (default 1)
  const qty = upload.quantity || 1;
  const unitPrice = upload.price_bs || 0;
  const totalPrice = (unitPrice * qty).toFixed(2);

  uploadMetadata.innerHTML = `
    <div><strong>Alias</strong><span>${upload.alias || 'Anónimo'}</span></div>
    <div><strong>Subido</strong><span>${uploadedAt}</span></div>
    ${describeClient(upload) ? `<div><strong>Origen</strong><span>${describeClient(upload)}</span></div>` : ''}
    <div><strong>Llave</strong><span>${upload.verificationKey || '--'}</span></div>
    <div><strong>Estado</strong><span>${upload.publishedToOperator ? 'En cola del operador' : 'Borrador privado'}</span></div>
    <div><strong>Dimensiones</strong><span>${upload.dimensions?.widthMm ?? 'n/a'} × ${upload.dimensions?.heightMm ?? 'n/a'} mm</span></div>
    <div><strong>Área</strong><span>${upload.area_mm2 ?? 'n/a'} mm²</span></div>
    
    <div style="border-top: 1px solid #334155; grid-column: span 2; margin: 0.5rem 0; padding-top: 0.5rem;"></div>
    <div><strong>Cantidad</strong><input type="number" id="pcb-quantity" value="${qty}" min="1" style="width: 60px; background: #0f172a; border: 1px solid var(--border); color: white; padding: 2px 5px; border-radius: 4px;"></div>
    <div><strong>Costo Unit.</strong><span>Bs ${unitPrice.toFixed(2)}</span></div>
  `;

  if (document.getElementById('printshop-price')) {
      document.getElementById('printshop-price').textContent = `Bs ${totalPrice}`;
  }

  // Listener para cantidad
  const qtyInput = document.getElementById('pcb-quantity');
  if (qtyInput) {
      qtyInput.onchange = (e) => {
          const newQty = parseInt(e.target.value) || 1;
          const newTotal = (unitPrice * newQty).toFixed(2);
          if (document.getElementById('printshop-price')) {
              document.getElementById('printshop-price').textContent = `Bs ${newTotal}`;
          }
          // Podríamos enviar esto al servidor si queremos persistirlo
      };
  }

  applyUploadDimensions(upload);
  updatePrintshopMonitor(upload);
};

const applyUploadDimensions = (upload) => {
  if (!upload) return;
  const width = upload.dimensions?.widthMm;
  const height = upload.dimensions?.heightMm;
  const pcbWidthInput = document.querySelector('input[name="pcbWidth"]');
  const pcbHeightInput = document.querySelector('input[name="pcbHeight"]');
  if (width && pcbWidthInput) pcbWidthInput.value = width.toFixed(2);
  if (height && pcbHeightInput) pcbHeightInput.value = height.toFixed(2);
};

const updatePrintshopMonitor = (upload) => {
  if (!upload) return;

  if (jobVerificationKey) {
    jobVerificationKey.textContent = upload.verificationKey || '--';
  }

  if (jobMonitorStatus) {
    let label = upload.stage || upload.status || 'Pendiente';
    if (upload.completedAt) {
      label = 'Completado';
    } else if (upload.status === 'SENDING') {
      label = 'En proceso';
    } else if (upload.publishedToOperator) {
      label = 'En cola del operador';
    } else {
      label = 'Borrador privado';
    }
    jobMonitorStatus.textContent = label;
    jobMonitorStatus.className = `badge ${upload.completedAt ? 'info' : upload.status === 'SENDING' ? 'neutral' : upload.publishedToOperator ? 'info' : 'status'}`;
  }

  if (jobCompletedAt) {
    jobCompletedAt.textContent = upload.completedAt
      ? new Date(upload.completedAt).toLocaleString('es-ES')
      : (upload.publishedToOperator ? 'En espera' : 'Pendiente');
  }

  if (jobMonitorNote) {
    if (upload.completedAt) {
      jobMonitorNote.textContent = 'El trabajo ya terminó. Revisa la hora de cierre y la llave.';
    } else if (upload.status === 'SENDING') {
      jobMonitorNote.textContent = 'El operador lo está fabricando ahora mismo.';
    } else if (upload.publishedToOperator) {
      jobMonitorNote.textContent = 'Ya fue enviado al operador y está en la cola.';
    } else {
      jobMonitorNote.textContent = 'El diseño sigue en revisión local hasta que lo confirmes.';
    }
  }
};

const setActiveViewerGcode = (name) => {
  activeViewerGcode = name || null;
  if (confirmButton) confirmButton.disabled = !activeViewerGcode;
};

const updateExecutionList = (job) => {
    if (!executionLayersList || !job.layers) return;
    currentJobLayers = job.layers;
    
    executionLayersList.innerHTML = job.layers.map(layer => `
        <div class="exec-layer-item" id="exec-item-${layer.type}">
            <div class="layer-name">
                <strong>Capa: ${layer.type === 'traces' ? 'Pistas' : layer.type === 'outline' ? 'Contorno' : 'Pads'}</strong>
                <span>${layer.name}</span>
            </div>
            <button class="btn-exec" onclick="window.sendSpecificLayer('${layer.name}', '${layer.type}')">
                Ejecutar Capa
            </button>
        </div>
    `).join('');
};

window.sendSpecificLayer = async (filename, type) => {
    console.log(`Enviando capa individual: ${filename} (${type})`);
    
    // Disable all exec buttons
    document.querySelectorAll('.btn-exec').forEach(b => b.disabled = true);
    document.querySelectorAll('.exec-layer-item').forEach(i => i.classList.remove('running'));
    
    const item = document.getElementById(`exec-item-${type}`);
    if (item) item.classList.add('running');
    
    if (activeLayerInfo) activeLayerInfo.textContent = `Ejecutando: ${type.toUpperCase()}`;
    
    try {
        const response = await fetch(`${API_BASE}/viewer/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withClientJson({ name: filename, jobId: currentJobId, layerType: type }))
        });
        
        if (!response.ok) throw new Error('Error al iniciar envío');
        
        // Start stream connection
        connectRealtimeStream();
        
    } catch (err) {
        console.error("Error al enviar capa", err);
        if (activeLayerInfo) activeLayerInfo.textContent = "Error al iniciar";
        document.querySelectorAll('.btn-exec').forEach(b => b.disabled = false);
    }
};

// Telemetry & Logs
const updateTelemetry = (data) => {
    const posX = document.getElementById('pos-x');
    const posY = document.getElementById('pos-y');
    const posZ = document.getElementById('pos-z');
    const progressBar = document.getElementById('cnc-progress-bar');
    const progressText = document.querySelector('.progress-text');
    
    if (posX) posX.textContent = (data.x ?? 0).toFixed(2);
    if (posY) posY.textContent = (data.y ?? 0).toFixed(2);
    if (posZ) posZ.textContent = (data.z ?? 0).toFixed(2);
    
    if (data.progress !== undefined && progressBar) {
        const percent = Math.round(data.progress);
        progressBar.style.width = `${percent}%`;
        if (progressText) progressText.textContent = `${percent}% completado`;
        
        if (percent >= 100) {
            // Re-enable buttons when finished
            document.querySelectorAll('.btn-exec').forEach(b => b.disabled = false);
            document.querySelectorAll('.exec-layer-item').forEach(i => i.classList.remove('running'));
            if (activeLayerInfo) activeLayerInfo.textContent = "Capa finalizada";
        }
    }
    
    if (data.command) appendLog(data.command, 'command');
    if (data.response) appendLog(data.response, 'response');
};

const appendLog = (text, type = '') => {
    const consoleBox = document.getElementById('cnc-console');
    if (!consoleBox) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    consoleBox.appendChild(entry);
    consoleBox.scrollTop = consoleBox.scrollHeight;
};

// Data Fetching
const fetchStatus = async () => {
  try {
    const response = await fetch(withClientScope(`${API_BASE}/status`));
    const payload = await response.json();
    renderRecentFile(payload.recentUpload);
  } catch (e) {}
};

const fetchUploads = async () => {
  try {
    const response = await fetch(withClientScope(`${API_BASE}/uploads`));
    const items = await response.json();
    renderUploads(items);
  } catch (e) {}
};

const fetchSerialInfo = async () => {
  try {
    const response = await fetch(`${API_BASE}/ports`);
    const payload = await response.json();
    const hasPort = payload?.ports?.length > 0;
    if (navSerialStatus) {
        navSerialStatus.textContent = hasPort ? `CNC: ${payload.selectedPort}` : 'CNC: Desconectada';
        navSerialStatus.className = `badge ${hasPort ? 'info' : 'status'}`;
    }
  } catch (e) {}
};

// Modal Elements
const layerModal = document.getElementById('layer-config-modal');
const layerForm = document.getElementById('layer-config-form');
const closeModalBtn = document.querySelector('.close-modal');

const openLayerConfig = (type) => {
    console.log(`Abriendo configuración para la capa: ${type}`);
    if (!layerModal || !layerForm) {
        console.error("No se encontró el modal o el formulario de capa");
        return;
    }
    const config = layerConfigs[type];
    if (!config) {
        console.error(`No hay configuración definida para la capa: ${type}`);
        return;
    }
    
    const title = document.getElementById('modal-layer-title');
    if (title) title.textContent = `Configuración: ${type.toUpperCase()}`;
    
    layerForm.elements['layerType'].value = type;
    layerForm.elements['depth'].value = config.depth || '';
    layerForm.elements['feedRate'].value = config.feedRate || '';
    layerForm.elements['toolDiameter'].value = config.toolDiameter || '';
    layerForm.elements['millSpeed'].value = config.millSpeed || '';
    
    const isoWidth = document.getElementById('isolation-width-label');
    const isoSteps = document.getElementById('isolation-steps-label');
    
    if (type === 'traces') {
        if (isoWidth) isoWidth.style.display = 'block';
        if (isoSteps) isoSteps.style.display = 'block';
        layerForm.elements['isolationWidth'].value = config.isolationWidth || '0.25';
        layerForm.elements['isolationSteps'].value = config.isolationSteps || '2';
    } else {
        if (isoWidth) isoWidth.style.display = 'none';
        if (isoSteps) isoSteps.style.display = 'none';
    }
    
    console.log("Mostrando modal...");
    layerModal.style.display = 'block';
    layerModal.classList.add('is-open'); // Asegurar visibilidad con clase si existe
};

if (closeModalBtn) {
    closeModalBtn.onclick = (e) => {
        e.preventDefault();
        layerModal.style.display = 'none';
        layerModal.classList.remove('is-open');
    };
}

// Cerrar modal al hacer click fuera
window.onclick = (event) => {
    if (event.target == layerModal) {
        layerModal.style.display = "none";
        layerModal.classList.remove('is-open');
    }
};

if (layerForm) {
    layerForm.onsubmit = async (e) => {
        e.preventDefault();
        const data = new FormData(layerForm);
        const type = data.get('layerType');
        
        const updatedConfig = {
            depth: data.get('depth'),
            feedRate: data.get('feedRate'),
            toolDiameter: data.get('toolDiameter'),
            millSpeed: data.get('millSpeed'),
            isolationWidth: data.get('isolationWidth') || '0',
            isolationSteps: data.get('isolationSteps') || '0'
        };

        layerConfigs[type] = updatedConfig;
        layerModal.style.display = 'none';
        layerModal.classList.remove('is-open');
        
        if (currentJobId) {
            const statusBadge = document.getElementById('viewer-status');
            if (statusBadge) {
                statusBadge.textContent = `Reprocesando ${type}...`;
                statusBadge.className = 'badge info';
            }
            
            try {
                const response = await fetch(`${API_BASE}/reprocess`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        jobId: currentJobId, 
                        layerType: type, 
                        config: updatedConfig 
                    })
                });
                const result = await response.json();
                if (result.layers) {
                    updateExecutionList(result);
                    const vc = await ensureViewerController();
                    if (vc?.loadJobLayers) {
                        await vc.loadJobLayers(result);
                    }
                    if (statusBadge) {
                        statusBadge.textContent = 'Capa actualizada';
                        statusBadge.className = 'badge info';
                        setTimeout(() => {
                            statusBadge.textContent = 'Visores listos';
                            statusBadge.className = 'badge neutral';
                        }, 2000);
                    }
                }
            } catch (err) {
                console.error("Error reprocesando", err);
                if (statusBadge) {
                    statusBadge.textContent = 'Error al procesar';
                    statusBadge.className = 'badge status';
                }
            }
        }
    };
}

const initViewerControls = () => {
    console.log("Iniciando controles de visor...");
    document.querySelectorAll('.viewer-instance').forEach(instance => {
        const type = instance.dataset.layerType;
        const playBtn = instance.querySelector('.play-btn');
        const stopBtn = instance.querySelector('.stop-btn');
        const configBtn = instance.querySelector('.config-btn');
        const progressRange = instance.querySelector('.viewer-progress');
        const canvas = instance.querySelector('canvas');
        
        console.log(`Configurando botones para: ${type}`);
        
        if (playBtn) playBtn.onclick = () => {
            console.log(`Play en ${type}`);
            viewerController?.viewers[type]?.play();
        };
        
        if (stopBtn) stopBtn.onclick = () => {
            console.log(`Stop en ${type}`);
            viewerController?.viewers[type]?.stop();
        };
        
        if (configBtn) configBtn.onclick = () => {
            console.log(`Click en engranaje de ${type}`);
            openLayerConfig(type);
        };
        
        if (progressRange) {
            progressRange.oninput = (e) => viewerController?.viewers[type]?.setProgress(parseFloat(e.target.value));
            canvas?.addEventListener('viewer-progress', (e) => {
                progressRange.value = e.detail.progress;
            });
        }
    });
};

if (uploadForm && isPanel) {
  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    console.log("Form submission started");
    const alias = document.getElementById('user-alias')?.value || 'Anónimo';
    const files = collectSelectedFiles();
    if (files.length === 0) {
        uploadFeedback.textContent = 'Selecciona al menos un archivo Gerber.';
        uploadFeedback.style.color = "#ef4444";
        return;
    }

    const submitBtn = document.getElementById('submit-project-btn');
    if (submitBtn) submitBtn.disabled = true;
    uploadFeedback.textContent = 'Enviando a la cola de producción...';

    const payload = new FormData();
    payload.append('alias', alias);
    payload.append('workflow_mode', currentMode);
    files.forEach((file) => {
        payload.append('gerber_files', file);
        const layer = inferLayerType(file.name);
        if (layer === 'traces') payload.append('gb1', file);
        if (layer === 'outline') payload.append('gb0', file);
        if (layer === 'pads') payload.append('gb2', file);
    });
    withClientFormData(payload);
    
    // Send full config object
    payload.append('config', JSON.stringify(layerConfigs));

    try {
      const response = await fetch(`${API_BASE}/upload`, { method: 'POST', body: payload });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Error de carga');

      if (currentMode === 'education' || currentMode === 'printshop') {
          // MODO LOCAL / DISEÑADOR: Procesar automáticamente para ver precio y simulación
          uploadFeedback.textContent = currentMode === 'printshop'
            ? 'Proyecto recibido. Analizando precio y preparando simulación...'
            : '¡Archivo cargado! Procesando...';
          clearSelectedFiles();
          window.prepareJob(data.id);
      } else {
          // MODO DISEÑADOR (RED): Solo confirmar envío
          uploadFeedback.textContent = "¡Enviado con éxito! El operador lo procesará pronto.";
          uploadFeedback.style.color = "#22c55e";

          // Limpiar selección después de éxito
          clearSelectedFiles();
          if (document.getElementById('user-alias')) document.getElementById('user-alias').value = '';
          fetchUploads();
      }
    } catch (err) {
      console.error("Upload process error:", err);
      uploadFeedback.textContent = err.message || 'Error al procesar.';
      uploadFeedback.style.color = "#ef4444";
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// Tab Switching for Config Step 2
document.querySelectorAll('[data-config-tab]').forEach(btn => {
    btn.onclick = () => {
        const target = btn.dataset.configTab;
        document.querySelectorAll('[data-config-tab]').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.config-tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${target}`));
    };
});

if (configForm && isPanel) {
  configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(configForm);
    
    // Build separate configs
    layerConfigs = {
      traces: {
          depth: data.get('t_depth'),
          feedRate: data.get('t_feedRate'),
          toolDiameter: data.get('t_toolDiameter'),
          millSpeed: data.get('t_millSpeed'),
          isolationWidth: data.get('t_isolationWidth'),
          isolationSteps: data.get('t_isolationSteps')
      },
      outline: {
          depth: data.get('o_depth'),
          feedRate: data.get('o_feedRate'),
          toolDiameter: data.get('o_toolDiameter'),
          millSpeed: data.get('o_millSpeed'),
          infeed: data.get('o_infeed')
      },
      pads: {
          depth: data.get('p_depth'),
          feedRate: data.get('p_feedRate'),
          toolDiameter: data.get('p_toolDiameter'),
          millSpeed: data.get('p_millSpeed')
      }
    };

    if (currentJobId) {
        uploadFeedback.textContent = 'Reprocesando todas las capas...';
        try {
            const response = await fetch(`${API_BASE}/reprocess`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(withClientJson({ jobId: currentJobId, config: layerConfigs }))
            });
            const result = await response.json();
            if (result.layers) {
                updateExecutionList(result);
                if (result.combined_gcode) setActiveViewerGcode(result.combined_gcode);
                ensureViewerController().then((vc) => {
                    if (vc?.loadJobLayers) vc.loadJobLayers(result);
                });
            }
        } catch (err) {
            console.error("Error reprocesando", err);
        }
    }

    setStep(4);
  });
}

if (continueToSimBtn) {
  continueToSimBtn.addEventListener('click', () => {
    setStep(4);
  });
}

const publishCurrentJob = async () => {
  if (!currentJobId) {
    throw new Error('No hay trabajo activo para publicar.');
  }

  const response = await fetch(`${API_BASE}/publish/${currentJobId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withClientJson({ jobId: currentJobId }))
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Error al publicar');
  currentJobId = result.id || currentJobId;
  fetchStatus();
  fetchUploads();
  return result;
};

confirmButton?.addEventListener('click', async () => {
  const name = activeViewerGcode || viewerController?.currentGcode?.();
  if (!name && !currentJobId) return;
  confirmButton.disabled = true;
  confirmButton.textContent = 'Iniciando...';
  try {
    if (currentMode === 'printshop') {
      const result = await publishCurrentJob();
      if (confirmFeedback) confirmFeedback.textContent = result.message || 'Trabajo publicado para el operador.';
      setStep(5);
    } else {
      const response = await fetch(`${API_BASE}/viewer/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withClientJson({ name, jobId: currentJobId }))
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Error al enviar.');
      setStep(5);
      fetchStatus();
    }
  } catch (err) {
    if (confirmFeedback) confirmFeedback.textContent = err.message || 'Error al enviar.';
  } finally {
    confirmButton.textContent = getConfirmButtonLabel();
    confirmButton.disabled = false;
  }
});

// Realtime
let runtimeEventSource = null;
const connectRealtimeStream = () => {
  if (runtimeEventSource) runtimeEventSource.close();
  runtimeEventSource = new EventSource(withClientScope(`${API_BASE}/runtime/stream`));
  runtimeEventSource.onmessage = (e) => {
    const payload = JSON.parse(e.data);
    if (payload.event === 'telemetry') {
      viewerController?.applyRuntimeUpdate(payload);
      updateTelemetry(payload);
    }
  };
};

const toggleEditorBtn = document.getElementById('toggle-editor-btn');
const gcodeVisualizer = document.getElementById('gcode-viewer');

if (toggleEditorBtn && gcodeVisualizer) {
    toggleEditorBtn.addEventListener('click', () => {
        const isHidden = gcodeVisualizer.classList.toggle('hide-editor');
        toggleEditorBtn.textContent = isHidden ? 'Ver Código G' : 'Ocultar Código G';
        // Force three.js resize
        window.dispatchEvent(new Event('resize'));
    });
}

const handleAutoUpload = async () => {
    const gb1_file = urlParams.get('gb1');
    if (!gb1_file) return;

    uploadFeedback.textContent = 'Iniciando carga automática...';
    const payload = new FormData();
    
    // We can't easily get the File object from just a name in URL for security reasons
    // BUT if the user wants to trigger it, they usually have the files in the input or
    // we need to fetch them if they are already on the server.
    // Assuming for now it's to trigger the UI if inputs are filled.
    const gb1_input = document.getElementById('file-gb1');
    const gb0_input = document.getElementById('file-gb0');
    const gb2_input = document.getElementById('file-gb2');

    if (collectSelectedFiles().length > 0 || gb1_input?.files?.[0]) {
        uploadForm.dispatchEvent(new Event('submit'));
    }
};

// Global Inits (Serial poll)
fetchSerialInfo();
setInterval(fetchSerialInfo, 10000);

if (isPanel) {
  handleAutoUpload();

  // Inicializa el visor sin bloquear la carga de archivos si el módulo 3D falla.
  ensureViewerController().then((vc) => {
      if (!vc) return;
      vc.refreshFiles().then(jobs => {
          if (jobs && jobs.length > 0) {
              const latestJob = jobs[0];
              currentJobId = latestJob.id;
              updateExecutionList(latestJob);
              if (latestJob.combined_gcode) setActiveViewerGcode(latestJob.combined_gcode);
              vc.loadJobLayers(latestJob);
          }
      });
  });

  const refreshFilesBtn = document.getElementById('refreshFilesButton');
  if (refreshFilesBtn) {
      refreshFilesBtn.addEventListener('click', () => {
          ensureViewerController().then((vc) => {
              if (!vc) return;
              vc.refreshFiles().then(jobs => {
                  if (jobs && jobs.length > 0) vc.loadJobLayers(jobs[0]);
              });
          });
      });
  }

  fetchStatus();
  fetchUploads();
  
  window.addEventListener('viewer-file-change', (e) => setActiveViewerGcode(e.detail?.name));
  realtimeToggle?.addEventListener('change', (e) => {
      realtimeMode = e.target.checked;
      viewerController?.setRealtimeActive(realtimeMode);
      if (realtimeMode) connectRealtimeStream();
      else if (runtimeEventSource) runtimeEventSource.close();
  });
}
