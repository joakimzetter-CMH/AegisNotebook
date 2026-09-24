#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

COMPOSE="docker-compose"
if ! command -v docker-compose &> /dev/null; then
    COMPOSE="docker compose"
fi

echo "🚀 Starting Aegis Notebook powered by Marvin AI..."
$COMPOSE up -d --build

echo "⌛ Waiting for services to be ready..."
count=0
until curl -s http://localhost:8502 > /dev/null 2>&1; do
    printf '.'
    sleep 2
    count=$((count+1))
    if [ $count -gt 90 ]; then
        echo ""
        echo "⚠️ Timed out waiting for Web UI, checking container logs..."
        $COMPOSE logs --tail=30
        break
    fi
done

echo ""
echo "✅ Aegis Notebook is up and running!"
echo "🌐 Web UI:  http://localhost:8502"
echo "🔌 API:     http://localhost:5055"
echo "🧠 AI Core: Marvin (Go-native Context Datastore & Vector Engine @ http://localhost:8888/v1)"
