#!/usr/bin/env python3
import glob, os
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
slides_dir = os.path.join(here, '..', '..', 'presentation-slides')
slides_dir = os.path.abspath(slides_dir)

paths = sorted(glob.glob(os.path.join(slides_dir, '*.png')))
if not paths:
    raise SystemExit('no PNGs found in ' + slides_dir)

imgs = [Image.open(p).convert('RGB') for p in paths]
out = os.path.join(slides_dir, 'orbit-presentation.pdf')
imgs[0].save(out, 'PDF', resolution=150.0, save_all=True, append_images=imgs[1:])
print('wrote', out)
for p in paths:
    print(' ', os.path.basename(p))
