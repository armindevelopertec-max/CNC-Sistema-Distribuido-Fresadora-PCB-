from django.urls import path
from .views import (
    upload_gerber, list_uploads, get_status, get_ports, 
    viewer_send, stream_cnc_runtime, reset_cnc, gerber_preview,
    list_viewer_files, get_viewer_gcode, reprocess_layer, publish_job,
    documentation, process_job, measure_pcb, nest_pcb, sheet_visual_preview
)

urlpatterns = [
    path('upload', upload_gerber),
    path('process/<int:job_id>', process_job),
    path('docs', documentation, name='api_docs'),
    path('status', get_status),
    path('uploads', list_uploads),
    path('ports', get_ports),
    path('viewer/send', viewer_send),
    path('publish/<int:job_id>', publish_job),
    path('viewer/files', list_viewer_files),
    path('viewer/gcode', get_viewer_gcode),
    path('runtime/stream', stream_cnc_runtime),
    path('reprocess', reprocess_layer),
    path('cnc/reset', reset_cnc),
    path('gerber/preview', gerber_preview),
    
    # Nuevas rutas de Nesting
    path('measure/<int:job_id>', measure_pcb),
    path('nest/<int:job_id>', nest_pcb),
    path('sheet/preview', sheet_visual_preview),
    path('sheet/preview/<uuid:sheet_id>', sheet_visual_preview),
]
