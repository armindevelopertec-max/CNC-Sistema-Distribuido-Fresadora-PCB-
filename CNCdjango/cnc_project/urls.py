from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from core.views import home, panel, documentation

urlpatterns = [
    path('admin/', admin.site.urls),
    path('docs', documentation, name='docs'),
    path('docs.html', documentation),
    path('api/', include('core.urls')),
    path('', home, name='index'),
    path('index.html', home), # Compatibilidad
    path('panel', panel, name='panel'),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

# En desarrollo, Django sirve static automáticamente si está configurado en settings
if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
