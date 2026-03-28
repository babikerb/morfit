#!/bin/bash
set -e

# Kill anything on 3001
lsof -ti :3001 | xargs kill -9 2>/dev/null || true
lsof -ti :4040 | xargs kill -9 2>/dev/null || true

# Start backend
cd "$(dirname "$0")/backend"
node server.js &
sleep 2

# Start ngrok
ngrok http 3001 --log=stdout > /tmp/ngrok.log 2>&1 &
echo "Waiting for ngrok tunnel..."
sleep 4

# Extract ngrok URL
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | python3 -c "import sys,json; print(json.load(sys.stdin)['tunnels'][0]['public_url'])" 2>/dev/null)

if [ -z "$NGROK_URL" ]; then
  echo "❌ Could not get ngrok URL. Check /tmp/ngrok.log"
  exit 1
fi

echo "✅ Backend running"
echo "✅ Tunnel: $NGROK_URL"

# Update App.js
APP_JS="/Users/csuftitan/Desktop/morfit/App.js"
sed -i '' "s|const BACKEND_URL = '.*'|const BACKEND_URL = '$NGROK_URL'|" "$APP_JS"
echo "✅ App.js updated with $NGROK_URL"

echo ""
echo "Now run: npx expo start  (in another terminal)"
wait
