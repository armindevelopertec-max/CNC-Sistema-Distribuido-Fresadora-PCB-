import uuid

from django.db import models


def generate_verification_key():
    return uuid.uuid4().hex[:8].upper()

class Sheet(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=100, blank=True, null=True)
    width = models.FloatField(help_text="Ancho de la lámina en mm")
    height = models.FloatField(help_text="Alto de la lámina en mm")
    
    # areas: list of dicts {"x": 0, "y": 0, "w": 100, "h": 200}
    free_areas = models.JSONField(default=list, blank=True)
    used_areas = models.JSONField(default=list, blank=True)
    
    created_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return f"Sheet {self.name or str(self.id)[:8]} ({self.width}x{self.height})"

    class Meta:
        ordering = ['-created_at']

class PCBJob(models.Model):
    STATUS_CHOICES = [
        ('RECEIVED', 'Recibido'),
        ('PANELIZING', 'Panelizando'),
        ('PROCESSING', 'Procesando G-code'),
        ('READY', 'Listo para enviar'),
        ('SENDING', 'Enviando a CNC'),
        ('COMPLETED', 'Completado'),
        ('FAILED', 'Fallido'),
    ]

    original_name = models.CharField(max_length=255)
    alias = models.CharField(max_length=100, blank=True, null=True, help_text="Nombre del diseñador o proyecto")
    client_id = models.CharField(max_length=64, blank=True, default='', db_index=True)
    client_label = models.CharField(max_length=120, blank=True, default='')
    traces_file = models.FileField(upload_to='gerber_files/', null=True, blank=True)
    outline_file = models.FileField(upload_to='gerber_files/', null=True, blank=True)
    pads_file = models.FileField(upload_to='gerber_files/', null=True, blank=True)

    traces_gcode = models.FileField(upload_to='gcode_output/', blank=True, null=True)
    outline_gcode = models.FileField(upload_to='gcode_output/', blank=True, null=True)
    pads_gcode = models.FileField(upload_to='gcode_output/', blank=True, null=True)
    
    # Combined G-code for the final job
    gcode_file = models.FileField(upload_to='gcode_output/', blank=True, null=True)
    preview_img = models.ImageField(upload_to='previews/', blank=True, null=True)
    
    # Dimensiones reales (Máximo 200x300mm)
    width_mm = models.FloatField(null=True, blank=True)
    height_mm = models.FloatField(null=True, blank=True)
    area_mm2 = models.FloatField(null=True, blank=True)
    
    # Nesting / Placement
    sheet = models.ForeignKey(Sheet, on_delete=models.SET_NULL, null=True, blank=True, related_name='jobs')
    placement_x = models.FloatField(null=True, blank=True)
    placement_y = models.FloatField(null=True, blank=True)
    placement_width = models.FloatField(null=True, blank=True, help_text="Ancho incluyendo margen")
    placement_height = models.FloatField(null=True, blank=True, help_text="Alto incluyendo margen")
    margin_mm = models.FloatField(default=2.0)

    # Costo en Bolivianos
    price_bs = models.FloatField(null=True, blank=True)
    
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='RECEIVED')
    verification_key = models.CharField(max_length=16, blank=True, default=generate_verification_key, db_index=True)
    published_to_operator = models.BooleanField(default=True, db_index=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    
    # Configuración técnica (profundidad, feedrate, etc.)
    config = models.JSONField(default=dict, blank=True)
    
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        origin = self.client_label or self.client_id
        suffix = f" [{origin}]" if origin else ""
        return f"{self.original_name}{suffix} ({self.status})"

    class Meta:
        ordering = ['-created_at']
