const express = require('express');
const cors = require('cors');
const path = require('path');

const uploadsRouter = require('./routes/uploadsRoutes');
const app = express();
const PORT = process.env.PORT || 3000;
const frontendPath = path.join(__dirname, '..', 'frontend');

app.use(cors());
app.use(express.json());

app.use(express.static(frontendPath));

app.use('/api', uploadsRouter);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('Error del servidor:', err.message);
  if (err.name === 'MulterError') {
    return res.status(400).json({ error: `Carga fallida: ${err.message}` });
  }
  res.status(400).json({ error: err.message || 'Ocurrió un error inesperado.' });
});

app.listen(PORT, () => {
  console.log(`API CNC escuchando en http://localhost:${PORT}`);
});
