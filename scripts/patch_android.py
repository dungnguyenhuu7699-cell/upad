"""Chạy sau `npx cap add android`: thêm quyền báo thức + đổi icon app."""
import os, re, shutil, wave, struct, math
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..')
manifest = os.path.join(ROOT, 'android/app/src/main/AndroidManifest.xml')
s = open(manifest, encoding='utf-8').read()
perms = ['POST_NOTIFICATIONS', 'SCHEDULE_EXACT_ALARM', 'USE_EXACT_ALARM', 'RECEIVE_BOOT_COMPLETED', 'VIBRATE', 'WAKE_LOCK']
add = ''.join(f'    <uses-permission android:name="android.permission.{p}" />\n' for p in perms
              if f'android.permission.{p}"' not in s)
s = s.replace('<application', add + '\n    <application', 1)
open(manifest, 'w', encoding='utf-8').write(s)
print('manifest patched:', perms)

res = os.path.join(ROOT, 'android/app/src/main/res')
shutil.rmtree(os.path.join(res, 'mipmap-anydpi-v26'), ignore_errors=True)   # bỏ icon adaptive mặc định
icon = Image.open(os.path.join(os.path.dirname(__file__), 'icon.png')).convert('RGBA')
for d, size in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
    folder = os.path.join(res, f'mipmap-{d}')
    os.makedirs(folder, exist_ok=True)
    im = icon.resize((size, size), Image.LANCZOS)
    for name in ('ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'):
        im.save(os.path.join(folder, name))
print('icons replaced')

# ---- Âm báo thức: res/raw/chime.wav (kênh thông báo Android PHẢI có file âm thanh thì mới kêu) ----
def make_chime(path, rate=22050):
    notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5]      # C5 E5 G5 C6 G5 C6
    step, tail = 0.28, 1.2
    total = int(rate * (step * len(notes) + tail))
    buf = [0.0] * total
    for i, f in enumerate(notes):
        start = int(rate * step * i)
        for n in range(int(rate * 1.1)):
            if start + n >= total: break
            t = n / rate
            tri = 2 / math.pi * math.asin(math.sin(2 * math.pi * f * t))   # sóng tam giác như chuông trong app
            buf[start + n] += 0.45 * tri * math.exp(-3.2 * t)
    peak = max(1e-9, max(abs(x) for x in buf))
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, x / peak * 0.9)) * 32767)) for x in buf))

raw = os.path.join(res, 'raw')
os.makedirs(raw, exist_ok=True)
make_chime(os.path.join(raw, 'chime.wav'))
print('chime.wav created')
