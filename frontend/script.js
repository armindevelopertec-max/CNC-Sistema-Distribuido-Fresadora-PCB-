import { initViewer } from './viewer.js';

const API_BASE = window.API_BASE || '/api';

const pageId = document.body?.dataset.page;
const isPanel = pageId === 'panel';

const uploadForm = document.getElementById('upload-form');
const configForm = document.getElementById('config-form');
const uploadFeedback = document.getElementById('upload-feedback');
const configSummary = document.getElementById('config-summary');
const fileInfoList = document.getElementById('file-info');
const uploadMetadata = document.getElementById('upload-metadata');
const uploadsList = document.getElementById('uploads-list');
const systemStage = document.getElementById('system-stage');
const systemDetail = document.getElementById('system-detail');
const statusHistory = document.getElementById('status-history');
const refreshButton = document.getElementById('refresh-status');
const refreshViewerButton = document.getElementById('refresh-viewer');
const heroStage = document.getElementById('hero-stage');
const confirmButton = document.getElementById('confirm-send-btn');
const confirmFeedback = document.getElementById('confirm-feedback');
const serialStatus = document.getElementById('serial-status');
const navSerialStatus = document.getElementById('nav-serial-status');
const gerberFileInput = document.getElementById('gerber-file');
const gerberPreviewContainer = document.getElementById('gerber-preview');
const gerberPreviewImg = document.getElementById('gerber-preview-img');
const gerberPreviewPlaceholder = document.getElementById('gerber-preview-placeholder');
const loginForm = document.getElementById('login-form');
const loginFeedback = document.getElementById('login-feedback');
const registerForm = document.getElementById('register-form');
const registerFeedback = document.getElementById('register-feedback');
const realtimeToggle = document.getElementById('realtime-toggle');
const realtimeHint = document.getElementById('realtime-hint');
const realtimeStatus = document.getElementById('realtime-status');
const resetCncButton = document.getElementById('reset-cnc-btn');
const resetFeedback = document.getElementById('reset-feedback');

const configModal = document.getElementById('config-modal');
const configModalClose = document.getElementById('close-config-modal');
const configModalTriggers = configModal
  ? Array.from(document.querySelectorAll('[data-config-open]'))
  : [];

const DEFAULT_CONFIG = {
  pcbWidth: '',
  pcbHeight: '',
  depth: '0.6',
  feedRate: '120',
  toolDiameter: '0.8'
};

let currentConfig = { ...DEFAULT_CONFIG };
let viewerController = null;
let activeViewerGcode = null;
let configEditable = false;
let realtimeMode = false;
let realtimeTimer = null;
const REALTIME_INTERVAL_MS = 4000;
const configEditableInputs = configForm ? Array.from(configForm.querySelectorAll('input:not([data-auto-size])')) : [];
const pcbWidthInput = document.querySelector('input[name="pcbWidth"]');
const pcbHeightInput = document.querySelector('input[name="pcbHeight"]');

const formatBytes = (value) => {
  if (!value) return '0 KB';
  if (value > 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(value / 1024).toFixed(1)} KB`;
};

const resetGerberPreview = () => {
  if (!gerberPreviewContainer || !gerberPreviewImg || !gerberPreviewPlaceholder) return;
  gerberPreviewContainer.classList.remove('loaded');
  gerberPreviewImg.src = '';
  gerberPreviewPlaceholder.textContent = 'Vista previa del Gerber';
};

const renderGerberPreview = async (file) => {
  if (!file || !gerberPreviewContainer || !gerberPreviewImg || !gerberPreviewPlaceholder) {
    resetGerberPreview();
    return;
  }
  gerberPreviewPlaceholder.textContent = 'Generando vista previa...';
  try {
    const payload = new FormData();
    payload.append('gerber', file);
    const response = await fetch(`${API_BASE}/gerber/preview`, {
      method: 'POST',
      body: payload
    });
    if (!response.ok) {
      throw new Error('No se pudo generar la vista previa.');
    }
    const body = await response.json();
    if (body.preview) {
      gerberPreviewImg.src = body.preview;
      gerberPreviewContainer.classList.add('loaded');
      gerberPreviewPlaceholder.textContent = '';
    } else {
      throw new Error('Vista previa no disponible.');
    }
  } catch (error) {
    console.error(error);
    if (gerberPreviewPlaceholder) {
      gerberPreviewPlaceholder.textContent = 'No se pudo mostrar el Gerber.';
    }
    gerberPreviewContainer.classList.remove('loaded');
  }
};

const expandGerberPreview = () => {
  if (!gerberPreviewContainer) return;
  gerberPreviewContainer.classList.add('expanded');
};

const collapseGerberPreview = () => {
  if (!gerberPreviewContainer) return;
  gerberPreviewContainer.classList.remove('expanded');
};

const formatConfigValue = (value, fallback = '—') => (value ? value : fallback);

const updateConfigSummary = () => {
  if (!configSummary) return;
  const widthDisplay = formatConfigValue(currentConfig.pcbWidth);
  const heightDisplay = formatConfigValue(currentConfig.pcbHeight);
  const depthDisplay = formatConfigValue(currentConfig.depth);
  const feedDisplay = formatConfigValue(currentConfig.feedRate);
  const toolDisplay = formatConfigValue(currentConfig.toolDiameter);
  configSummary.textContent = `Configuración actual → ${widthDisplay}×${heightDisplay} mm · Profundidad ${depthDisplay} mm · Feed ${feedDisplay} mm/min · Herramienta ${toolDisplay} mm`;
};

const setConfigEditableState = (enabled) => {
  configEditable = enabled;
  configEditableInputs.forEach((input) => {
    input.disabled = !enabled;
  });
  if (configForm) {
    configForm.classList.toggle('editing', enabled);
  }
};

const openConfigModal = () => {
  if (!configModal) return;
  setConfigEditableState(true);
  configModal.classList.add('is-open');
  configModal.setAttribute('aria-hidden', 'false');
  const focusTarget = configForm?.querySelector('input:not([readonly])');
  focusTarget?.focus();
};

const closeConfigModal = () => {
  if (!configModal) return;
  configModal.classList.remove('is-open');
  configModal.setAttribute('aria-hidden', 'true');
  setConfigEditableState(false);
};

const renderStatusHistory = (history) => {
  if (!statusHistory) return;
  if (!history || history.length === 0) {
    statusHistory.innerHTML = '<li class="placeholder">Sin eventos registrados aún.</li>';
    return;
  }

  statusHistory.innerHTML = history
    .slice()
    .reverse()
    .map((entry) => {
      const when = new Date(entry.timestamp).toLocaleTimeString('es-ES');
      return `<li><strong>${entry.stage}</strong><span>${when}</span><p>${entry.detail}</p></li>`;
    })
    .join('');
};

const renderUploads = (items) => {
  if (!uploadsList) return;
  if (!items || items.length === 0) {
    uploadsList.innerHTML = '<li class="placeholder">No hay archivos recientes.</li>';
    return;
  }

  uploadsList.innerHTML = items
    .map((item) => {
      const uploadedAt = new Date(item.uploadedAt).toLocaleTimeString('es-ES');
      return `
        <li>
          <strong>${item.filename}</strong>
          <span>${formatBytes(item.size)}</span>
          <span>${uploadedAt}</span>
          <span>${item.stage}</span>
        </li>
      `;
    })
    .join('');
};

const renderRecentFile = (upload) => {
  if (!fileInfoList || !uploadMetadata) return;
  if (!upload) {
    fileInfoList.innerHTML = '<li class="placeholder">No se ha enviado ningún Gerber todavía.</li>';
    uploadMetadata.innerHTML = '';
    return;
  }

  const uploadedAt = new Date(upload.uploadedAt).toLocaleString('es-ES');
  fileInfoList.innerHTML = `
    <li>
      <strong>${upload.filename}</strong>
      <span>Estado: ${upload.stage}</span>
    </li>
  `;
  uploadMetadata.innerHTML = `
    <div>
      <strong>Subido</strong>
      <span>${uploadedAt}</span>
    </div>
    <div>
      <strong>Dimensiones</strong>
      <span>${upload.config?.pcbWidth ?? 'n/a'} × ${upload.config?.pcbHeight ?? 'n/a'} mm</span>
    </div>
    <div>
      <strong>Profundidad</strong>
      <span>${upload.config?.depth ?? 'n/a'} mm</span>
    </div>
    <div>
      <strong>Herramienta</strong>
      <span>${upload.config?.toolDiameter ?? 'n/a'} mm</span>
    </div>
    <div>
      <strong>Feed</strong>
      <span>${upload.config?.feedRate ?? 'n/a'} mm/min</span>
    </div>
    <div>
      <strong>Tamaño</strong>
      <span>${formatBytes(upload.size)}</span>
    </div>
  `;
  applyUploadDimensions(upload);
};

const applyUploadDimensions = (upload) => {
  if (!upload) return;
  const width = upload.dimensions?.widthMm;
  const height = upload.dimensions?.heightMm;
  let updated = false;
  if (width && pcbWidthInput) {
    const text = width.toFixed(2);
    pcbWidthInput.value = text;
    currentConfig.pcbWidth = text;
    updated = true;
  }
  if (height && pcbHeightInput) {
    const text = height.toFixed(2);
    pcbHeightInput.value = text;
    currentConfig.pcbHeight = text;
    updated = true;
  }
  if (updated) {
    updateConfigSummary();
  }
};

const updateConfirmControls = ({ skipFeedback = false } = {}) => {
  if (!confirmButton) return;
  confirmButton.disabled = !activeViewerGcode;
  confirmButton.textContent = 'Confirmar envío a CNC';
  if (confirmFeedback) {
    if (!skipFeedback) {
      confirmFeedback.textContent = activeViewerGcode
        ? `Listo para enviar ${activeViewerGcode}`
        : 'Carga o selecciona un G-code para confirmar el envío.';
    }
  }
};

const setActiveViewerGcode = (name) => {
  activeViewerGcode = name || null;
  updateConfirmControls();
};

const fetchStatus = async () => {
  try {
    const response = await fetch(`${API_BASE}/status`);
    if (!response.ok) {
      throw new Error('No se pudo obtener el estado del servidor.');
    }

    const payload = await response.json();
    if (systemStage) systemStage.textContent = payload.state.currentStage;
    if (systemDetail) systemDetail.textContent = payload.state.detail;
    if (heroStage) heroStage.textContent = payload.state.currentStage;
    renderStatusHistory(payload.state.history);
    renderRecentFile(payload.recentUpload);
  } catch (error) {
    console.error(error);
    if (systemStage) systemStage.textContent = 'Estado desconectado';
    if (systemDetail) systemDetail.textContent = 'Revisa la conexión con el backend.';
    if (statusHistory) statusHistory.innerHTML = '<li class="placeholder">No se pueden cargar eventos.</li>';
    if (heroStage) heroStage.textContent = 'Desconectado';
  }
};

const fetchUploads = async () => {
  try {
    const response = await fetch(`${API_BASE}/uploads`);
    if (!response.ok) {
      throw new Error('No se pudo cargar el historial de archivos.');
    }

    const items = await response.json();
    renderUploads(items);
  } catch (error) {
    console.error(error);
    if (uploadsList) uploadsList.innerHTML = '<li class="placeholder">No se pudo recuperar el historial.</li>';
  }
};

const updateSerialDisplay = (payload) => {
  const selected = payload?.selectedPort ?? 'Sin puerto activo';
  const baud = payload?.baud ?? '—';
  const ports = payload?.ports ?? [];
  const hasPort = ports.some((entry) => entry.path === selected && entry.status === 'disponible');
  const statusText = `${selected} · ${baud} baudios${hasPort ? '' : ' (no detectado)'}`;
  if (serialStatus) {
    serialStatus.textContent = statusText;
  }
  if (navSerialStatus) {
    navSerialStatus.textContent = hasPort ? `${selected}@${baud}` : 'Serial · desconectado';
  }
};

const fetchSerialInfo = async () => {
  try {
    const response = await fetch(`${API_BASE}/ports`);
    if (!response.ok) {
      throw new Error('No se pudo consultar los puertos seriales.');
    }
    const payload = await response.json();
    updateSerialDisplay(payload);
  } catch (error) {
    console.error(error);
    if (serialStatus) {
      serialStatus.textContent = 'Puerto serial no accesible';
    }
    if (navSerialStatus) {
      navSerialStatus.textContent = 'Serial · desconectado';
    }
  }
};

const clearRealtimePoll = () => {
  if (realtimeTimer) {
    clearInterval(realtimeTimer);
    realtimeTimer = null;
  }
};

let runtimeEventSource = null;

const handleRuntimePayload = (payload) => {
  if (!payload) return;
  if (payload.event === 'telemetry') {
    viewerController?.applyRuntimeUpdate(payload);
    return;
  }
  if (payload.event === 'status' && payload.state && realtimeHint) {
    realtimeHint.textContent = payload.state === 'completed'
      ? 'El CNC finalizó el trabajo en tiempo real.'
      : payload.state === 'failed'
        ? 'Ocurrió un error durante el envío.'
        : 'Esperando el siguiente comando del CNC.';
  }
};

const connectRealtimeStream = () => {
  disconnectRealtimeStream();
  if (!window.EventSource) return;
  runtimeEventSource = new EventSource(`${API_BASE}/runtime/stream`);
  runtimeEventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleRuntimePayload(payload);
    } catch (error) {
      console.error('Error parseando evento runtime:', error);
    }
  };
  runtimeEventSource.onerror = () => {
    console.warn('Runtime stream error, se intentará reconectar.');
  };
};

const disconnectRealtimeStream = () => {
  if (runtimeEventSource) {
    runtimeEventSource.close();
    runtimeEventSource = null;
  }
};

const updateRealtimeText = () => {
  if (realtimeHint) {
    realtimeHint.textContent = realtimeMode
      ? 'La visualización sigue los G-code en tiempo real de forma automática.'
      : 'El visor permanece en simulación y responde a Play/Pause y Paso.';
  }
  if (realtimeStatus) {
    realtimeStatus.textContent = realtimeMode ? 'Tiempo real activado' : 'Simulación activa';
    realtimeStatus.classList.toggle('inactive', !realtimeMode);
  }
};

const setResetFeedback = (message, isError = false) => {
  if (!resetFeedback) return;
  resetFeedback.textContent = message;
  resetFeedback.classList.toggle('error', Boolean(isError));
};

const setRealtimeMode = (enabled) => {
  realtimeMode = enabled;
  if (realtimeToggle) realtimeToggle.checked = enabled;
  updateRealtimeText();
  viewerController?.setRealtimeActive(enabled);
  clearRealtimePoll();
  if (enabled && viewerController?.refreshFiles) {
    viewerController.refreshFiles({ skipLoad: true });
    realtimeTimer = setInterval(() => {
      viewerController.refreshFiles({ skipLoad: true });
    }, REALTIME_INTERVAL_MS);
    connectRealtimeStream();
  } else {
    disconnectRealtimeStream();
  }
};

confirmButton?.addEventListener('click', async () => {
  const nameToSend = activeViewerGcode || viewerController?.currentGcode?.();
  if (!nameToSend) return;
  confirmButton.disabled = true;
  confirmButton.textContent = 'Enviando...';
  try {
    const response = await fetch(`${API_BASE}/viewer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameToSend })
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      throw new Error(errorBody?.error || 'No se pudo enviar el G-code.');
    }
    const payload = await response.json();
    if (confirmFeedback) confirmFeedback.textContent = payload.message || 'Envío confirmado.';
    fetchStatus();
    fetchUploads();
  } catch (error) {
    console.error(error);
    if (confirmFeedback) confirmFeedback.textContent = error.message;
  } finally {
    updateConfirmControls({ skipFeedback: true });
    confirmButton.textContent = 'Confirmar envío a CNC';
  }
});

if (configForm && isPanel) {
  configForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(configForm);
    currentConfig = {
      pcbWidth: data.get('pcbWidth') || DEFAULT_CONFIG.pcbWidth,
      pcbHeight: data.get('pcbHeight') || DEFAULT_CONFIG.pcbHeight,
      depth: data.get('depth') || DEFAULT_CONFIG.depth,
      feedRate: data.get('feedRate') || DEFAULT_CONFIG.feedRate,
      toolDiameter: data.get('toolDiameter') || DEFAULT_CONFIG.toolDiameter
    };

    updateConfigSummary();
    if (uploadFeedback) uploadFeedback.textContent = 'Configuración actualizada.';
    closeConfigModal();
  });
  setConfigEditableState(false);
}

configModalTriggers.forEach((trigger) => {
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    openConfigModal();
  });
});

configModalClose?.addEventListener('click', closeConfigModal);
configModal?.addEventListener('click', (event) => {
  if (event.target === configModal) {
    closeConfigModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && configModal?.classList.contains('is-open')) {
    closeConfigModal();
  }
});

if (uploadForm && isPanel) {
  gerberFileInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) {
      renderGerberPreview(file);
    } else {
      resetGerberPreview();
    }
  });
  const triggerPreviewExpand = () => {
    if (!gerberPreviewContainer?.classList.contains('loaded')) return;
    expandGerberPreview();
  };
  const triggerPreviewCollapse = () => collapseGerberPreview();

  gerberPreviewImg?.addEventListener('click', triggerPreviewExpand);
  gerberPreviewContainer?.addEventListener('mouseenter', triggerPreviewExpand);
  gerberPreviewContainer?.addEventListener('mouseleave', triggerPreviewCollapse);
  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fileInput = document.getElementById('gerber-file');
    const file = fileInput?.files?.[0];

    if (!file) {
      if (uploadFeedback) uploadFeedback.textContent = 'Selecciona un archivo Gerber antes de enviar.';
      return;
    }

    const submitButton = uploadForm.querySelector('button');
    submitButton.disabled = true;
    if (uploadFeedback) uploadFeedback.textContent = 'Enviando archivo al servidor...';

    const payload = new FormData();
    payload.append('gerber', file);
    Object.entries(currentConfig).forEach(([key, value]) => {
      payload.append(key, value);
    });

    try {
      const response = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: payload
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.error || 'No se pudo enviar el Gerber.');
      }

      const { message } = await response.json();
      if (uploadFeedback) uploadFeedback.textContent = message;
      if (fileInput) fileInput.value = '';
      fetchStatus();
      fetchUploads();
    } catch (error) {
      console.error(error);
      if (uploadFeedback) uploadFeedback.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  });
}

if (loginForm) {
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(loginForm));
    if (loginFeedback) loginFeedback.textContent = 'Verificando credenciales...';

    try {
      const response = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.error || 'Inicio de sesión fallido.');
      }

      const payload = await response.json();
      if (loginFeedback) loginFeedback.textContent = payload.message;
    } catch (error) {
      console.error(error);
      if (loginFeedback) loginFeedback.textContent = error.message;
    }
  });
}

if (registerForm) {
  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(registerForm));
    if (registerFeedback) registerFeedback.textContent = 'Enviando datos de registro...';

    try {
      const response = await fetch(`${API_BASE}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.error || 'Registro fallido.');
      }

      const payload = await response.json();
      if (registerFeedback) registerFeedback.textContent = payload.message;
      registerForm.reset();
    } catch (error) {
      console.error(error);
      if (registerFeedback) registerFeedback.textContent = error.message;
    }
  });
}

if (refreshButton && isPanel) {
  refreshButton.addEventListener('click', () => {
    fetchStatus();
    fetchUploads();
  });
}

refreshViewerButton?.addEventListener('click', () => {
  viewerController?.refreshFiles();
});

const requestCncReset = async () => {
  if (!resetCncButton) return;
  const originalLabel = resetCncButton.textContent;
  resetCncButton.disabled = true;
  resetCncButton.textContent = 'Enviando reset...';
  try {
    const response = await fetch(`${API_BASE}/cnc/reset`, { method: 'POST' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'No se pudo solicitar el reset.');
    }
    const payload = await response.json();
    setResetFeedback(payload.message || 'Reset enviado correctamente.');
    await fetchStatus();
    await fetchUploads();
  } catch (error) {
    console.error(error);
    setResetFeedback(error.message, true);
  } finally {
    resetCncButton.disabled = false;
    resetCncButton.textContent = originalLabel;
  }
};

resetCncButton?.addEventListener('click', requestCncReset);

if (isPanel) {
  viewerController = initViewer({ apiBase: API_BASE });
  updateConfigSummary();
  fetchStatus();
  fetchUploads();
  fetchSerialInfo();
  setInterval(() => {
    fetchStatus();
    fetchUploads();
    fetchSerialInfo();
  }, 8000);
  window.addEventListener('viewer-file-change', (event) => {
    const name = event.detail?.name;
    setActiveViewerGcode(name);
  });
  window.addEventListener('gcode-uploaded', (event) => {
    const name = event.detail?.gcodeName;
    if (name) {
      setActiveViewerGcode(name);
    }
    fetchStatus();
    fetchUploads();
    if (confirmFeedback) confirmFeedback.textContent = 'G-code cargado, revisa y confirma.';
  });
  realtimeToggle?.addEventListener('change', (event) => {
    setRealtimeMode(event.target.checked);
  });
  setRealtimeMode(realtimeToggle?.checked ?? false);
  updateConfirmControls();
}
