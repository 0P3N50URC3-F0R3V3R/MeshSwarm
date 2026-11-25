#!/bin/sh
cd "$(dirname "$0")" || exit 1
while true; do
  if [ -x runtime/node ]; then runtime/node src/index.js; else node src/index.js; fi
  [ $? -eq 42 ] || exit $?
done
