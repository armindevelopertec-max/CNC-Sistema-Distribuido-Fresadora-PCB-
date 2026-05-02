#!/bin/bash

PORT=8000
# Script para detectar la IP local y lanzar el servidor para la red
IP_LOCAL=$(hostname -I | awk '{print $1}')

echo "--------------------------------------------------------"
echo "🚀 INICIANDO SERVIDOR CNCdjango PARA RED LOCAL"
echo "--------------------------------------------------------"

# Verificar si el puerto está ocupado
PID_BUSY=$(lsof -t -i:$PORT)
if [ ! -z "$PID_BUSY" ]; then
    echo "⚠️  El puerto $PORT ya está siendo usado por el proceso: $PID_BUSY"
    echo "Intentando liberar el puerto..."
    kill -9 $PID_BUSY
    sleep 1
fi

echo "Tu computadora está actuando como SERVIDOR (Computadora 3)."
echo ""
echo "📱 Los DISEÑADORES (Computadora 1) deben entrar a:"
echo "http://$IP_LOCAL:$PORT"
echo ""
echo "🛠️  Tú como OPERADOR (Computadora 3) puedes usar:"
echo "http://localhost:$PORT"
echo "--------------------------------------------------------"

python3 manage.py runserver 0.0.0.0:$PORT
