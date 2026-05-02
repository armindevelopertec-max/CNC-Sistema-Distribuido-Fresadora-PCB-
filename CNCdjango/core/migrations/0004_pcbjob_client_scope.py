from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0003_pcbjob_alias'),
    ]

    operations = [
        migrations.AddField(
            model_name='pcbjob',
            name='client_id',
            field=models.CharField(blank=True, db_index=True, default='', max_length=64),
        ),
        migrations.AddField(
            model_name='pcbjob',
            name='client_label',
            field=models.CharField(blank=True, default='', max_length=120),
        ),
    ]
