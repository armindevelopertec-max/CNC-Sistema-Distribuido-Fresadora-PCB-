# CNC Fresadora PCB — estación local

Este proyecto reúne el **frontend** ligero (HTML/CSS/JS) y el **backend** Node.js que gestionan desde un único servidor los Gerber, el proceso de generación de G-code y la conexión con una fresadora CNC controlada por GRBL. El backend sirve al panel en `http://localhost:3000` y expone APIs REST/SSE para la UI y scripts auxiliares.

## Estructura principal

```
CNC-FresadoraPCB/
├── backend/              # Express, cálculo con pcb2gcode y envío serial (usa send.py)
│   ├── controllers/      # Enrutadores específicos (uploads, auth, etc.)
│   ├── services/         # Lógica del pipeline, port serial y runtime SSE
│   ├── send.py           # Script que transmite el G-code y publica eventos JSON
│   ├── uploads/          # Guarda Gerbers, G-code y vistas previas
│   └── index.js          # Punto de entrada Express
├── frontend/             # UI estática: panel, login, register, visor 3D
│   ├── panel.html        # Panel principal con carga, visualización y visor G-code
│   ├── script.js         # Lógica del UI, SSE, configuración y modal de parámetros
│   ├── viewer.js         # Renderiza G-code en 3D con Three.js
│   └── styles.css        # Diseño oscuro del panel y modal
└── README.md             # Esta guía
```

## Características destacadas

- **Pipeline completo**: al subir un Gerber el backend ejecuta `pcb2gcode`, guarda el `.ngc`, genera cotización y deja el archivo *pendiente de confirmación* hasta que el usuario aprueba su envío.
- **Modo de visualización**: el panel muestra los últimos archivos, la información del G-code y un visor 3D (usando Three.js) con control de simulación/tiempo real y métricas de runtime.
- **Telemetría en vivo**: `backend/send.py` envía estados (`started`, `progress`, `completed`, `failed`) y eventos `telemetry` que el frontend consume mediante `/api/runtime/stream` para reflejar la posición X/Y/Z y el estado del servo en el visor.
- **Configuración centralizada**: la configuración de PCB vive en un modal (abierto desde el icono de tuerca). El panel se sincroniza automáticamente con las dimensiones medidas por `pcb2gcode`.

## Requisitos

- Node.js 20+ y npm (para el backend).
- `pcb2gcode` instalado y disponible en `PATH` (la variable `PCB2GCODE_BIN` puede apuntar a otro ejecutable).
- Python 3 con `pyserial` (si se usa el modo real, no `--noop`).
- Acceso al puerto serial (por defecto `/dev/ttyACM0`, ajustable con `CNC_SERIAL_PORT`).

## Instalación y ejecución

```bash
cd backend
npm install
```

Configura variables opcionales (usar antes de `npm start`):

```bash
export PORT=3000
export HOST=0.0.0.0        # si querés exponer a otros equipos
export PCB2GCODE_BIN=pcb2gcode
export CNC_SERIAL_PORT=/dev/ttyACM0
export CNC_SERIAL_BAUD=9600
export PRICE_PER_MM2=0.015
```

Luego arranca el servidor:

```bash
npm start
```

Accedé al panel en `http://localhost:3000/panel.html`.

### Alternativa: correr el envío manual

Desde `backend/` se puede invocar directamente el script que usa el servidor:

```bash
cd backend
python3 send.py --port /dev/ttyACM0 --file uploads/gcode_output/<archivo>.ngc
```

Usá la opción `--noop` para simular sin tocar el puerto serial. El script reporta la misma telemetría que el panel consume vía SSE.

## API principales

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `POST` | `/api/upload` | Sube un Gerber y dispara el pipeline automático. |
| `GET` | `/api/uploads` | Lista los últimos uploads con etapas y estados. |
| `GET` | `/api/viewer/files` | Lista `.ngc` disponibles para el visor. |
| `GET` | `/api/viewer/gcode?name=...` | Devuelve el contenido de un G-code. |
| `POST` | `/api/viewer/send` | Confirma el envío de un G-code al CNC (ejecuta `send.py`). |
| `GET` | `/api/runtime/stream` | Stream SSE con `status` y `telemetry` para el visor. |
| `GET` | `/api/ports` | Lista puertos seriales disponibles y muestra el configurado. |
| `POST` | `/api/uploads/:id/confirm` | Alternativa al `/viewer/send`, confirma y exporta el upload. |
| `POST` | `/api/cnc/reset` | Envía el comando `RESET` al firmware. |

## Flujo de trabajo en el panel

1. Subí un Gerber desde la tarjeta “Panel de carga”. Los parámetros opcionales se configuran desde el modal del ícono de tuerca.
2. El backend genera el `.ngc`, añade una secuencia de retorno al origen y actualiza el historial.
3. El panel muestra la lista de archivos y la información del último upload en el panel de visualización; el tooltip de resumen se actualiza automáticamente.
4. Abrí el visor G-code para revisar el trayecto, habilitá el modo real para seguir la ejecución o confirma el envío cuando estés listo.
5. La telemetría en vivo se transmite vía `/api/runtime/stream` y alimenta el visor cerrado (visualización en tiempo real). Los estados `started`, `progress`, `completed` y `failed` informan en la interfaz.

## Desarrollo y mantenimiento

- Cada upload se guarda en `backend/uploads/gerber_files`, el resultado de `pcb2gcode` en `backend/uploads/gcode_output` y las vistas previas PNG en `backend/uploads/previews`.
- El servicio SSE se gestiona con `services/runtimeState.js` (emisor interno y subscribers que se limpian al cerrar conexión).
- Los parámetros de configuración se centralizan en `frontend/script.js` y se reescriben desde el formulario modal o las dimensiones detectadas; se reflejan en el resumen (`configSummary`).
- El visor 3D (Three.js) vive en `frontend/viewer.js` y se integra en el panel mediante el elemento `<canvas>`.

## Sugiero mantener

- Permitir `pcb2gcode` dentro de un contenedor para reproducir la conversión sin depender del sistema host.
- Registrar los uploads confirmados en una base (archivos JSON o SQLite) si necesitás auditoría después del envío.
- Añadir tests de integración (mock SSE, pipeline) si se escala hacia producción.

## Pruebas

No hay suites automatizadas en este momento; la validación se realiza con:
- Subida de Gerber real y seguimiento del log en `backend/`.
- Consumo del SSE en `panel.html` para confirmar que el visor recibe `telemetry`.
- Prueba de `python3 send.py --noop` y la misma llamada sin `--noop` cuando el CNC está conectado.

Si necesitás ayuda para transformar esto en un servicio systemd o en un contenedor Docker, avisame.
