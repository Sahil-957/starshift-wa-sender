from PIL import Image, ImageDraw, ImageFont

def make_icon(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size // 5, fill=(7, 94, 84, 255))
    # simple phone/chat glyph: a rounded speech bubble
    pad = size * 0.2
    d.rounded_rectangle([pad, pad, size - pad, size - pad * 1.3], radius=size * 0.12, fill=(255, 255, 255, 255))
    tail = [
        (size * 0.35, size - pad * 1.3),
        (size * 0.5, size - pad * 0.6),
        (size * 0.55, size - pad * 1.3),
    ]
    d.polygon(tail, fill=(255, 255, 255, 255))
    img.save(path)

for s, name in [(16, "icon16.png"), (48, "icon48.png"), (128, "icon128.png")]:
    make_icon(s, rf"c:\Users\Admin\Desktop\Whatsapp_bulksms_sender_extention\extension\icons\{name}")

print("icons saved")
