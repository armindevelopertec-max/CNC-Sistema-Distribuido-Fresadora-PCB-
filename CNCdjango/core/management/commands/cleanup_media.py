import os
import time
from django.core.management.base import BaseCommand
from django.conf import settings
from django.utils import timezone
from datetime import timedelta
from core.models import PCBJob

class Command(BaseCommand):
    help = 'Cleans up old PCB jobs and their associated media files'

    def add_arguments(self, parser):
        parser.add_argument(
            '--days',
            type=int,
            default=7,
            help='Delete jobs older than this many days (default: 7)'
        )
        parser.add_argument(
            '--clear-all',
            action='store_true',
            help='Clear ALL jobs and files (danger!)'
        )
        parser.add_argument(
            '--orphans',
            action='store_true',
            help='Attempt to delete files in media/ that are not referenced in the DB'
        )

    def handle(self, *args, **options):
        days = options['days']
        clear_all = options['clear_all']
        clean_orphans = options['orphans']

        if clear_all:
            jobs = PCBJob.objects.all()
            self.stdout.write(self.style.WARNING(f'Deleting ALL {jobs.count()} jobs...'))
        else:
            cutoff = timezone.now() - timedelta(days=days)
            jobs = PCBJob.objects.filter(created_at__lt=cutoff)
            self.stdout.write(f'Cleaning jobs older than {days} days (before {cutoff})...')

        count = 0
        for job in jobs:
            # Manually delete files if signal handlers aren't active yet or to be sure
            self._delete_job_files(job)
            job.delete()
            count += 1

        self.stdout.write(self.style.SUCCESS(f'Successfully deleted {count} jobs and their files.'))

        if clean_orphans:
            self._clean_orphans()

    def _delete_job_files(self, job):
        file_fields = [
            'traces_file', 'outline_file', 'pads_file',
            'traces_gcode', 'outline_gcode', 'pads_gcode',
            'gcode_file', 'preview_img'
        ]
        for field_name in file_fields:
            field = getattr(job, field_name)
            if field and field.storage.exists(field.name):
                try:
                    self.stdout.write(f'Deleting file: {field.path}')
                    field.delete(save=False)
                except Exception as e:
                    self.stdout.write(self.style.ERROR(f'Error deleting {field.name}: {e}'))

    def _clean_orphans(self):
        self.stdout.write('Cleaning orphaned files...')
        media_root = settings.MEDIA_ROOT
        
        # Only delete orphans older than 5 minutes to avoid race conditions with uploads
        cutoff_time = time.time() - (5 * 60)
        
        subdirs = ['gerber_files', 'gcode_output', 'previews', 'temp']
        
        # Build a set of all files currently in the DB
        referenced_files = set()
        for job in PCBJob.objects.all():
            for field_name in ['traces_file', 'outline_file', 'pads_file', 'traces_gcode', 'outline_gcode', 'pads_gcode', 'gcode_file', 'preview_img']:
                field = getattr(job, field_name)
                if field:
                    referenced_files.add(field.name)

        for subdir in subdirs:
            dir_path = os.path.join(media_root, subdir)
            if not os.path.exists(dir_path):
                continue
            
            for filename in os.listdir(dir_path):
                rel_path = os.path.join(subdir, filename)
                if rel_path not in referenced_files:
                    full_path = os.path.join(dir_path, filename)
                    if os.path.isfile(full_path):
                        # Check age
                        if os.path.getmtime(full_path) < cutoff_time:
                            self.stdout.write(f'Deleting orphan: {rel_path}')
                            os.remove(full_path)
                        else:
                            self.stdout.write(f'Skipping recent file (possible upload): {rel_path}')
