#!/usr/bin/env bash
# Drives cz-spike over stdin and measures the process tree at fixed moments (Question A).
set -u
SPIKE="/g/antigravity/crosshair z/native/spike"
EXE="$SPIKE/target/release/cz-spike.exe"
OUT="${1:?out dir}"
mkdir -p "$OUT"
LOG="$OUT/a-measure.txt"; : > "$LOG"

measure() { # label cpuSeconds
  { echo "=== $1 @ $(date +%T)"; powershell -NoProfile -File "$SPIKE/measure.ps1" -Name cz-spike -CpuSeconds "$2" 2>&1; } >> "$LOG"
}

{
  sleep 4;  measure "start, no webview" 5
  echo open; sleep 8; measure "webview open" 5
  echo close; sleep 1; measure "close +1s" 1
  sleep 6; measure "close +10s" 3
  sleep 47; measure "close +60s" 3
  for i in 1 2 3 4 5; do echo open; sleep 5; echo close; sleep 3; done
  sleep 10; measure "after 5 cycles +10s" 3
  echo open; sleep 5; echo "process alive check: reopened" >> "$LOG"; measure "reopen after cycles" 2
  echo close; sleep 2
  echo quit
} | "$EXE" > "$OUT/a-stdout.txt" 2>&1
echo "exit $?" >> "$LOG"
