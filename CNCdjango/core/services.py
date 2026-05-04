import subprocess
import os
import re
import time
import json
import serial
from django.conf import settings
from django.utils import timezone
from .models import PCBJob

PCB2GCODE_BIN = os.getenv('PCB2GCODE_BIN', 'pcb2gcode')
PRICE_PER_MM2 = 0.002  # Bs/mm²
MAX_WIDTH = 200.0      # mm
MAX_HEIGHT = 300.0     # mm

# --- Lógica de G-code ---
PEN_UP = "M300 S50"
PEN_DOWN = "M300 S30"
INCH_TO_MM = 25.4

def convert_line(raw_line, current_units):
    linea = re.sub(r"\(.*?\)", "", raw_line).strip()
    if not linea:
        return None

    # Si es un comando de configuración/herramienta sin movimiento, filtrar
    if any(linea.startswith(token) for token in ['M3', 'M5', 'M6', 'M0', 'T', 'S']):
        if not linea.startswith('M300'):
            return None

    # Función para convertir unidades (pulgadas a mm)
    def replace_unit(match):
        factor = INCH_TO_MM if current_units == 'in' else 1
        val = float(match.group(2)) * factor
        return f"{match.group(1)}{val:.4f}"

    # Aplicar conversión a X, Y y Z
    linea = re.sub(r"([XYZ])([-+]?\d*\.\d+|\d+)", replace_unit, linea)

    # Manejo especial para Z (Modo Servo M300)
    if 'Z' in linea:
        z_match = re.search(r"Z([-+]?\d*\.\d+|\d+)", linea)
        if z_match:
            z_val = float(z_match.group(1))
            servo_cmd = f"{PEN_DOWN if z_val <= 0 else PEN_UP}\nG4 P150"
            
            # Limpiar el Z de la línea original para mantener X e Y
            linea_clean = re.sub(r"Z[-+]?\d*\.\d+|Z\d+", "", linea).strip()
            # Si queda movimiento en X o Y, retornar ambos
            if any(axis in linea_clean.upper() for axis in 'XY'):
                return f"{linea_clean}\n{servo_cmd}"
            return servo_cmd

    if "G20" in linea.upper():
        return "G21"
    
    return linea

def parse_axes(line, current):
    line_upper = line.strip().upper()
    result = current.copy()
    for axis in ['X', 'Y', 'Z']:
        match = re.search(rf"{axis}([-+]?\d*\.\d+|\d+)", line_upper)
        if match:
            result[axis] = float(match.group(1))
    return result

# --- Procesamiento Gerber ---
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

        # Cleanup temp file immediately
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
            # Si es Gerber, lo tratamos como una capa de fresado (front)
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

    combined_gcode_content = []
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
                with open(layer['path'], 'r') as f:
                    lines = f.readlines()

                processed_lines = []
                current_units = 'mm'
                for line in lines:
                    upper = line.upper()
                    if 'G20' in upper: current_units = 'in'
                    elif 'G21' in upper: current_units = 'mm'
                    converted = convert_line(line, current_units)
                    if converted: processed_lines.append(converted + "\n")

                with open(layer['path'], 'w') as f:
                    f.writelines(processed_lines)

                getattr(job, layer['field']).name = f"gcode_output/{layer['name']}"
                combined_gcode_content.extend(processed_lines)
                print(f"✅ Capa procesada: {layer['type']}")

        # Extraer dimensiones del primer stdout capturado
        dims = extract_dimensions(first_stdout)
        if dims:
            job.width_mm = dims['width']
            job.height_mm = dims['height']
            job.area_mm2 = round(job.width_mm * job.height_mm, 2)
            job.price_bs = round(job.area_mm2 * PRICE_PER_MM2, 2)

        if combined_gcode_content:
            final_filename = f"combined_{job.id}.ngc"
            final_path = os.path.join(output_dir, final_filename)
            with open(final_path, 'w') as f:
                f.writelines(combined_gcode_content)

            job.gcode_file.name = f"gcode_output/{final_filename}"
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

# --- Transmisión Serial ---
def cnc_stream_generator(job_id, port='/dev/ttyACM0', baud=9600):
    job = PCBJob.objects.get(id=job_id)
    if not job.gcode_file:
        yield f"data: {json.dumps({'event': 'error', 'message': 'No hay G-code'})}\n\n"
        return

    job.status = 'SENDING'
    job.save()

    try:
        with open(job.gcode_file.path, 'r') as f:
            commands = [line.strip() for line in f if line.strip()]

        ser = serial.Serial(port, baud, timeout=1)
        time.sleep(2) # Esperar a Arduino
        ser.reset_input_buffer()

        current_units = 'mm'
        current_pos = {'X': 0.0, 'Y': 0.0, 'Z': 0.0}
        total = len(commands)

        for i, raw_line in enumerate(commands):
            upper = raw_line.upper()
            if 'G20' in upper: current_units = 'in'
            elif 'G21' in upper: current_units = 'mm'

            cmd = convert_line(raw_line, current_units)
            if cmd:
                for sub_cmd in cmd.split('\n'):
                    sub_cmd = sub_cmd.strip()
                    if not sub_cmd: continue
                    
                    ser.write(f"{sub_cmd}\n".encode('ascii'))
                    while True:
                        resp = ser.readline().decode(errors='ignore').strip()
                        if 'ok' in resp.lower(): break
                        time.sleep(0.005)

                current_pos = parse_axes(raw_line, current_pos)
                telemetry = {
                    'event': 'telemetry',
                    'x': current_pos['X'],
                    'y': current_pos['Y'],
                    'z': current_pos['Z'],
                    'progress': round((i / total) * 100),
                    'command': raw_line
                }
                yield f"data: {json.dumps(telemetry)}\n\n"

        ser.close()
        job.status = 'COMPLETED'
        job.completed_at = timezone.now()
        job.save()
        yield f"data: {json.dumps({'event': 'status', 'state': 'completed'})}\n\n"

    except Exception as e:
        job.status = 'FAILED'
        job.save()
        yield f"data: {json.dumps({'event': 'error', 'message': str(e)})}\n\n"
