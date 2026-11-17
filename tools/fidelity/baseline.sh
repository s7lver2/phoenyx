#!/bin/sh
# Linea base de three: tres calidades del juego x CPU normal y ralentizada 4x. Uso: sh baseline.sh [url]
URL=${1:-http://localhost:5190}
for p in high medium low; do
  for t in 1 4; do
    node capture.mjs --url "$URL" --preset $p --throttle $t --out ../../fidelity/baseline/$p-x$t || exit 1
  done
done
