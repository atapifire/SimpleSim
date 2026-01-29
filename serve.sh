#!/bin/bash
# Simple local development server for SimpleSim
# Usage: ./serve.sh [port]

PORT=${1:-8080}

echo "🚀 Starting SimpleSim dev server on http://localhost:$PORT"
echo "   Press Ctrl+C to stop"
echo ""

# Check for available server options
if command -v python3 &> /dev/null; then
    python3 -m http.server $PORT
elif command -v python &> /dev/null; then
    python -m SimpleHTTPServer $PORT
elif command -v npx &> /dev/null; then
    npx serve -l $PORT
else
    echo "❌ No server available. Install Python or Node.js"
    exit 1
fi
