const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const BASE_UPLOADS = path.join(__dirname, '..', 'uploads');
const GERBER_DIR = path.join(BASE_UPLOADS, 'gerber_files');
const GCODE_DIR = path.join(BASE_UPLOADS, 'gcode_output');
const PREVIEW_DIR = path.join(BASE_UPLOADS, 'previews');
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.gbr', '.gb0', '.gtl', '.gbl']);

const PCB2GCODE_BIN = process.env.PCB2GCODE_BIN || 'pcb2gcode';
const Z_SAFE = Number(process.env.Z_SAFE ?? 5);
const Z_CHANGE = Number(process.env.Z_CHANGE ?? 5);
const MILL_SPEED = process.env.MILL_SPEED || '10000';
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const SERIAL_PORT = process.env.CNC_SERIAL_PORT || '/dev/ttyACM0';
const SERIAL_BAUD = process.env.CNC_SERIAL_BAUD || '9600';
const SEND_SCRIPT = path.join(__dirname, '..', 'send.py');
const PRICE_PER_MM2 = Number(process.env.PRICE_PER_MM2 ?? '0.015'); // default price per mm²
const SERIAL_PREFIXES = ['ttyUSB', 'ttyACM', 'ttyS', 'ttyAMA', 'cu.usbmodem'];
const RETURN_TO_ORIGIN_SEQUENCE = ['G00 Z0.19685', 'G00 X0 Y0', 'M5', 'M30'];

const appendReturningSequence = async (targetPath) => {
  const content = await fs.promises.readFile(targetPath, 'utf8');
  // Skip appending when the G-code already uses pen/servo commands
  if (/M300\b/i.test(content)) {
    return;
  }
  if (RETURN_TO_ORIGIN_SEQUENCE.every((line) => content.includes(line))) {
    return;
  }
  const appended = `\n${RETURN_TO_ORIGIN_SEQUENCE.join('\n')}\n`;
  await fs.promises.appendFile(targetPath, appended);
};

const generateGerberPreview = async (sourcePath) => {
  const previewName = `${Date.now()}-preview.png`;
  const previewPath = path.join(PREVIEW_DIR, previewName);
  await runCommand('gerbv', ['-x', 'png', '-o', previewPath, sourcePath]);
  const data = await fs.promises.readFile(previewPath);
  await Promise.allSettled([
    fs.promises.unlink(previewPath),
    fs.promises.unlink(sourcePath)
  ]);
  return data.toString('base64');
};

fs.mkdirSync(GERBER_DIR, { recursive: true });
fs.mkdirSync(GCODE_DIR, { recursive: true });
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, GERBER_DIR),
  filename: (_req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${Date.now()}-${cleanName}`);
  }
});
const gcodeStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, GCODE_DIR),
  filename: (_req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${Date.now()}-${cleanName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return cb(new Error('Formato no permitido. Usa .GBR, .GB0, .GTL o .GBL'));
    }
    cb(null, true);
  }
});
const gcodeUpload = multer({
  storage: gcodeStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!['.ngc', '.gcode', '.tap', '.txt'].includes(extension)) {
      return cb(new Error('Solo se aceptan archivos G-code (.ngc, .gcode, .tap, .txt)'));
    }
    cb(null, true);
  }
});

const previewStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PREVIEW_DIR),
  filename: (_req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${Date.now()}-${cleanName}`);
  }
});

const previewUpload = multer({
  storage: previewStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return cb(new Error('Formato no permitido. Usa .GBR, .GB0, .GTL o .GBL'));
    }
    cb(null, true);
  }
});

const systemState = {
  currentStage: 'Esperando archivo Gerber',
  detail: 'El sistema está listo para recibir un archivo en formato Gerber.',
  history: []
};

const uploads = [];
let nextUploadId = 1;

const pushStage = (stage, detail) => {
  const timestamp = new Date().toISOString();
  systemState.currentStage = stage;
  systemState.detail = detail;
  systemState.history.push({ stage, detail, timestamp });
  if (systemState.history.length > 6) {
    systemState.history.shift();
  }
};

const parseNumber = (value, fallback) => {
  const candidate = typeof value === 'string' ? value.replace(',', '.') : value;
  const numeric = Number(candidate);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const runtimeState = require('./runtimeState');

const runCommand = (command, args, options = {}) => new Promise((resolve, reject) => {
  const proc = spawn(command, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });

  let stderr = '';
  let stdout = '';

  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    console.log(`[${command}] ${chunk.toString().trim()}`);
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    console.error(`[${command} err] ${chunk.toString().trim()}`);
  });

  proc.on('error', (error) => reject(error));
  proc.on('close', (code) => {
    if (code === 0) {
      resolve({ stdout, stderr });
    } else {
      reject(new Error(`El comando ${command} terminó con código ${code}. ${stderr.trim()}`));
    }
  });
});

const configureSerialPort = async () => {
  await runCommand('stty', [
    '-F',
    SERIAL_PORT,
    SERIAL_BAUD,
    'cs8',
    '-cstopb',
    '-parenb',
    'raw',
    '-echo'
  ]);
};

const sendSerialCommand = async (command) => {
  await configureSerialPort();
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(SERIAL_PORT, { flags: 'w', encoding: 'utf8' });
    writer.once('error', reject);
    writer.once('finish', resolve);
    writer.write(`${command}\n`, () => writer.end());
  });
};

const resetCncDevice = async () => {
  await sendSerialCommand('RESET');
  runtimeState.broadcastRuntimeUpdate({
    event: 'status',
    state: 'reset',
    message: 'Se envió RESET al firmware y el cabezal regresa a origen.'
  });
};

const generateGcodeFromGerber = async (entry) => {
  const inputPath = path.join(GERBER_DIR, entry.savedAs);
  const sanitizedBase = entry.savedAs.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/\.[^.]+$/, '');
  const gcodeBase = `${sanitizedBase}-${entry.id}`;
  entry.gcodeName = `${gcodeBase}.ngc`;
  entry.gcodePath = path.join(GCODE_DIR, entry.gcodeName);

  const numbers = {
    depth: Math.abs(parseNumber(entry.config?.depth ?? '0.6', 0.6)),
    feedRate: parseNumber(entry.config?.feedRate ?? '120', 120),
    toolDiameter: parseNumber(entry.config?.toolDiameter ?? '0.8', 0.8)
  };

  const args = [
    '--front',
    inputPath,
    '--metric',
    '--zsafe', Z_SAFE.toString(),
    '--zwork', `-${numbers.depth}`,
    '--zchange', Z_CHANGE.toString(),
    '--cutter-diameter', numbers.toolDiameter.toString(),
    '--mill-feed', numbers.feedRate.toString(),
    '--mill-speed', MILL_SPEED.toString(),
    '--basename', gcodeBase
  ];

  await fs.promises.access(inputPath, fs.constants.R_OK);
  const { stdout } = await runCommand(PCB2GCODE_BIN, args, { cwd: GCODE_DIR });
  entry.dimensions = extractDimensions(stdout);
  entry.quote = createQuote(entry.dimensions);

  entry.gcodeName = await findGeneratedGcode(entry, gcodeBase);
  entry.gcodePath = path.join(GCODE_DIR, entry.gcodeName);
  await fs.promises.access(entry.gcodePath, fs.constants.R_OK);
  await appendReturningSequence(entry.gcodePath);
  if (!entry.dimensions) {
    const measured = await measureGcodeBounds(entry.gcodePath);
    if (measured) {
      entry.dimensions = measured;
    }
  }
};

const sendGcodeToCnc = async (entry) => {
  if (!entry.gcodePath) {
    throw new Error('No hay archivo G-code listo para enviar.');
  }

  if (!fs.existsSync(SEND_SCRIPT)) {
    throw new Error('El script backend/send.py no está disponible desde el backend.');
  }

  const args = [
    SEND_SCRIPT,
    '--port', SERIAL_PORT,
    '--file', entry.gcodePath,
    '--baud', SERIAL_BAUD
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, args, { cwd: path.dirname(SEND_SCRIPT) });
    let buffer = '';
    runtimeState.broadcastRuntimeUpdate({ event: 'status', state: 'started', file: entry.gcodeName });

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const payload = JSON.parse(line);
          runtimeState.broadcastRuntimeUpdate(payload);
        } catch (jsonError) {
          // Ignore non-JSON output
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      console.error(`[send.py err] ${chunk.toString().trim()}`);
    });

    proc.on('error', (error) => {
      runtimeState.broadcastRuntimeUpdate({ event: 'status', state: 'failed', message: error.message });
      reject(error);
    });

    proc.on('close', (code) => {
      const statusPayload = {
        event: 'status',
        state: code === 0 ? 'completed' : 'failed',
        code,
        file: entry.gcodeName
      };
      runtimeState.broadcastRuntimeUpdate(statusPayload);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`El envío finalizó con código ${code}.`));
      }
    });
  });
};

const sendViewerGcode = async (name) => {
  if (!name) {
    throw new Error('Se requiere el nombre del archivo G-code.');
  }
  const safeName = path.basename(name);
  const targetPath = getGcodePath(safeName);
  await fs.promises.access(targetPath, fs.constants.R_OK);
  pushStage('Enviando a CNC', `Transferencia ${safeName}`);
  await sendGcodeToCnc({ gcodeName: safeName, gcodePath: targetPath });
  pushStage('Proceso finalizado', `Envió correcto a ${SERIAL_PORT}`);
  return safeName;
};

const processUpload = (entry) => {
  (async () => {
    try {
      entry.stage = 'Validando archivo Gerber';
      entry.detail = `Analizando ${entry.filename}`;
      pushStage(entry.stage, entry.detail);

      pushStage('Generando G-code', `Convirtiendo ${entry.filename}`);
      entry.stage = 'Generando G-code';
      entry.detail = 'Conversión en curso';
      await generateGcodeFromGerber(entry);

      entry.stage = 'Listo para confirmación';
      entry.detail = 'Revisa el G-code en NCViewer y confirma el envío.';
      entry.readyToSend = true;
      pushStage('Pendiente de confirmación', entry.detail);
    } catch (error) {
      entry.stage = 'Error';
      entry.detail = error.message;
      pushStage('Error de procesamiento', error.message);
      console.error('Error en pipeline automático:', error);
    }
  })();
};

const createUploadRecord = (file, config) => {
  const newEntry = {
    id: nextUploadId++,
    filename: file.originalname,
    savedAs: file.filename,
    size: file.size,
    extension: path.extname(file.originalname).toLowerCase(),
    uploadedAt: new Date().toISOString(),
    stage: 'Archivo recibido',
    detail: `Archivo almacenado (${(file.size / 1024).toFixed(1)} KB)`,
    config,
    readyToSend: false
  };

  uploads.unshift(newEntry);
  if (uploads.length > 12) {
    uploads.pop();
  }

  pushStage('Archivo recibido', `${newEntry.detail} - ${newEntry.filename}`);
  return newEntry;
};

const getGcodePath = (name) => path.join(GCODE_DIR, path.basename(name));

const listGcodeFiles = async () => {
  const entries = await fs.promises.readdir(GCODE_DIR, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.toLowerCase().endsWith('.ngc')) continue;
    const fullPath = path.join(GCODE_DIR, name);
    const stats = await fs.promises.stat(fullPath);
    result.push({
      name,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString()
    });
  }
  result.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  return result;
};

const readGcodeFile = async (name) => {
  const safeName = path.basename(name);
  if (!safeName.toLowerCase().endsWith('.ngc')) {
    throw new Error('Solo se admiten archivos .ngc para la vista.');
  }
  const target = path.join(GCODE_DIR, safeName);
  await fs.promises.access(target, fs.constants.R_OK);
  return fs.promises.readFile(target, 'utf8');
};

const findGeneratedGcode = async (entry, base) => {
  const entries = await fs.promises.readdir(GCODE_DIR);
  const candidates = entries
    .filter((name) => name.startsWith(base) && name.toLowerCase().endsWith('.ngc'));

  if (candidates.length === 0) {
    throw new Error(`No se encontró el G-code generado para ${entry.filename}`);
  }

  // Prefer a front-specific file if available
  const frontMatch = candidates.find((name) => name.endsWith('_front.ngc'));
  return frontMatch || candidates[0];
};

const extractDimensions = (stdout) => {
  const regex = /Height:\s*([\d.]+)in.*Width:\s*([\d.]+)in/;
  const match = regex.exec(stdout);
  if (!match) {
    return null;
  }
  const heightIn = Number(match[1]);
  const widthIn = Number(match[2]);
  const heightMm = parseFloat((heightIn * 25.4).toFixed(2));
  const widthMm = parseFloat((widthIn * 25.4).toFixed(2));
  return {
    widthIn,
    heightIn,
    widthMm,
    heightMm
  };
};

const measureGcodeBounds = async (filePath) => {
  const content = await fs.promises.readFile(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    let x = null;
    let y = null;
    for (const token of tokens) {
      if (/^[XY]/i.test(token)) {
        const axis = token[0].toUpperCase();
        const value = parseFloat(token.slice(1));
        if (Number.isNaN(value)) continue;
        if (axis === 'X') x = value;
        if (axis === 'Y') y = value;
      }
    }
    if (x !== null) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    if (y !== null) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if ([minX, maxX, minY, maxY].some((v) => !isFinite(v))) {
    return null;
  }
  const width = parseFloat((maxX - minX).toFixed(2));
  const height = parseFloat((maxY - minY).toFixed(2));
  return width > 0 && height > 0
    ? { widthMm: width, heightMm: height, widthIn: parseFloat((width / 25.4).toFixed(2)), heightIn: parseFloat((height / 25.4).toFixed(2)) }
    : null;
};

const createQuote = (dimensions) => {
  if (!dimensions || dimensions.widthMm <= 0 || dimensions.heightMm <= 0) return null;
  const areaMm2 = parseFloat((dimensions.widthMm * dimensions.heightMm).toFixed(2));
  const price = parseFloat((areaMm2 * PRICE_PER_MM2).toFixed(2));
  return {
    areaMm2,
    price,
    ratePerMm2: PRICE_PER_MM2
  };
};

const createManualGcodeRecord = (file, dimensions = null) => {
  const record = {
    id: nextUploadId++,
    filename: file.originalname,
    savedAs: file.filename,
    size: file.size,
    extension: path.extname(file.originalname).toLowerCase(),
    uploadedAt: new Date().toISOString(),
    stage: 'Listo para confirmación',
    detail: 'G-code cargado manualmente y listo para enviar.',
    config: {},
    readyToSend: true,
    gcodeName: file.filename,
    gcodePath: path.join(GCODE_DIR, file.filename),
    dimensions
  };
  uploads.unshift(record);
  if (uploads.length > 12) uploads.pop();
  pushStage('Pendiente de confirmación', record.detail);
  return record;
};

const confirmAndSend = async (id) => {
  const entryId = Number(id);
  const entry = uploads.find((item) => item.id === entryId);
  if (!entry) {
    throw new Error('No se encontró el upload solicitado.');
  }
  if (!entry.readyToSend) {
    throw new Error('El archivo no está listo para ser enviado o ya fue enviado.');
  }

  entry.readyToSend = false;
  entry.stage = 'Enviando a CNC';
  entry.detail = `Transferencia ${entry.gcodeName}`;
  pushStage('Enviando a CNC', entry.detail);

  await sendGcodeToCnc(entry);

  entry.stage = 'Completado';
  entry.detail = `Envió correcto a ${SERIAL_PORT}`;
  pushStage('Proceso finalizado', entry.detail);
  return entry;
};

const listSerialPorts = async () => {
  const devDir = '/dev';
  const entries = await fs.promises.readdir(devDir);
  const matches = entries.filter((name) => SERIAL_PREFIXES.some((prefix) => name.startsWith(prefix)));
  const ports = await Promise.all(
    matches.map(async (name) => {
      const portPath = path.join(devDir, name);
      try {
        await fs.promises.access(portPath, fs.constants.R_OK | fs.constants.W_OK);
        return { path: portPath, status: 'disponible' };
      } catch (_err) {
        return { path: portPath, status: 'sin permisos' };
      }
    })
  );
  return ports;
};

module.exports = {
  upload,
  systemState,
  uploads,
  createUploadRecord,
  processUpload,
  confirmAndSend,
  getGcodePath,
  listGcodeFiles,
  readGcodeFile,
  pushStage,
  gcodeUpload,
  createManualGcodeRecord,
  appendReturningSequence,
  listSerialPorts,
  SERIAL_PORT,
  SERIAL_BAUD,
  sendViewerGcode,
  resetCncDevice,
  previewUpload,
  generateGerberPreview
};
