from django.http import JsonResponse, StreamingHttpResponse, HttpResponse
from django.views.decorators.csrf import csrf_exempt
from .nesting import NestingService
from .models import Sheet, PCBJob
from .services import process_gerber_to_gcode, cnc_stream_generator, extract_pcb_dimensions

@csrf_exempt
def measure_pcb(request, job_id):
    """Calcula las dimensiones del PCB antes de colocarlo."""
    if request.method == 'POST':
        success, result = extract_pcb_dimensions(job_id)
        if success:
            return JsonResponse({'status': 'ok', 'dimensions': result})
        return JsonResponse({'error': result}, status=400)
    return JsonResponse({'error': 'Método no permitido'}, status=405)

@csrf_exempt
def nest_pcb(request, job_id):
    """Ejecuta el algoritmo de nesting para un job."""
    if request.method == 'POST':
        try:
            data = json.loads(request.body or '{}')
            sheet_id = data.get('sheet_id')
            margin = float(data.get('margin', 2.0))
            
            success, message = NestingService.place_pcb(job_id, sheet_id=sheet_id, margin=margin)
            if success:
                return JsonResponse({'status': 'ok', 'message': message})
            return JsonResponse({'error': message}, status=400)
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=500)
    return JsonResponse({'error': 'Método no permitido'}, status=405)

def sheet_visual_preview(request, sheet_id=None):
    """Genera un SVG dinámico de la lámina."""
    if not sheet_id or sheet_id == 'undefined':
        sheet = Sheet.objects.filter(is_active=True).first()
    else:
        try:
            sheet = Sheet.objects.filter(id=sheet_id).first()
        except Exception:
            sheet = Sheet.objects.filter(is_active=True).first()
        
    if not sheet:
        return HttpResponse('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="100%" height="100%" fill="#1e293b" /><text x="10" y="20" fill="white">No hay lámina activa</text></svg>', content_type="image/svg+xml")

    width = sheet.width
    height = sheet.height
    
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="100%" height="auto">',
        f'<rect width="{width}" height="{height}" fill="#1e293b" />' # Fondo oscuro
    ]
    
    for area in sheet.free_areas:
        svg.append(f'<rect x="{area["x"]}" y="{area["y"]}" width="{area["w"]}" height="{area["h"]}" fill="#064e3b" stroke="#10b981" stroke-width="0.5" />')
        
    for area in sheet.used_areas:
        svg.append(f'<rect x="{area["x"]}" y="{area["y"]}" width="{area["w"]}" height="{area["h"]}" fill="#78350f" stroke="#fbbf24" stroke-width="0.5" />')
        job_id = area.get('job_id')
        if job_id:
            svg.append(f'<text x="{area["x"]+2}" y="{area["y"]+10}" font-family="sans-serif" font-size="8" fill="#fbbf24">PCB #{str(job_id)[:4]}</text>')

    svg.append('</svg>')
    
    return HttpResponse("".join(svg), content_type="image/svg+xml")
from django.shortcuts import render
from django.conf import settings
from django.db.models import Q
from django.utils import timezone
import json
import time
import os
import base64
import subprocess


def infer_layer_type(filename):
    name = (filename or '').lower()

    if (
        name.endswith('.gb1')
        or name.endswith('.gtl')
        or 'gb1' in name
        or any(token in name for token in ('f_cu', 'b_cu', 'front', 'back', 'top', 'bottom', 'copper', 'trace', 'traces', 'signal', 'gtl', 'gbl', 'cmp', 'sol', 'bot', 'layer1', 'layer2'))
    ):
        return 'traces'

    if (
        name.endswith('.gb0')
        or name.endswith('.gko')
        or 'gb0' in name
        or any(token in name for token in ('edge_cuts', 'outline', 'contour', 'cut', 'edge', 'gko', 'gml', 'gm1', 'oln'))
    ):
        return 'outline'

    if (
        name.endswith('.gb2')
        or name.endswith('.drl')
        or 'gb2' in name
        or any(token in name for token in ('pads', 'drill', 'via', 'holes', 'pth', 'drl', 'drd'))
    ):
        return 'pads'

    return None

def get_client_scope(request, payload=None):
    client_id = ''
    if isinstance(payload, dict):
        client_id = payload.get('client_id') or payload.get('clientId') or ''

    if not client_id:
        client_id = (
            request.GET.get('client_id')
            or request.POST.get('client_id')
            or request.headers.get('X-Client-Id')
            or ''
        )

    return client_id.strip()

def visible_jobs(request, queryset=None, payload=None):
    qs = queryset if queryset is not None else PCBJob.objects.all()
    client_id = get_client_scope(request, payload)
    if client_id:
        return qs.filter(client_id=client_id), client_id
    return qs.filter(published_to_operator=True), client_id

def home(request):
    return render(request, 'core/index.html')

def panel(request):
    return render(request, 'core/panel.html')

def documentation(request):
    return render(request, 'core/docs.html')

@csrf_exempt
def upload_gerber(request):
    if request.method == 'POST':
        uploaded_files = []
        for key in ('gb1', 'gb0', 'gb2', 'gerber_files'):
            uploaded_files.extend(request.FILES.getlist(key))

        if not uploaded_files:
            for _, files in request.FILES.lists():
                uploaded_files.extend(files)

        def pick_layer(layer_type):
            for file in uploaded_files:
                if infer_layer_type(file.name) == layer_type:
                    return file
            return None

        traces = request.FILES.get('gb1') or pick_layer('traces')
        outline = request.FILES.get('gb0') or pick_layer('outline')
        pads = request.FILES.get('gb2') or pick_layer('pads')
        alias = request.POST.get('alias', 'Anónimo')
        client_id = get_client_scope(request)
        client_label = (request.POST.get('client_label') or '').strip()
        workflow_mode = (request.POST.get('workflow_mode') or '').strip().lower()
        published_to_operator = workflow_mode not in ('printshop', 'education')
        if client_id and not client_label:
            client_label = f"Estación {client_id[:8]}"
        
        if not traces:
            received = [f.name for f in uploaded_files]
            return JsonResponse({
                'error': 'Se requiere al menos un archivo de pistas (.gb1 o equivalente)',
                'received_files': received,
            }, status=400)
        
        config_raw = request.POST.get('config')
        try:
            config = json.loads(config_raw) if config_raw else {}
        except:
            config = {}
        
        job = PCBJob.objects.create(
            original_name=traces.name,
            alias=alias,
            client_id=client_id,
            client_label=client_label,
            traces_file=traces,
            outline_file=outline,
            pads_file=pads,
            status='RECEIVED',
            verification_key=PCBJob._meta.get_field('verification_key').default(),
            published_to_operator=published_to_operator,
            config=config
        )
        
        return JsonResponse({
            'id': job.id,
            'status': job.status,
            'filename': job.original_name,
            'alias': job.alias,
            'clientId': job.client_id or None,
            'clientLabel': job.client_label or None,
            'verificationKey': job.verification_key,
            'publishedToOperator': job.published_to_operator,
            'message': f"Diseño de '{alias}' recibido correctamente."
        })

    return JsonResponse({'error': 'Método no permitido.'}, status=405)

@csrf_exempt
def process_job(request, job_id):
    """Acción manual del operador para procesar un trabajo de la cola"""
    if request.method == 'POST':
        try:
            client_id = get_client_scope(request)
            job_queryset = PCBJob.objects.all() if client_id else PCBJob.objects.filter(published_to_operator=True)
            if client_id:
                job_queryset = job_queryset.filter(client_id=client_id)
            job = job_queryset.filter(id=job_id).first()
            if not job:
                message = 'Trabajo no encontrado para esta estación.' if client_id else 'Trabajo no encontrado.'
                return JsonResponse({'error': message}, status=404)

            success, message = process_gerber_to_gcode(job_id)
            job.refresh_from_db()
            if success:
                layers = []
                if job.traces_gcode: layers.append({'type': 'traces', 'name': os.path.basename(job.traces_gcode.name)})
                if job.outline_gcode: layers.append({'type': 'outline', 'name': os.path.basename(job.outline_gcode.name)})
                if job.pads_gcode: layers.append({'type': 'pads', 'name': os.path.basename(job.pads_gcode.name)})
                return JsonResponse({
                    'id': job.id,
                    'status': 'READY',
                    'layers': layers,
                    'combined_gcode': os.path.basename(job.gcode_file.name) if job.gcode_file else None,
                    'width_mm': job.width_mm,
                    'height_mm': job.height_mm,
                    'area_mm2': job.area_mm2,
                    'price_bs': job.price_bs,
                    'verificationKey': job.verification_key,
                    'publishedToOperator': job.published_to_operator,
                    'completedAt': job.completed_at.isoformat() if job.completed_at else None,
                    'clientId': job.client_id or None,
                    'clientLabel': job.client_label or None,
                    'message': message
                })
            else:
                return JsonResponse({'error': message}, status=400)
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=500)
    return JsonResponse({'error': 'Método no permitido'}, status=405)

@csrf_exempt
def reprocess_layer(request):
    """Reprocesa una capa específica o todo el proyecto con nueva configuración"""
    if request.method == 'POST':
        try:
            data = json.loads(request.body or '{}')
            job_id = data.get('jobId') or data.get('job_id') or request.GET.get('job_id')
            layer_type = data.get('layerType')
            new_config = data.get('config')
            client_id = get_client_scope(request, data)

            if client_id:
                job = PCBJob.objects.filter(id=job_id, client_id=client_id).first()
            else:
                job = PCBJob.objects.filter(id=job_id, published_to_operator=True).first()

            if not job:
                if not client_id and settings.DEBUG:
                     job = PCBJob.objects.filter(id=job_id).first()
                
                if not job:
                    message = f"Trabajo {job_id} no encontrado para la estación '{client_id}'." if client_id else f"Trabajo {job_id} no encontrado o no autorizado."
                    return JsonResponse({'error': message}, status=404)

            if layer_type:
                if not isinstance(job.config, dict):
                    job.config = {}
                job.config[layer_type] = new_config
            else:
                job.config = new_config

            job.save()

            success, message = process_gerber_to_gcode(job.id)
            if success:
                job.refresh_from_db()
                layers = []
                if job.traces_gcode: layers.append({'type': 'traces', 'name': os.path.basename(job.traces_gcode.name)})
                if job.outline_gcode: layers.append({'type': 'outline', 'name': os.path.basename(job.outline_gcode.name)})
                if job.pads_gcode: layers.append({'type': 'pads', 'name': os.path.basename(job.pads_gcode.name)})
                return JsonResponse({
                    'id': job.id,
                    'layers': layers, 
                    'combined_gcode': os.path.basename(job.gcode_file.name) if job.gcode_file else None,
                    'area_mm2': job.area_mm2,
                    'price_bs': job.price_bs,
                    'verificationKey': job.verification_key,
                    'publishedToOperator': job.published_to_operator,
                    'clientId': job.client_id or None,
                    'clientLabel': job.client_label or None,
                    'message': message
                })
            else:
                return JsonResponse({'error': message}, status=400)
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=500)
    return JsonResponse({'error': 'Método no permitido'}, status=405)

def get_status(request):
    """Compatible con /api/status"""
    jobs, client_id = visible_jobs(request)
    recent = jobs.order_by('-created_at').first()
    state = {
        'currentStage': recent.get_status_display() if recent else 'Esperando archivos',
        'detail': f"Último trabajo: {recent.original_name}" if recent else 'Listo para recibir archivos.',
        'history': [],
        'clientId': client_id or None,
    }
    
    recent_upload = None
    if recent:
        size = 0
        try:
            if recent.traces_file and os.path.exists(recent.traces_file.path):
                size = recent.traces_file.size
        except Exception:
            pass

        recent_upload = {
            'clientId': recent.client_id or None,
            'clientLabel': recent.client_label or None,
            'filename': recent.original_name,
            'alias': recent.alias or 'Anónimo',
            'status': recent.status,
            'stage': recent.get_status_display(),
            'uploadedAt': recent.created_at.isoformat(),
            'completedAt': recent.completed_at.isoformat() if recent.completed_at else None,
            'size': size,
            'dimensions': {'widthMm': recent.width_mm, 'heightMm': recent.height_mm},
            'area_mm2': recent.area_mm2,
            'price_bs': recent.price_bs,
            'verificationKey': recent.verification_key,
            'publishedToOperator': recent.published_to_operator,
            'config': recent.config
        }

    return JsonResponse({
        'state': state,
        'recentUpload': recent_upload
    })

def list_uploads(request):
    """Compatible con /api/uploads"""
    jobs, _ = visible_jobs(request)
    jobs = jobs.order_by('-created_at')[:12]
    data = []
    for j in jobs:
        size = 0
        try:
            if j.traces_file and os.path.exists(j.traces_file.path):
                size = j.traces_file.size
        except Exception:
            pass
            
        data.append({
            'id': j.id,
            'alias': j.alias or 'Anónimo',
            'filename': j.original_name,
            'size': size,
            'uploadedAt': j.created_at.isoformat(),
            'completedAt': j.completed_at.isoformat() if j.completed_at else None,
            'status': j.status,
            'stage': j.get_status_display(),
            'price': j.price_bs,
            'verificationKey': j.verification_key,
            'clientId': j.client_id or None,
            'clientLabel': j.client_label or None,
            'publishedToOperator': j.published_to_operator,
        })
    return JsonResponse(data, safe=False)

def get_ports(request):
    """Compatible con /api/ports"""
    return JsonResponse({
        'selectedPort': '/dev/ttyACM0',
        'baud': 9600,
        'ports': [{'path': '/dev/ttyACM0', 'status': 'disponible'}]
    })

@csrf_exempt
def viewer_send(request):
    """Compatible con /api/viewer/send"""
    if request.method == 'POST':
        try:
            data = json.loads(request.body or '{}')
            filename = data.get('name')
            job_id = data.get('jobId')
            client_id = get_client_scope(request, data)
            
            job_queryset = PCBJob.objects.all() if client_id else PCBJob.objects.filter(published_to_operator=True)
            if client_id:
                job_queryset = job_queryset.filter(client_id=client_id)

            job = None
            if job_id:
                job = job_queryset.filter(id=job_id).first()
            if not job and filename:
                job = job_queryset.filter(gcode_file__icontains=filename).first()
            
            if not job:
                if client_id:
                    job = job_queryset.filter(status='READY').order_by('-created_at').first()
                else:
                    job = PCBJob.objects.filter(status='READY').order_by('-created_at').first()
                
            if not job:
                message = 'No hay ningún G-code listo para enviar.' if not client_id else 'No hay ningún G-code listo para enviar en esta estación.'
                return JsonResponse({'error': message}, status=400)
            
            layer_type = data.get('layerType')
            file_to_send = None
            
            if layer_type == 'traces' and job.traces_gcode:
                file_to_send = job.traces_gcode.path
            elif layer_type == 'outline' and job.outline_gcode:
                file_to_send = job.outline_gcode.path
            elif layer_type == 'pads' and job.pads_gcode:
                file_to_send = job.pads_gcode.path
            elif filename:
                for candidate in (job.traces_gcode, job.outline_gcode, job.pads_gcode, job.gcode_file):
                    if candidate and os.path.basename(candidate.name) == os.path.basename(filename):
                        file_to_send = candidate.path
                        break
            
            if not file_to_send:
                file_to_send = (job.gcode_file.path if job.gcode_file else None) or \
                               (job.traces_gcode.path if job.traces_gcode else None) or \
                               (job.outline_gcode.path if job.outline_gcode else None) or \
                               (job.pads_gcode.path if job.pads_gcode else None)

            if not file_to_send or not os.path.exists(file_to_send):
                return JsonResponse({'error': 'No se encontró el archivo G-code físico para enviar.'}, status=404)

            job.active_gcode_file = file_to_send
            job.status = 'SENDING'
            job.completed_at = None
            job.save()
            
            return JsonResponse({
                'message': f'Envío de {os.path.basename(file_to_send)} iniciado.',
                'jobId': job.id,
                'layerType': layer_type,
                'clientId': job.client_id or None,
                'verificationKey': job.verification_key,
            })
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=500)
    return JsonResponse({'error': 'Método no permitido'}, status=405)

@csrf_exempt
def publish_job(request, job_id):
    """Publica un borrador del diseñador en la cola del operador."""
    if request.method == 'POST':
        try:
            data = json.loads(request.body or '{}')
            client_id = get_client_scope(request, data)
            job_queryset = PCBJob.objects.all() if client_id else PCBJob.objects.filter(published_to_operator=True)
            if client_id:
                job_queryset = job_queryset.filter(client_id=client_id)

            job = job_queryset.filter(id=job_id).first()
            if not job:
                message = 'Trabajo no encontrado para esta estación.' if client_id else 'Trabajo no encontrado.'
                return JsonResponse({'error': message}, status=404)

            job.published_to_operator = True
            job.status = 'RECEIVED'
            job.save()

            return JsonResponse({
                'id': job.id,
                'status': job.status,
                'publishedToOperator': job.published_to_operator,
                'verificationKey': job.verification_key,
                'clientId': job.client_id or None,
                'clientLabel': job.client_label or None,
                'message': 'Trabajo enviado al operador.'
            })
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=500)
    return JsonResponse({'error': 'Método no permitido'}, status=405)

@csrf_exempt
def reset_placement(request, job_id):
    """Elimina la información de nesting para que el G-code se genere en (0,0)"""
    if request.method == 'POST':
        try:
            job = PCBJob.objects.get(id=job_id)
            job.placement_x = 0.0
            job.placement_y = 0.0
            job.sheet = None
            job.status = 'RECEIVED' 
            job.save()
            
            success, message = process_gerber_to_gcode(job.id)
            
            if success:
                return JsonResponse({'status': 'ok', 'message': 'Posición reseteada a (0,0) y G-code regenerado.'})
            else:
                return JsonResponse({'error': message}, status=400)
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=500)
    return JsonResponse({'error': 'Método no permitido'}, status=405)

def list_viewer_files(request):
    """Lista trabajos procesados con sus capas disponibles"""
    jobs, _ = visible_jobs(request, PCBJob.objects.filter(status__in=['READY', 'SENDING', 'COMPLETED']))
    jobs = jobs.order_by('-created_at')[:10]
    
    data = []
    for job in jobs:
        layers = []
        if job.traces_gcode and os.path.exists(job.traces_gcode.path): 
            layers.append({'type': 'traces', 'name': os.path.basename(job.traces_gcode.name)})
        if job.outline_gcode and os.path.exists(job.outline_gcode.path): 
            layers.append({'type': 'outline', 'name': os.path.basename(job.outline_gcode.name)})
        if job.pads_gcode and os.path.exists(job.pads_gcode.path): 
            layers.append({'type': 'pads', 'name': os.path.basename(job.pads_gcode.name)})
        
        if not layers and not (job.gcode_file and os.path.exists(job.gcode_file.path)):
            continue

        data.append({
            'id': job.id,
            'alias': job.alias or 'Anónimo',
            'name': job.original_name,
            'combined_gcode': os.path.basename(job.gcode_file.name) if job.gcode_file and os.path.exists(job.gcode_file.path) else None,
            'layers': layers,
            'clientId': job.client_id or None,
            'clientLabel': job.client_label or None,
            'verificationKey': job.verification_key,
            'publishedToOperator': job.published_to_operator,
            'modifiedAt': job.created_at.strftime("%Y-%m-%d %H:%M")
        })
    return JsonResponse(data, safe=False)

def get_viewer_gcode(request):
    """Devuelve el contenido de un archivo G-code"""
    client_id = get_client_scope(request)
    job_id = request.GET.get('job_id')
    layer = request.GET.get('layer')
    name = request.GET.get('name')
    queryset = PCBJob.objects.all() if client_id else PCBJob.objects.filter(published_to_operator=True)
    if client_id:
        queryset = queryset.filter(client_id=client_id)

    job = None
    if job_id:
        job = queryset.filter(id=job_id).first()
    
    if not job and name:
        name_clean = os.path.basename(name)
        job = queryset.filter(
            Q(gcode_file__icontains=name_clean) |
            Q(traces_gcode__icontains=name_clean) |
            Q(outline_gcode__icontains=name_clean) |
            Q(pads_gcode__icontains=name_clean)
        ).first()

    if not job:
        return HttpResponse(f'Trabajo {job_id or name or ""} no encontrado', status=404)

    file_map = {
        'traces': job.traces_gcode,
        'outline': job.outline_gcode,
        'pads': job.pads_gcode,
        'combined': job.gcode_file,
    }

    file_obj = None
    if layer:
        file_obj = file_map.get(layer)
    elif name:
        requested_name = os.path.basename(name)
        for candidate in (job.gcode_file, job.traces_gcode, job.outline_gcode, job.pads_gcode):
            if candidate and os.path.basename(candidate.name) == requested_name:
                file_obj = candidate
                break

    if not file_obj:
        file_obj = job.gcode_file or job.traces_gcode or job.outline_gcode or job.pads_gcode

    if not file_obj or not file_obj.name:
        return HttpResponse('El trabajo no tiene archivos G-code asociados', status=404)
    
    possible_paths = [
        file_obj.path,
        os.path.join(settings.MEDIA_ROOT, file_obj.name),
        os.path.join(settings.MEDIA_ROOT, 'gcode_output', os.path.basename(file_obj.name))
    ]
    
    final_path = None
    for p in possible_paths:
        if os.path.exists(p):
            final_path = p
            break
            
    if not final_path:
        return HttpResponse(f'Archivo físico no encontrado en el servidor: {os.path.basename(file_obj.name)}', status=404)
    
    try:
        with open(final_path, 'r') as f:
            return HttpResponse(f.read(), content_type='text/plain')
    except Exception as e:
        return HttpResponse(f'Error al leer el archivo: {str(e)}', status=500)

def stream_cnc_runtime(request):
    """Compatible con /api/runtime/stream"""
    jobs, _ = visible_jobs(request, PCBJob.objects.filter(status__in=['SENDING', 'READY']))
    job = jobs.order_by('-created_at').first()
    if not job:
        return StreamingHttpResponse(iter([]), content_type='text/event-stream')
        
    response = StreamingHttpResponse(cnc_stream_generator(job.id), content_type='text/event-stream')
    response['Cache-Control'] = 'no-cache'
    response['X-Accel-Buffering'] = 'no'
    return response

@csrf_exempt
def reset_cnc(request):
    """Compatible con /api/cnc/reset"""
    import serial
    try:
    
        return JsonResponse({'status': 'ok', 'message': 'CNC reseteada (simulado)'})
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)

@csrf_exempt
def gerber_preview(request):
    """Genera vista previa usando gerbv si está disponible"""
    if request.method == 'POST':
        file = request.FILES.get('gerber')
        if not file:
            return JsonResponse({'error': 'No file'}, status=400)
            
        temp_dir = os.path.join(settings.MEDIA_ROOT, 'temp')
        os.makedirs(temp_dir, exist_ok=True)
        temp_path = os.path.join(temp_dir, file.name)
        
        with open(temp_path, 'wb+') as destination:
            for chunk in file.chunks():
                destination.write(chunk)
        
        output_img = temp_path + ".png"
        try:
            subprocess.run([
                'gerbv', '-x', 'png', '-o', output_img, 
                '--background=#030711', '--foreground=#a5b4fc',
                temp_path
            ], check=True, capture_output=True)
            
            with open(output_img, "rb") as image_file:
                encoded_string = base64.b64encode(image_file.read()).decode('utf-8')
                
            os.remove(temp_path)
            os.remove(output_img)
            return JsonResponse({'preview': f"data:image/png;base64,{encoded_string}"})
        except Exception:
            if os.path.exists(temp_path): os.remove(temp_path)
            return JsonResponse({'preview': None})
            
    return JsonResponse({'error': 'Method not allowed'}, status=405)
