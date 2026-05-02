from django.contrib import admin
from .models import PCBJob, Sheet

@admin.register(Sheet)
class SheetAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'width', 'height', 'is_active', 'created_at')
    list_filter = ('is_active', 'created_at')
    search_fields = ('name', 'id')

@admin.register(PCBJob)
class PCBJobAdmin(admin.ModelAdmin):
    list_display = ('original_name', 'alias', 'client_label', 'client_id', 'status', 'sheet', 'placement_x', 'placement_y', 'created_at')
    list_filter = ('status', 'sheet', 'created_at')
    search_fields = ('original_name', 'alias', 'client_id', 'client_label')
    readonly_fields = ('created_at',)
    
    fieldsets = (
        ('Información del Archivo', {
            'fields': ('original_name', 'alias', 'client_label', 'client_id')
        }),
        ('Archivos', {
            'fields': ('traces_file', 'outline_file', 'pads_file', 'traces_gcode', 'outline_gcode', 'pads_gcode', 'gcode_file', 'preview_img')
        }),
        ('Dimensiones y Costo', {
            'fields': ('width_mm', 'height_mm', 'area_mm2', 'price_bs')
        }),
        ('Nesting / Colocación', {
            'fields': ('sheet', 'placement_x', 'placement_y', 'placement_width', 'placement_height', 'margin_mm')
        }),
        ('Estado y Configuración', {
            'fields': ('status', 'published_to_operator', 'verification_key', 'completed_at', 'config', 'created_at')
        }),
    )
