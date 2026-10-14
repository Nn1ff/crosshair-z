#!/usr/bin/env bash
# Question B proxy: does an overlay stay visible above a fake borderless game?
# Runs the fake game (realistic = not topmost; hostile = topmost re-asserted every 500 ms) and samples
# the screen center 6x. Measures the running Electron 1.8.7 overlay first, then the spike overlay.
set -u
cd "$(dirname "$0")"
O=results/b-proxy.txt; : > "$O"

samples() { # label checkScript
  for i in 1 2 3 4 5 6; do
    sleep 1
    echo "$1 sample $i: $(powershell -NoProfile -File "$2" 2>&1 | tail -1)" >> "$O"
  done
}

for mode in realistic hostile; do
  flag=""; [ "$mode" = hostile ] && flag="-Hostile"
  echo "=== Electron 1.8.7 vs $mode fake game" >> "$O"
  (powershell -NoProfile -File fake-game.ps1 -Seconds 10 $flag &); sleep 2
  samples "electron/$mode" count-nonblack.ps1; sleep 4
done

{
  sleep 3; echo overlay; sleep 2
  for mode in realistic hostile; do
    flag=""; [ "$mode" = hostile ] && flag="-Hostile"
    echo "=== spike overlay vs $mode fake game" >> "$O"
    (powershell -NoProfile -File fake-game.ps1 -Seconds 10 $flag &); sleep 2
    samples "spike/$mode" check-overlay.ps1; sleep 4
  done
  echo quit
} | ./target/release/cz-spike.exe > /dev/null 2>&1
cat "$O"
