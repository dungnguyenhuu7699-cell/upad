"""Chạy sau `npx cap add android`: thêm quyền báo thức + đổi icon app."""
import os, re, shutil
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
