const fs = require('fs');
const path = require('path');
const {
  upload,
  systemState,
  uploads,
  createUploadRecord,
  processUpload,
  getGcodePath,
  listGcodeFiles,
  readGcodeFile,
  confirmAndSend,
  listSerialPorts,
  SERIAL_PORT,
  SERIAL_BAUD,
  createManualGcodeRecord,
  appendReturningSequence,
  sendViewerGcode,
  resetCncDevice,
  generateGerberPreview
} = require('../services/uploadService');

const getStatus = (_req, res) => {
  res.json({
    state: systemState,
    recentUpload: uploads[0] || null
  });
};

const listUploads = (_req, res) => {
  res.json(uploads.slice(0, 8));
};

const uploadGerber = (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Se debe adjuntar un archivo Gerber válido.' });
  }

  const config = {
    pcbWidth: req.body.pcbWidth || 'no definido',
    pcbHeight: req.body.pcbHeight || 'no definido',
    depth: req.body.depth || 'no definido',
    feedRate: req.body.feedRate || 'no definido',
    toolDiameter: req.body.toolDiameter || 'no definido'
  };

  const newUpload = createUploadRecord(file, config);
  processUpload(newUpload);

  res.status(201).json({
    message: 'Archivo aceptado. Generamos el G-code y esperamos que confirmes el envío.',
    upload: newUpload
  });
};

const listViewerFilesEndpoint = async (_req, res, next) => {
  try {
    const files = await listGcodeFiles();
    res.json(files);
  } catch (error) {
    next(error);
  }
};

const getViewerGcode = async (req, res, next) => {
  const requested = req.query.name;
  if (!requested) {
    return res.status(400).json({ error: 'Se requiere el nombre del archivo.' });
  }

  try {
    const content = await readGcodeFile(requested);
    res.type('text/plain').send(content);
  } catch (error) {
    next(error);
  }
};

const downloadGcode = (req, res) => {
  const requested = req.query.name;
  if (!requested) {
    return res.status(400).json({ error: 'Se requiere el nombre del archivo a descargar.' });
  }

  const safeName = path.basename(requested);
  const targetPath = getGcodePath(safeName);

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'No se encontró el archivo G-code solicitado.' });
  }

  res.download(targetPath, safeName, (error) => {
    if (error) {
      console.error('Error al preparar la descarga:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'No se pudo descargar el archivo en este momento.' });
      }
    }
  });
};

const confirmSendController = async (req, res, next) => {
  try {
    const entry = await confirmAndSend(req.params.id);
    res.json({
      message: 'G-code confirmado y enviado.',
      upload: entry
    });
  } catch (error) {
    next(error);
  }
};

const importGcodeController = async (req, res, next) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Se debe adjuntar un archivo G-code válido.' });
  }

  try {
    const record = createManualGcodeRecord(file);
    await appendReturningSequence(record.gcodePath);
    res.status(201).json({ message: 'G-code cargado y listo para confirmar.', upload: record });
  } catch (error) {
    next(error);
  }
};

const listSerialPortsController = async (_req, res, next) => {
  try {
    const ports = await listSerialPorts();
    res.json({
      selectedPort: SERIAL_PORT,
      baud: SERIAL_BAUD,
      ports
    });
  } catch (error) {
    next(error);
  }
};

const sendViewerGcodeController = async (req, res, next) => {
  const { name } = req.body ?? {};
  if (!name) {
    return res.status(400).json({ error: 'El nombre del archivo G-code es obligatorio.' });
  }
  try {
    const sentName = await sendViewerGcode(name);
    res.json({ message: `G-code ${sentName} enviado correctamente.` });
  } catch (error) {
    next(error);
  }
};

const resetCncController = async (_req, res, next) => {
  try {
    await resetCncDevice();
    res.json({ message: 'Reset confirmado: el cabezal vuelve a sus coordenadas iniciales.' });
  } catch (error) {
    next(error);
  }
};

const previewGerberController = async (req, res, next) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Se debe adjuntar un archivo Gerber válido.' });
  }
  try {
    const previewBase64 = await generateGerberPreview(file.path);
    res.json({ preview: `data:image/png;base64,${previewBase64}` });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getStatus,
  listUploads,
  uploadGerber,
  downloadGcode,
  listViewerFiles: listViewerFilesEndpoint,
  getViewerGcode,
  confirmSend: confirmSendController,
  listSerialPorts: listSerialPortsController,
  importGcode: importGcodeController,
  uploadMiddleware: upload,
  sendViewerGcode: sendViewerGcodeController,
  resetCnc: resetCncController,
  previewGerber: previewGerberController
};
