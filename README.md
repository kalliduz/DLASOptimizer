# DLAS Rectangle Image Approximator

A web-based tool that approximates images using layered semi-transparent rectangles, powered by a Diversified Late Acceptance Search (DLAS) optimizer.

## Features

- **Image Upload**: Upload any image to approximate
- **Interactive Optimization**: Watch in real-time as rectangles are optimized to match your image
- **Configurable Parameters**:
  - Rectangle count, size range, and alpha transparency
  - Mutation rate and strength
  - DLAS history length for escaping local minima
  - Background color computation (average, median, black, white)
  - Smart initialization and color bias options
  - Optional rotation support
- **Visual Feedback**:
  - Side-by-side comparison of original and approximation
  - Difference map visualization (×4 amplified)
  - Real-time MSE chart tracking convergence
  - Statistics panel with iteration count, acceptance rate, and similarity percentage
- **Export**: Save your best approximation as a PNG file

## Usage

1. Start a local web server:
   ```bash
   python3 -m http.server 8000
   ```

2. Open your browser to `http://localhost:8000/`

3. Upload an image using the file picker

4. Adjust parameters as desired (or use defaults)

5. Click "Start" to begin optimization

6. Click "Pause" to pause, "Reset" to restart, or "Export Best PNG" to save your result

## How It Works

The DLAS optimizer uses diversified late acceptance search:
- Maintains a circular history of previous solution quality scores
- Accepts candidates if they are sideways moves or better than the history maximum
- Uses selective history replacement to keep diversity and avoid degenerating to plain hill climbing
- Auto-adapts mutation strength based on acceptance rate

## Technical Details

- Pure JavaScript with HTML5 Canvas
- No external dependencies
- Optimized evaluation using downscaled internal canvas
- Configurable compute budget per frame (default: 8ms) to maintain smooth UI
- Renders at ~15 FPS while dedicating most compute to optimization

## License

This project is provided as-is for educational and experimental purposes.
