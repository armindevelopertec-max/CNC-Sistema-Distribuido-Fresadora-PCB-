import uuid

import core.models
from django.db import migrations, models


def backfill_verification_keys(apps, schema_editor):
    PCBJob = apps.get_model('core', 'PCBJob')
    for job in PCBJob.objects.all():
        job.verification_key = uuid.uuid4().hex[:8].upper()
        job.save(update_fields=['verification_key'])


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0004_pcbjob_client_scope'),
    ]

    operations = [
        migrations.AddField(
            model_name='pcbjob',
            name='completed_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='pcbjob',
            name='published_to_operator',
            field=models.BooleanField(db_index=True, default=True),
        ),
        migrations.AddField(
            model_name='pcbjob',
            name='verification_key',
            field=models.CharField(blank=True, db_index=True, default=core.models.generate_verification_key, max_length=16),
        ),
        migrations.RunPython(backfill_verification_keys, migrations.RunPython.noop),
    ]
