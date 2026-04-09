const express = require('express');
const { upload, gcodeUpload, previewUpload } = require('../services/uploadService');
const {
  getStatus,
  listUploads,
  uploadGerber,
  downloadGcode,
  listViewerFiles,
  getViewerGcode,
  confirmSend,
  listSerialPorts,
  importGcode,
  sendViewerGcode,
  resetCnc,
  previewGerber
} = require('../controllers/uploadsController');
const { attachRuntimeStream } = require('../services/runtimeState');
const router = express.Router();

router.post('/upload', upload.single('gerber'), uploadGerber);
router.post('/gerber/preview', previewUpload.single('gerber'), previewGerber);
router.get('/status', getStatus);
router.get('/uploads', listUploads);
router.get('/download', downloadGcode);
router.get('/viewer/files', listViewerFiles);
router.get('/viewer/gcode', getViewerGcode);
router.get('/ports', listSerialPorts);
router.post('/gcode/import', gcodeUpload.single('gcode'), importGcode);
router.post('/uploads/:id/confirm', confirmSend);
router.post('/viewer/send', sendViewerGcode);
router.post('/cnc/reset', resetCnc);
router.get('/runtime/stream', attachRuntimeStream);

module.exports = router;
