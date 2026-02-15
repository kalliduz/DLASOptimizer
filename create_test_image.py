from PIL import Image, ImageDraw

# Create a simple test image
img = Image.new('RGB', (200, 200), 'white')
draw = ImageDraw.Draw(img)

# Draw some shapes
draw.rectangle([20, 20, 80, 80], fill='red')
draw.rectangle([120, 120, 180, 180], fill='blue')
draw.ellipse([80, 80, 140, 140], fill='green')

# Save the image
img.save('test_image.png')
print("Test image created: test_image.png")
