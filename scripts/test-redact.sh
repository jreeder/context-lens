#!/usr/bin/env bash
# Quick smoke test for --redact flag.
# Starts proxy with redaction, sends a fake request, checks the capture.
set -euo pipefail

CAPTURES_DIR="$HOME/.context-lens/captures"
PROXY_PORT=4040

echo "=== Redaction smoke test ==="

# Clean old captures
rm -f "$CAPTURES_DIR"/*.json 2>/dev/null || true

# Start proxy with redaction in background
echo "Starting proxy with --redact=pii..."
CONTEXT_LENS_REDACT=pii node dist/proxy/server.js &
PROXY_PID=$!
sleep 1

# Send a request with a fake API key and PII in the body
echo "Sending test request..."
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -X POST "http://localhost:$PROXY_PORT/test/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-ant-api03-FAKE-SECRET-KEY-1234567890abcdef" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 10,
    "messages": [
      {"role": "user", "content": "My name is John Smith and my email is john.smith@example.com. My API key is sk-proj-abc123secret456."}
    ]
  }' || true

sleep 1

# Kill proxy
kill $PROXY_PID 2>/dev/null || true
wait $PROXY_PID 2>/dev/null || true

# Check the capture
LATEST=$(ls -t "$CAPTURES_DIR"/*.json 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  echo "FAIL: No capture file found in $CAPTURES_DIR"
  exit 1
fi

echo ""
echo "=== Capture file: $LATEST ==="
echo ""
echo "--- Headers (check x-api-key is redacted) ---"
jq '.request.headers' "$LATEST" 2>/dev/null || cat "$LATEST"
echo ""
echo "--- Body (check PII is redacted) ---"
jq '.request.body' "$LATEST" 2>/dev/null || cat "$LATEST"
echo ""
echo "Done. Inspect the output above to verify redaction."
