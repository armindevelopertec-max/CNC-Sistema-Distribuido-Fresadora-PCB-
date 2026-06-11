import subprocess
import os
import re
import time
import json
import serial
import threading
from django.conf import settings
from django.utils import timezone
from .models import PCBJob

PCB2GCODE_BIN = os.getenv('PCB2GCODE_BIN', 'pcb2gcode')
PRICE_PER_MM2 = 0.002  # Bs/mm²
MAX_WIDTH = 200.0      # mm
MAX_HEIGHT = 300.0     # mm

MOTION_MODE_Z = 'z'
MOTION_MODE_SERVO = 'servo'
SERVO_UP_COMMAND = 'M300 S50'
SERVO_DOWN_COMMAND = 'M300 S30'
SERVO_DWELL_COMMAND = 'G4 P150'
INCH_TO_MM = 25.4


def normalize_motion_mode(value):
    mode = str(value or MOTION_MODE_Z).strip().lower()
    return MOTION_MODE_SERVO if mode in {'servo', 'm300', 'plotter'} else MOTION_MODE_Z


def get_motion_mode(config):
    if not isinstance(config, dict):
        return MOTION_MODE_Z
    return normalize_motion_mode(config.get('motionMode') or config.get('motion_mode'))


def strip_comments(raw_line):
    return re.sub(r"\(.*?\)", "", raw_line).strip()


def scale_line_units(line, current_units):
    if current_units != 'in':
        return line

    def replace(match):
        axis = match.group(1).upper()
        value = float(match.group(2)) * INCH_TO_MM
        return f"{axis}{value:.5f}"

    return re.sub(r"([XYZFIJK])([-+]?\d*\.\d+|\d+)", replace, line)


def is_motion_stub(line):
    upper = line.upper().strip()
    if not upper.startswith(('G0', 'G00', 'G1', 'G01')):
        return False
    return not any(axis in upper for axis in ('X', 'Y', 'I', 'J', 'K'))


def rewrite_gcode_for_motion_mode(file_path, motion_mode):
    if normalize_motion_mode(motion_mode) != MOTION_MODE_SERVO:
        return False

    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
        lines = f.readlines()

    converted_lines = []
    current_units = 'mm'
    servo_state = None

    for raw_line in lines:
        stripped = raw_line.rstrip('\r\n')
        if not stripped.strip():
            converted_lines.append('')
            continue

        clean = strip_comments(stripped)
        if not clean:
            continue

        upper = clean.upper()

        # Preserve M3 and M5 for spindle support, but remove other common preamble/tool commands
        if re.match(r'^M0?6\b', upper) or re.match(r'^M0?0\b', upper) or re.match(r'^T\d+\b', upper):
            continue

        if 'G20' in upper:
            current_units = 'in'
            converted_lines.append('G21')
            continue

        if 'G21' in upper:
            current_units = 'mm'
            converted_lines.append('G21')
            continue

        z_match = re.search(r'Z([-+]?\d*\.\d+|\d+)', clean, re.I)
        if z_match:
            z_val = float(z_match.group(1))
            desired_state = 'down' if z_val <= 0 else 'up'
            if desired_state != servo_state:
                converted_lines.append(SERVO_DOWN_COMMAND if desired_state == 'down' else SERVO_UP_COMMAND)
                converted_lines.append(SERVO_DWELL_COMMAND)
                servo_state = desired_state

            line_without_z = re.sub(r'Z[-+]?\d*\.\d+|Z\d+', '', clean, flags=re.I).strip()
            if line_without_z:
                scaled_line = scale_line_units(line_without_z, current_units)
                if not is_motion_stub(scaled_line):
                    converted_lines.append(scaled_line)
            continue

        scaled_line = scale_line_units(clean, current_units)
        if is_motion_stub(scaled_line):
            continue
        converted_lines.append(scaled_line)

    with open(file_path, 'w', encoding='utf-8') as f:
        f.write("\n".join(converted_lines).rstrip() + "\n")
        # Move back to origin, then Spindle OFF, then Steppers OFF
        f.write("G0 X0 Y0\nM5\nM18\n")

    return True

def parse_axes(line, current):
    line_upper = line.strip().upper()
    result = current.copy()
    if 'M300' in line_upper:
        s_match = re.search(r"S([-+]?\d*\.\d+|\d+)", line_upper)
        if s_match:
            s_val = float(s_match.group(1))
            result['Z'] = -1.0 if s_val <= 35 else 5.0
    for axis in ['X', 'Y', 'Z']:
        match = re.search(rf"{axis}([-+]?\d*\.\d+|\d+)", line_upper)
        if match:
            result[axis] = float(match.group(1))
    return result

def extract_dimensions(stdout):
    regex = r"Height:\s*([\d.]+)in.*Width:\s*([\d.]+)in"
    match = re.search(regex, stdout)
    if not match:
        return None
    
    height_mm = round(float(match.group(1)) * 25.4, 2)
    width_mm = round(float(match.group(2)) * 25.4, 2)
    return {'width': width_mm, 'height': height_mm}

def extract_pcb_dimensions(job_id):
    """
    Corre pcb2gcode solo para extraer las dimensiones del Gerber.
    """
    job = PCBJob.objects.get(id=job_id)
    if not job.traces_file:
        return False, "No hay archivo de pistas para medir."

    output_dir = os.path.join(settings.MEDIA_ROOT, 'temp')
    os.makedirs(output_dir, exist_ok=True)
    
    try:
        temp_ngc = os.path.join(output_dir, f"temp_{job.id}.ngc")
        args = [
            PCB2GCODE_BIN,
            '--front', job.traces_file.path,
            '--front-output', temp_ngc,
            '--metric',
            '--zsafe', '5',
            '--zchange', '5',
            '--zwork', '-0.06',
            '--cutter-diameter', '0.1',
            '--mill-feed', '100',
            '--mill-speed', '1000'
        ]

        result = subprocess.run(args, capture_output=True, text=True, check=True)
        dims = extract_dimensions(result.stdout)

        if os.path.exists(temp_ngc):
            os.remove(temp_ngc)

        if dims:

            job.width_mm = dims['width']
            job.height_mm = dims['height']
            job.area_mm2 = round(job.width_mm * job.height_mm, 2)
            job.price_bs = round(job.area_mm2 * PRICE_PER_MM2, 2)
            job.save()
            return True, {
                'width_mm': job.width_mm,
                'height_mm': job.height_mm,
                'area_mm2': job.area_mm2,
                'price_bs': job.price_bs
            }
        return False, "No se pudieron extraer las dimensiones."
    except Exception as e:
        return False, str(e)

def is_excellon(file_path):
    """Detecta si un archivo es Excellon (drill) o Gerber."""
    try:
        with open(file_path, 'r', errors='ignore') as f:
            content = f.read(2048)
            # Excellon suele tener M48, T1, o empezar con % seguido de M48
            if 'M48' in content or 'T1' in content:
                return True
            # Gerber suele tener G04, %FS, %MO
            if 'G04' in content or '%FS' in content or '%MO' in content:
                return False
        return False
    except:
        return False

def process_gerber_to_gcode(job_id):
    job = PCBJob.objects.get(id=job_id)
    job.status = 'PROCESSING'
    job.completed_at = None
    if not isinstance(job.config, dict):
        job.config = {}
    job.save()

    output_dir = os.path.join(settings.MEDIA_ROOT, 'gcode_output')
    os.makedirs(output_dir, exist_ok=True)

    try:
        os.chmod(output_dir, 0o777)
    except Exception:
        pass

    x_offset = job.placement_x or 0.0
    y_offset = job.placement_y or 0.0

    config = job.config
    motion_mode = get_motion_mode(config)
    if config.get('motionMode') != motion_mode:
        config['motionMode'] = motion_mode
        job.config = config
        job.save(update_fields=['config'])

    t_cfg = config.get('traces', {})
    o_cfg = config.get('outline', {})
    p_cfg = config.get('pads', {})

    base_args = [PCB2GCODE_BIN, '--metric', '--zsafe', '5', '--zchange', '5']
    if x_offset or y_offset:
        base_args += ['--x-offset', str(x_offset), '--y-offset', str(y_offset)]

    layers_to_run = []

    if job.traces_file:
        out_name = f"traces_{job.id}.ngc"
        out_path = os.path.join(output_dir, out_name)
        args = [
            '--front', job.traces_file.path,
            '--front-output', out_path,
            '--mill-speed', t_cfg.get('millSpeed', '10000'),
            '--zwork', t_cfg.get('depth', '-0.06'),
            '--mill-diameters', t_cfg.get('toolDiameter', '0.1'),
            '--mill-feed', t_cfg.get('feedRate', '120'),
            '--mill-vertfeed', '40',
            '--isolation-width', t_cfg.get('isolationWidth', '0.25'),
            '--extra-passes', t_cfg.get('isolationSteps', '2'),
            '--milling-overlap', '0.5'
        ]
        layers_to_run.append({'type': 'traces', 'args': args, 'path': out_path, 'field': 'traces_gcode', 'name': out_name})

    if (job.pads_file):
        out_name = f"pads_{job.id}.ngc"
        out_path = os.path.join(output_dir, out_name)
        
        if (is_excellon(job.pads_file.path)):
            args = [
                '--drill', job.pads_file.path,
                '--drill-output', out_path,
                '--drill-speed', p_cfg.get('millSpeed', '10000'),
                '--zdrill', p_cfg.get('depth', '-0.06'),
                '--drill-feed', p_cfg.get('feedRate', '120'),
            ]
        else:
            args = [
                '--front', job.pads_file.path,
                '--front-output', out_path,
                '--mill-speed', p_cfg.get('millSpeed', '10000'),
                '--zwork', p_cfg.get('depth', '-0.06'),
                '--mill-diameters', p_cfg.get('toolDiameter', '0.1'),
                '--mill-feed', p_cfg.get('feedRate', '120'),
                '--mill-vertfeed', '40',
                '--isolation-width', p_cfg.get('isolationWidth', '0.1'),
                '--extra-passes', p_cfg.get('isolationSteps', '0'),
                '--milling-overlap', '0.5'
            ]
        layers_to_run.append({'type': 'pads', 'args': args, 'path': out_path, 'field': 'pads_gcode', 'name': out_name})

    if (job.outline_file):
        out_name = f"outline_{job.id}.ngc"
        out_path = os.path.join(output_dir, out_name)
        args = [
            '--outline', job.outline_file.path,
            '--outline-output', out_path,
            '--zcut', o_cfg.get('depth', '-1.6'), 
            '--cutter-diameter', o_cfg.get('toolDiameter', '0.8'),
            '--cut-feed', o_cfg.get('feedRate', '80'),
            '--cut-vertfeed', '30',
            '--cut-speed', o_cfg.get('millSpeed', '10000'),
            '--cut-infeed', abs(float(o_cfg.get('depth', '-1.6'))),
            '--isolation-width', o_cfg.get('isolationWidth', '0'),
            '--extra-passes', o_cfg.get('isolationSteps', '0')
        ]
        layers_to_run.append({'type': 'outline', 'args': args, 'path': out_path, 'field': 'outline_gcode', 'name': out_name})

    first_stdout = ""

    try:
        for layer in layers_to_run:
            full_args = base_args + [str(a) for a in layer['args']]
            cmd_str = ' '.join(full_args)
            print(f"🛠️ Ejecutando pcb2gcode para capa {layer['type']}: {cmd_str}")

            with open('pcb2gcode_debug.txt', 'a') as f:
                f.write(f"\n--- {timezone.now()} Layer: {layer['type']} ---\n")
                f.write(f"CMD: {cmd_str}\n")

            result = subprocess.run(full_args, capture_output=True, text=True, check=True, cwd=output_dir)
            if not first_stdout:
                first_stdout = result.stdout

            if os.path.exists(layer['path']):
                rewrite_gcode_for_motion_mode(layer['path'], motion_mode)
                getattr(job, layer['field']).name = f"gcode_output/{layer['name']}"
                print(f"✅ Capa generada: {layer['type']} ({motion_mode})")

        dims = extract_dimensions(first_stdout)
        if dims:
            job.width_mm = dims['width']
            job.height_mm = dims['height']
            job.area_mm2 = round(job.width_mm * job.height_mm, 2)
            job.price_bs = round(job.area_mm2 * PRICE_PER_MM2, 2)

        if layers_to_run:
            job.status = 'READY'
            job.save()
            return True, "Procesamiento completado con éxito."
        else:
            job.status = 'FAILED'
            job.save()
            return False, "No se generó contenido G-code."

    except subprocess.CalledProcessError as e:
        error_msg = e.stderr or str(e)
        print(f"❌ ERROR en pcb2gcode: {error_msg}")
        with open('pcb2gcode_debug.txt', 'a') as f:
            f.write(f"ERROR: {error_msg}\n")
            f.write(f"STDOUT: {e.stdout}\n")

        job.status = 'FAILED'
        job.save()
        return False, f"Error en pcb2gcode: {error_msg}"
    except Exception as e:
        print(f"❌ ERROR general: {str(e)}")
        job.status = 'FAILED'
        job.save()
        return False, str(e)

class CNCManager:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(CNCManager, cls).__new__(cls)
                cls._instance.ser = None
                cls._instance.stop_event = threading.Event()
                cls._instance.is_running = False  # Flag para evitar múltiples hilos
                cls._instance.port = '/dev/ttyACM0'
                cls._instance.baud = 9600
            return cls._instance

    def get_connection(self):
        if self.ser and self.ser.is_open:
            return self.ser
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.1)
            time.sleep(2)
            return self.ser
        except Exception as e:
            print(f"❌ Error abriendo puerto serial: {e}")
            return None

    def trigger_stop(self):
        print("🚨 [CNCManager] EMERGENCY STOP REQUESTED!")
        self.stop_event.set()

    def clear_stop(self):
        self.stop_event.clear()

cnc_manager = CNCManager()

def trigger_emergency_stop():
    cnc_manager.trigger_stop()

def get_serial_connection(port='/dev/ttyACM0', baud=9600):
    cnc_manager.port = port
    cnc_manager.baud = baud
    return cnc_manager.get_connection()

def cnc_stream_generator(job_id, port='/dev/ttyACM0', baud=9600):
    # SIEMPRE limpiar el evento de parada al inicio de un nuevo envío
    cnc_manager.clear_stop()
    
    if cnc_manager.is_running:
        print("⚠️ [STREAMER] Intento de ejecución bloqueado: Ya hay un proceso corriendo.")
        yield f"data: {json.dumps({'event': 'error', 'message': 'La CNC ya está ocupada'})}\n\n"
        return

    job = PCBJob.objects.get(id=job_id)
    gcode_path = job.active_gcode_file
    
    cnc_manager.is_running = True
    
    if not gcode_path or not os.path.exists(gcode_path):
        cnc_manager.is_running = False
        yield f"data: {json.dumps({'event': 'error', 'message': 'Archivo no encontrado'})}\n\n"
        return

    job.status = 'SENDING'
    job.save()

    try:
        with open(gcode_path, 'r') as f:
            commands = [line.rstrip('\r\n') for line in f if line.strip()]

        ser = get_serial_connection(port, baud)
        if not ser:
            cnc_manager.is_running = False
            yield f"data: {json.dumps({'event': 'error', 'message': 'No se pudo conectar con la CNC'})}\n\n"
            return

        ser.reset_input_buffer()
        current_pos = {'X': 0.0, 'Y': 0.0, 'Z': 0.0}
        total = len(commands)
        aborted = False

        print(f"🚀 [STREAMER] Iniciando Job {job_id} ({total} líneas)")

        for i, raw_line in enumerate(commands):
            # 1. Chequeo de parada ULTRARRÁPIDO
            if cnc_manager.stop_event.is_set():
                print(f"🛑 [STREAMER] STOP detectado en línea {i}. Abortando...")
                aborted = True
                break

            # 2. Enviar línea al Arduino
            ser.write(f"{raw_line}\n".encode('ascii', errors='ignore'))
            
            # 3. Esperar 'ok' con timeout para no bloquear y permitir detección de parada
            while True:
                if cnc_manager.stop_event.is_set():
                    aborted = True
                    break
                
                resp = ser.readline().decode(errors='ignore').strip()
                if 'ok' in resp.lower():
                    break
            
            if aborted: break

            # 4. Enviar progreso a la interfaz
            current_pos = parse_axes(raw_line, current_pos)
            telemetry = {
                'event': 'telemetry',
                'x': current_pos['X'],
                'y': current_pos['Y'],
                'z': current_pos['Z'],
                'progress': round(((i + 1) / total) * 100),
                'command': raw_line
            }
            yield f"data: {json.dumps(telemetry)}\n\n"

        # SECUENCIA FINAL
        if aborted:
            print("🏠 [STREAMER] Ejecutando Retorno de Seguridad...")
            ser.reset_input_buffer()
            
            # Función auxiliar para enviar y esperar ok en emergencia
            def send_wait(cmd):
                ser.write(cmd)
                start_t = time.time()
                while time.time() - start_t < 10: # Timeout de 10s por comando
                    r = ser.readline().decode(errors='ignore').strip()
                    if 'ok' in r.lower(): return True
                return False

            send_wait(b"M300 S50\n")   # Subir
            send_wait(b"G0 X0 Y0\n")   # Regresar a casa (espera a que llegue)
            ser.write(b"M5\nM18\n")    # Apagar todo

            # ENVIAR TELEMETRÍA FINAL PARA DESBLOQUEAR UI
            yield f"data: {json.dumps({'event': 'telemetry', 'x': 0.0, 'y': 0.0, 'z': 5.0, 'progress': 100, 'command': 'RETORNO A CASA COMPLETADO'})}\n\n"
            
            job.status = 'FAILED'
            yield f"data: {json.dumps({'event': 'status', 'state': 'failed', 'message': 'EMERGENCIA: CNC en casa y apagada'})}\n\n"
        else:
            job.status = 'COMPLETED'
            yield f"data: {json.dumps({'event': 'status', 'state': 'completed', 'message': 'Trabajo terminado'})}\n\n"

        job.completed_at = timezone.now()
        job.save()

    except Exception as e:
        print(f"❌ [STREAMER] Error crítico: {e}")
        job.status = 'FAILED'
        job.save()
        yield f"data: {json.dumps({'event': 'error', 'message': str(e)})}\n\n"
    finally:
        cnc_manager.is_running = False
        print("🏁 [STREAMER] Hilo de ejecución liberado.")
