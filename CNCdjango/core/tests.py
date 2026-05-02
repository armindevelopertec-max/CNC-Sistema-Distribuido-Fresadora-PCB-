import shutil
import tempfile

from django.test import TestCase, override_settings
from django.core.files.uploadedfile import SimpleUploadedFile

from .models import PCBJob


class UploadGerberTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._media_root = tempfile.mkdtemp(prefix='codex-media-')
        cls._override = override_settings(MEDIA_ROOT=cls._media_root)
        cls._override.enable()

    @classmethod
    def tearDownClass(cls):
        cls._override.disable()
        shutil.rmtree(cls._media_root, ignore_errors=True)
        super().tearDownClass()

    def _upload_job(self, alias, client_id, base_name, workflow_mode='saas'):
        payload = {
            'alias': alias,
            'config': '{}',
            'client_id': client_id,
            'client_label': f'Estación {client_id}',
            'workflow_mode': workflow_mode,
            'gb1': SimpleUploadedFile(f'{base_name}.gb1', b'gb1-data'),
            'gb0': SimpleUploadedFile(f'{base_name}.gb0', b'gb0-data'),
            'gb2': SimpleUploadedFile(f'{base_name}.gb2', b'gb2-data'),
        }
        return self.client.post('/api/upload', payload)

    def test_upload_gerber_accepts_explicit_layer_keys(self):
        payload = {
            'alias': 'PC local',
            'config': '{}',
            'client_id': 'station-a',
            'client_label': 'Estación A',
            'gb1': SimpleUploadedFile('board.gb1', b'gb1-data'),
            'gb0': SimpleUploadedFile('board.gb0', b'gb0-data'),
            'gb2': SimpleUploadedFile('board.gb2', b'gb2-data'),
        }

        response = self.client.post('/api/upload', payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(PCBJob.objects.count(), 1)

        job = PCBJob.objects.first()
        self.assertEqual(job.client_id, 'station-a')
        self.assertEqual(job.client_label, 'Estación A')
        self.assertIsNotNone(job.traces_file)
        self.assertIsNotNone(job.outline_file)
        self.assertIsNotNone(job.pads_file)
        self.assertTrue(job.traces_file.name.endswith('board.gb1'))

    def test_upload_gerber_infers_layers_from_native_file_input(self):
        payload = {
            'alias': 'PC remota',
            'config': '{}',
            'client_id': 'station-b',
            'client_label': 'Estación B',
            'gerber_files': [
                SimpleUploadedFile('remote_board.gb0', b'gb0-data'),
                SimpleUploadedFile('remote_board.gb1', b'gb1-data'),
                SimpleUploadedFile('remote_board.gb2', b'gb2-data'),
            ],
        }

        response = self.client.post('/api/upload', payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(PCBJob.objects.count(), 1)

        job = PCBJob.objects.first()
        self.assertEqual(job.client_id, 'station-b')
        self.assertIsNotNone(job.traces_file)
        self.assertIsNotNone(job.outline_file)
        self.assertIsNotNone(job.pads_file)
        self.assertTrue(job.traces_file.name.endswith('remote_board.gb1'))

    def test_upload_gerber_accepts_common_gerber_names(self):
        payload = {
            'alias': 'CAD normal',
            'config': '{}',
            'client_id': 'station-c',
            'client_label': 'Estación C',
            'gerber_files': [
                SimpleUploadedFile('project_F_Cu.gbr', b'gb1-data'),
                SimpleUploadedFile('project_Edge_Cuts.gbr', b'gb0-data'),
                SimpleUploadedFile('project_PTH.drl', b'gb2-data'),
            ],
        }

        response = self.client.post('/api/upload', payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(PCBJob.objects.count(), 1)

        job = PCBJob.objects.first()
        self.assertEqual(job.client_id, 'station-c')
        self.assertIsNotNone(job.traces_file)
        self.assertIsNotNone(job.outline_file)
        self.assertIsNotNone(job.pads_file)
        self.assertTrue(job.traces_file.name.endswith('project_F_Cu.gbr'))

    def test_upload_gerber_accepts_common_cad_extensions(self):
        payload = {
            'alias': 'CAD extension',
            'config': '{}',
            'client_id': 'station-d',
            'client_label': 'Estación D',
            'gerber_files': [
                SimpleUploadedFile('project.gtl', b'gb1-data'),
                SimpleUploadedFile('project.gko', b'gb0-data'),
                SimpleUploadedFile('project.drl', b'gb2-data'),
            ],
        }

        response = self.client.post('/api/upload', payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(PCBJob.objects.count(), 1)

        job = PCBJob.objects.first()
        self.assertEqual(job.client_id, 'station-d')
        self.assertIsNotNone(job.traces_file)
        self.assertIsNotNone(job.outline_file)
        self.assertIsNotNone(job.pads_file)
        self.assertTrue(job.traces_file.name.endswith('project.gtl'))

    def test_list_and_status_are_scoped_by_client_id(self):
        self._upload_job('PC A', 'station-a', 'alpha')
        self._upload_job('PC B', 'station-b', 'beta')

        status_response = self.client.get('/api/status', {'client_id': 'station-a'})
        self.assertEqual(status_response.status_code, 200)
        status_payload = status_response.json()
        self.assertIn('alpha.gb1', status_payload['recentUpload']['filename'])
        self.assertEqual(status_payload['recentUpload']['clientId'], 'station-a')

        uploads_response = self.client.get('/api/uploads', {'client_id': 'station-a'})
        self.assertEqual(uploads_response.status_code, 200)
        uploads_payload = uploads_response.json()
        self.assertEqual(len(uploads_payload), 1)
        self.assertEqual(uploads_payload[0]['alias'], 'PC A')
        self.assertEqual(uploads_payload[0]['clientId'], 'station-a')
        self.assertEqual(uploads_payload[0]['filename'], 'alpha.gb1')

    def test_viewer_files_and_gcode_are_scoped_by_client_id(self):
        job_a = PCBJob.objects.create(
            original_name='alpha.gb1',
            alias='PC A',
            client_id='station-a',
            client_label='Estación A',
            status='READY',
            gcode_file=SimpleUploadedFile('alpha_a.ngc', b'G1 X1\n')
        )
        PCBJob.objects.create(
            original_name='beta.gb1',
            alias='PC B',
            client_id='station-b',
            client_label='Estación B',
            status='READY',
            gcode_file=SimpleUploadedFile('beta_b.ngc', b'G1 X2\n')
        )

        files_response = self.client.get('/api/viewer/files', {'client_id': 'station-a'})
        self.assertEqual(files_response.status_code, 200)
        files_payload = files_response.json()
        self.assertEqual(len(files_payload), 1)
        self.assertEqual(files_payload[0]['id'], job_a.id)
        self.assertEqual(files_payload[0]['clientId'], 'station-a')

        gcode_response = self.client.get('/api/viewer/gcode', {
            'job_id': job_a.id,
            'layer': 'combined',
            'client_id': 'station-a',
        })
        self.assertEqual(gcode_response.status_code, 200)
        self.assertIn('G1 X1', gcode_response.content.decode())

    def test_viewer_send_respects_client_scope(self):
        job_a = PCBJob.objects.create(
            original_name='alpha.gb1',
            alias='PC A',
            client_id='station-a',
            client_label='Estación A',
            status='READY',
            gcode_file=SimpleUploadedFile('alpha_a.ngc', b'G1 X1\n')
        )
        job_b = PCBJob.objects.create(
            original_name='beta.gb1',
            alias='PC B',
            client_id='station-b',
            client_label='Estación B',
            status='READY',
            gcode_file=SimpleUploadedFile('beta_b.ngc', b'G1 X2\n')
        )

        response = self.client.post(
            '/api/viewer/send',
            data='{"jobId": %d, "client_id": "station-a"}' % job_a.id,
            content_type='application/json'
        )
        self.assertEqual(response.status_code, 200)

        job_a.refresh_from_db()
        job_b.refresh_from_db()
        self.assertEqual(job_a.status, 'SENDING')
        self.assertEqual(job_b.status, 'READY')

    def test_printshop_jobs_stay_private_until_published(self):
        response = self._upload_job('Diseño privado', 'station-printshop', 'draft', workflow_mode='printshop')
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload['publishedToOperator'])
        self.assertTrue(payload['verificationKey'])

        operator_uploads = self.client.get('/api/uploads')
        self.assertEqual(operator_uploads.status_code, 200)
        self.assertEqual(operator_uploads.json(), [])

        designer_uploads = self.client.get('/api/uploads', {'client_id': 'station-printshop'})
        self.assertEqual(designer_uploads.status_code, 200)
        designer_payload = designer_uploads.json()
        self.assertEqual(len(designer_payload), 1)
        self.assertFalse(designer_payload[0]['publishedToOperator'])

        publish_response = self.client.post(
            f"/api/publish/{payload['id']}",
            data='{"client_id": "station-printshop"}',
            content_type='application/json'
        )
        self.assertEqual(publish_response.status_code, 200)
        publish_payload = publish_response.json()
        self.assertTrue(publish_payload['publishedToOperator'])
        self.assertEqual(publish_payload['verificationKey'], payload['verificationKey'])

        operator_uploads = self.client.get('/api/uploads')
        self.assertEqual(operator_uploads.status_code, 200)
        operator_payload = operator_uploads.json()
        self.assertEqual(len(operator_payload), 1)
        self.assertEqual(operator_payload[0]['id'], payload['id'])
        self.assertTrue(operator_payload[0]['publishedToOperator'])
