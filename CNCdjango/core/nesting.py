import logging
from .models import Sheet, PCBJob

logger = logging.getLogger(__name__)

class NestingService:
    @staticmethod
    def get_or_create_active_sheet(width=300.0, height=200.0):
        """
        Obtiene la última lámina activa o crea una nueva si no hay ninguna.
        """
        sheet = Sheet.objects.filter(is_active=True).first()
        if not sheet:
            sheet = Sheet.objects.create(
                width=width,
                height=height,
                free_areas=[{"x": 0, "y": 0, "w": width, "h": height}],
                used_areas=[]
            )
        return sheet

    @staticmethod
    def place_pcb(job_id, sheet_id=None, margin=2.0):
        """
        Intenta colocar un PCBJob en una lámina.
        Si sheet_id es None, busca la lámina activa.
        """
        job = PCBJob.objects.get(id=job_id)
        
        # Dimensiones efectivas con margen
        pw = job.width_mm + (2 * margin)
        ph = job.height_mm + (2 * margin)
        
        if sheet_id:
            sheet = Sheet.objects.get(id=sheet_id)
        else:
            sheet = NestingService.get_or_create_active_sheet()

        # Algoritmo de Guillotina simple (First Fit)
        best_area_idx = -1
        
        for i, area in enumerate(sheet.free_areas):
            # Probar orientación original
            if area['w'] >= pw and area['h'] >= ph:
                best_area_idx = i
                break
            # Probar rotación 90° (opcional, pero útil)
            if area['w'] >= ph and area['h'] >= pw:
                # Rotamos el PCB para este espacio
                pw, ph = ph, pw
                best_area_idx = i
                break
        
        if best_area_idx == -1:
            # No cabe en esta lámina. ¿Deberíamos crear una nueva?
            if not sheet_id: # Solo auto-creamos si no se especificó una lámina concreta
                sheet.is_active = False
                sheet.save()
                return NestingService.place_pcb(job_id, margin=margin)
            return False, "No hay espacio suficiente en la lámina seleccionada."

        # Colocar en la zona encontrada
        area = sheet.free_areas.pop(best_area_idx)
        
        job.sheet = sheet
        job.placement_x = area['x']
        job.placement_y = area['y']
        job.placement_width = pw
        job.placement_height = ph
        job.margin_mm = margin
        job.status = 'PANELIZING'
        job.save()

        # Registrar área usada
        used_rect = {"x": area['x'], "y": area['y'], "w": pw, "h": ph, "job_id": job.id}
        sheet.used_areas.append(used_rect)

        # Dividir el área restante (Corte de Guillotina)
        # Decidimos por qué lado cortar basándonos en cuál deja el área restante más "cuadrada"
        remain_w = area['w'] - pw
        remain_h = area['h'] - ph

        if remain_w > remain_h:
            # Corte vertical primero
            if remain_w > 0:
                sheet.free_areas.append({"x": area['x'] + pw, "y": area['y'], "w": remain_w, "h": area['h']})
            if remain_h > 0:
                sheet.free_areas.append({"x": area['x'], "y": area['y'] + ph, "w": pw, "h": remain_h})
        else:
            # Corte horizontal primero
            if remain_h > 0:
                sheet.free_areas.append({"x": area['x'], "y": area['y'] + ph, "w": area['w'], "h": remain_h})
            if remain_w > 0:
                sheet.free_areas.append({"x": area['x'] + pw, "y": area['y'], "w": remain_w, "h": ph})

        sheet.save()
        return True, f"PCB colocado en ({job.placement_x}, {job.placement_y}) de la lámina {sheet.id}"

    @staticmethod
    def release_job(job_id):
        """
        Libera el espacio de un job en su lámina (opcional, por si se cancela)
        Nota: Esto es complejo porque fragmenta las áreas libres. 
        En una primera fase, quizás simplemente marcar el job como 'removed' en used_areas
        y no intentar recuperar el hueco inmediatamente a menos que se haga un defrag.
        """
        job = PCBJob.objects.get(id=job_id)
        if not job.sheet:
            return False, "El job no está asociado a ninguna lámina."
        
        # Por ahora, simplemente quitamos la relación
        job.sheet = None
        job.placement_x = None
        job.placement_y = None
        job.save()
        return True, "Job liberado de la lámina (espacio no recuperado automáticamente)."
