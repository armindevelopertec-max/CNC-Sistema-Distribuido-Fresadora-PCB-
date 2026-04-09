#!/usr/bin/env python3
"""Envía G-code por serie y publica estados + telemetría JSON."""

import argparse
import contextlib
import json
import re
import sys
import time
from pathlib import Path

try:
    import serial
except ImportError:  # pragma: no cover
    serial = None

# --- CONFIGURACIÓN ---
PEN_UP = "M300 S50"
PEN_DOWN = "M300 S30"
INCH_TO_MM = 25.4


def report_runtime(payload):
    print(json.dumps(payload))
    sys.stdout.flush()


def convert_line(raw_line, current_units):
    linea = re.sub(r"\(.*?\)", "", raw_line).strip()
    if not linea or any(linea.startswith(token) for token in ['M3', 'M5', 'M6', 'M0', 'T', 'S']):
        if not linea.startswith('M300'):
            return None

    if 'Z' in linea:
        z_match = re.search(r"Z([-+]?\d*\.\d+|\d+)", linea)
        if z_match:
            return f"{PEN_DOWN if float(z_match.group(1)) <= 0 else PEN_UP}\nG4 P150"

    def replace_unit(match):
        factor = INCH_TO_MM if current_units == 'in' else 1
        val = float(match.group(2)) * factor
        return f"{match.group(1)}{val:.4f}"

    linea_mm = re.sub(r"([XY])([-+]?\d*\.\d+|\d+)", replace_unit, linea)

    if "G20" in linea_mm.upper():
        return "G21"

    return linea_mm


def parse_axes(line, current):
    line_upper = line.strip().upper()
    result = current.copy()
    for axis in ['X', 'Y', 'Z']:
        match = re.search(rf"{axis}([-+]?\d*\.\d+|\d+)", line_upper)
        if match:
            result[axis] = float(match.group(1))
    return result


def update_servo_state(line, servo_state):
    servo_match = re.search(r'M300\s+S([-+]?\d*\.\d+|\d+)', line)
    if servo_match:
        angle = float(servo_match.group(1))
        return 'down' if angle <= 40 else 'up'
    return servo_state


def create_parser():
    parser = argparse.ArgumentParser(description='Envía un archivo G-code y reporta telemetría.')
    parser.add_argument('--port', '-p', required=True, help='Puerto serial (ej: /dev/ttyACM0).')
    parser.add_argument('--file', '-f', type=Path, required=True, help='Ruta al archivo G-code.')
    parser.add_argument('--baud', '-b', type=int, default=9600, help='Baud rate del puerto serial.')
    parser.add_argument('--delay', '-d', type=float, default=0.02, help='Retraso entre líneas.')
    parser.add_argument('--noop', action='store_true', help='Simula el envío sin tocar el puerto serial.')
    return parser


def emit_progress(processed, total, file_name, is_noop):
    progress_total = total or 1
    pct = min(100, round((processed / progress_total) * 100))
    suffix = ' (modo simulación)' if is_noop else ''
    report_runtime({
        'event': 'status',
        'state': 'progress',
        'file': file_name,
        'progress': pct,
        'message': f'Enviadas {processed}/{total} líneas{suffix}'
    })


def transmit(commands, ser, args):
    file_name = args.file.name
    current_units = 'mm'
    current_pos = {'X': 0.0, 'Y': 0.0, 'Z': 0.0}
    original_pos = current_pos.copy()
    servo_state = 'up'
    processed = 0
    total = len(commands)

    for raw_line in commands:
        stripped = raw_line.strip()
        if not stripped:
            continue

        processed += 1
        upper = stripped.upper()
        if upper.startswith('G20'):
            current_units = 'in'
        elif upper.startswith('G21'):
            current_units = 'mm'

        cmd = convert_line(raw_line, current_units)
        if cmd:
            original_pos = parse_axes(raw_line, original_pos)

            for sub_cmd in cmd.split('\n'):
                sub_cmd_clean = sub_cmd.strip()
                if not sub_cmd_clean:
                    continue

                if ser:
                    ser.write(f"{sub_cmd_clean}\n".encode('ascii'))
                    while True:
                        resp = ser.readline().decode(errors='ignore').strip()
                        if not resp:
                            continue
                        if 'ok' in resp.lower():
                            break
                        if 'error' in resp.lower():
                            print(f"!! Error: {resp}")
                            break
                        time.sleep(0.005)
                else:
                    time.sleep(args.delay)

                if ser:
                    time.sleep(args.delay)

                servo_state = update_servo_state(sub_cmd_clean, servo_state)
                if sub_cmd_clean.upper().startswith('G'):
                    current_pos = parse_axes(sub_cmd_clean, current_pos)

                report_runtime({
                    'event': 'telemetry',
                    'x': original_pos['X'],
                    'y': original_pos['Y'],
                    'z': original_pos['Z'],
                    'servo': servo_state,
                    'command': raw_line.strip(),
                    'servoCommand': sub_cmd_clean,
                    'file': file_name
                })

        emit_progress(processed, total, file_name, args.noop)


def main():
    parser = create_parser()
    args = parser.parse_args()

    try:
        if not args.noop and serial is None:  # pragma: no cover
            raise RuntimeError('pyserial no está instalado. Ejecuta pip install pyserial.')

        if not args.file.is_file():
            raise FileNotFoundError(f'No se encontró el archivo {args.file}')

        raw_lines = args.file.read_text(errors='ignore').splitlines()
        commands = [line for line in raw_lines if line.strip()]

        if not commands:
            report_runtime({
                'event': 'status',
                'state': 'completed',
                'file': args.file.name,
                'progress': 100,
                'message': 'El archivo no contiene comandos G-code.'
            })
            return

        report_runtime({
            'event': 'status',
            'state': 'started',
            'file': args.file.name,
            'message': 'Preparando el envío'
        })

        context = contextlib.nullcontext(None)
        if not args.noop:
            context = serial.Serial(args.port, args.baud, timeout=1)

        with context as ser:
            if ser:
                time.sleep(2)
                ser.reset_input_buffer()
            transmit(commands, ser, args)

        report_runtime({
            'event': 'status',
            'state': 'completed',
            'file': args.file.name,
            'progress': 100,
            'message': 'Envío completado' + (' (modo simulación)' if args.noop else '')
        })
    except Exception as err:
        report_runtime({
            'event': 'status',
            'state': 'failed',
            'file': args.file.name if hasattr(args, 'file') else None,
            'message': str(err)
        })
        print(err, file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
