# DLAS Image Optimizer

A high-performance browser-based tool that approximates images using semi-transparent, overlapping colored rectangles. The application uses Dynamic Late Acceptance Search (DLAS) optimization to iteratively improve the approximation in real-time.

## Features

### Core Functionality
- **Image Upload**: Auto-scales uploaded images to a maximum of 400px for optimal performance
- **Rectangle-Based Approximation**: Represents images using configurable colored, semi-transparent rectangles
- **Real-Time Optimization**: Continuously improves approximation using DLAS algorithm
- **Live Visual Feedback**: Side-by-side display of original and approximation with real-time updates

### DLAS Optimization
The optimizer uses Dynamic Late Acceptance Search, which:
- Randomly mutates individual rectangles (position, size, color, alpha, rotation)
- Keeps changes that improve the approximation
- Occasionally accepts slightly worse mutations to escape local minima
- Provides superior exploration of the solution space compared to traditional hill climbing

### User Controls

#### Rectangle Settings
- **Rectangle Count**: 10–5000 rectangles
- **Min/Max Size**: Control the size range of rectangles
- **Min/Max Alpha**: Control transparency range

#### Optimization Settings
- **Mutations per Iteration**: Number of mutation attempts per optimization step
- **Mutation Strength**: How aggressive mutations are (0.01–1.0)
- **Auto-Adapt Strength**: Automatically adjusts mutation strength based on acceptance rate
- **DLAS History Length**: Controls how aggressively worse solutions are accepted (10–1000)
- **Compute Budget**: CPU time per frame in milliseconds (5–100ms)

#### Advanced Options
- **Background Mode**: Average color, median color, black, or white
- **Smart Init (Greedy)**: Seeds rectangles in high-error regions with sampled colors
- **Color from Target**: Biases color mutations toward the original image's local colors
- **Allow Rotation**: Enables angle mutation on rectangles
- **Show Diff Map**: Displays amplified per-pixel absolute difference view

### Display & Statistics

#### Visual Feedback
- Side-by-side canvases showing original and approximation
- Activity indicator during optimization
- Optional difference map with 4× amplification for visibility
- Rolling MSE chart showing optimization progress

#### Live Statistics
- Iteration count and iterations per second
- Current MSE and Best MSE
- Percent similarity (0-100%)
- Acceptance rate
- Worsening-accepted count
- Current mutation strength

### Actions
- **Start**: Begin optimization loop
- **Pause**: Pause optimization
- **Reset**: Reset to initial state with new random rectangles
- **Export Best**: Download the best approximation as PNG

## Performance

The application is optimized for high throughput:
- **Tens of thousands of iterations per second** on typical hardware
- **Throttled UI updates** (~15 fps) to maximize compute time
- **Efficient MSE calculation** using offscreen canvas rendering
- **Minimal memory allocation** during optimization loop
- **Progressive visual updates** for responsive feel

## How to Use

1. Open `index.html` in a modern web browser
2. Upload an image using the file picker
3. Adjust settings as desired (or use defaults)
4. Click "Start" to begin optimization
5. Watch the approximation improve in real-time
6. Click "Export Best" to save the result

## Technical Details

### Mutation Strategy
The optimizer randomly selects one of the following mutations:
- **Position** (30%): Move rectangle within bounds
- **Size** (20%): Adjust width and height
- **Color** (30%): Modify RGB values (optionally biased toward target)
- **Alpha** (15%): Change transparency
- **Rotation** (5%): Rotate rectangle (if enabled)

### DLAS Algorithm
Dynamic Late Acceptance Search maintains a history of solution qualities and accepts worse solutions if they're better than solutions from L iterations ago, where L is the history length. This provides:
- Better escape from local minima than simulated annealing
- More deterministic behavior than genetic algorithms
- Excellent balance of exploration vs exploitation

### Performance Optimizations
- Offscreen canvas for MSE calculation
- Minimal object allocation in hot paths
- Throttled rendering separate from compute loop
- Efficient pixel-wise difference calculations
- RequestAnimationFrame for smooth UI updates

## Browser Compatibility

Requires a modern browser with:
- HTML5 Canvas API
- ES6+ JavaScript
- FileReader API
- Chart.js (loaded via CDN)

Tested on:
- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

## License

MIT License - feel free to use and modify as needed.
