"""Adapt the user's local Crosshair Y UI samples. No extra Python packages required."""
import argparse
import array
import hashlib
import json
import math
from pathlib import Path
import sys
import wave


SAMPLES = [
    ('tab-1', 'tabchange-001-BLQ31O2Z.wav', 1.045),
    ('tab-2', 'tabchange-002-BPOzGBJb.wav', 1.045),
    ('tab-3', 'tabchange-003-vUrfFQi5.wav', 1.045),
    ('tab-4', 'tabchange-004-CeEjKz7s.wav', 1.045),
    ('click-1', 'genericselect-001-CRTZSIUi.wav', 1.035),
    ('click-2', 'genericselect-002-VH9L8PS2.wav', 1.035),
    ('toggle-on', 'toggle-on-DPwrpdWJ.wav', 1.055),
    ('toggle-off', 'toggle-off-DxrfGJBS.wav', 1.055),
    ('adjust-high', 'slider-hi-DzmD-ntX.wav', 1.06),
    ('adjust-low', 'slider-low-CTqCpSVx.wav', 1.06),
]


def adapt(source, dest, speed):
    with wave.open(str(source), 'rb') as audio:
        channels, width, rate, frames, _, _ = audio.getparams()
        raw = audio.readframes(frames)
    if width not in (2, 3, 4):
        raise ValueError(f'Unsupported PCM width: {width}')
    # Mono UI feedback, a small pitch/time shift, gentle low-pass and short fades.
    scale = 1 << (width * 8 - 1)
    step = channels * width
    samples = [sum(int.from_bytes(raw[i+c*width:i+(c+1)*width], 'little', signed=True)
                   for c in range(channels)) / (channels * scale)
               for i in range(0, len(raw), step)]
    count = int((len(samples) - 1) / speed)
    alpha = 1 - math.exp(-2 * math.pi * 6800 / rate)
    previous = 0.0
    rendered = []
    for i in range(count):
        position = i * speed
        j = int(position)
        value = samples[j] + (samples[j+1] - samples[j]) * (position-j)
        previous += alpha * (value - previous)
        fade = min(1.0, i / max(1, int(rate*.002)), (count-1-i) / max(1, int(rate*.018)))
        rendered.append(previous * .82 * fade)
    # Balance the very quiet tab/click sources against the much louder slider ticks.
    rms = math.sqrt(sum(value*value for value in rendered) / max(1, count))
    peak = max(abs(value) for value in rendered)
    gain = min(10, .022 / max(rms, 1e-9), .30 / max(peak, 1e-9))
    pcm = array.array('h', (round(value * gain * 32767) for value in rendered))
    if sys.byteorder != 'little':
        pcm.byteswap()
    with wave.open(str(dest), 'wb') as audio:
        audio.setparams((1, 2, rate, len(pcm), 'NONE', 'not compressed'))
        audio.writeframes(pcm.tobytes())
    return {'source': source.name, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'speed': speed, 'gain': round(gain, 4), 'seconds': round(count/rate, 3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Crosshair Y renderer assets directory')
    args = parser.parse_args()
    output = Path(__file__).resolve().parents[1] / 'src/renderer/sounds'
    output.mkdir(parents=True, exist_ok=True)
    manifest = {name: adapt(args.source / source, output / (name+'.wav'), speed)
                for name, source, speed in SAMPLES}
    (output / 'sources.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
    print(f'Adapted {len(manifest)} samples ({sum(p.stat().st_size for p in output.glob("*.wav")):,} bytes)')


if __name__ == '__main__':
    main()
