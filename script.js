// DLAS Image Optimizer - Main Script
class DLASOptimizer {
    constructor() {
        this.init();
    }

    init() {
        // Canvas elements
        this.originalCanvas = document.getElementById('originalCanvas');
        this.approximationCanvas = document.getElementById('approximationCanvas');
        this.diffCanvas = document.getElementById('diffCanvas');
        
        this.originalCtx = this.originalCanvas.getContext('2d', { willReadFrequently: true });
        this.approximationCtx = this.approximationCanvas.getContext('2d');
        this.diffCtx = this.diffCanvas.getContext('2d', { willReadFrequently: true });

        // State
        this.image = null;
        this.imageData = null;
        this.rectangles = [];
        this.bestRectangles = [];
        this.currentMSE = Infinity;
        this.bestMSE = Infinity;
        this.backgroundColor = [255, 255, 255];
        this.isRunning = false;
        this.animationFrameId = null;
        
        // Statistics
        this.iterations = 0;
        this.acceptedMutations = 0;
        this.worseAccepted = 0;
        this.iterationsPerSecond = 0;
        this.lastIterationTime = Date.now();
        this.lastSecondIterations = 0;
        
        // DLAS history
        this.dlasHistory = [];
        
        // Performance
        this.lastRenderTime = 0;
        this.renderInterval = 1000 / 15; // ~15 fps for UI updates
        
        // Chart
        this.mseHistory = [];
        this.maxHistoryPoints = 100;
        this.initChart();
        
        // Bind UI elements
        this.bindControls();
        this.updateAllDisplayValues();
    }

    bindControls() {
        // File upload
        document.getElementById('imageUpload').addEventListener('change', (e) => this.loadImage(e));
        
        // Sliders with live updates
        const sliders = [
            'rectCount', 'minSize', 'maxSize', 'minAlpha', 'maxAlpha',
            'mutations', 'mutationStrength', 'historyLength', 'computeBudget'
        ];
        
        sliders.forEach(id => {
            const slider = document.getElementById(id);
            slider.addEventListener('input', () => this.updateDisplayValue(id));
        });
        
        // Checkboxes
        document.getElementById('showDiffMap').addEventListener('change', (e) => {
            document.getElementById('diffCanvasWrapper').style.display = e.target.checked ? 'block' : 'none';
        });
        
        // Buttons
        document.getElementById('startBtn').addEventListener('click', () => this.start());
        document.getElementById('pauseBtn').addEventListener('click', () => this.pause());
        document.getElementById('resetBtn').addEventListener('click', () => this.reset());
        document.getElementById('exportBtn').addEventListener('click', () => this.exportBest());
    }

    updateDisplayValue(id) {
        const element = document.getElementById(id);
        const valueElement = document.getElementById(id + 'Value');
        let value = element.value;
        
        if (id === 'minAlpha' || id === 'maxAlpha' || id === 'mutationStrength') {
            value = parseFloat(value).toFixed(2);
        }
        
        valueElement.textContent = value;
    }

    updateAllDisplayValues() {
        const ids = [
            'rectCount', 'minSize', 'maxSize', 'minAlpha', 'maxAlpha',
            'mutations', 'mutationStrength', 'historyLength', 'computeBudget'
        ];
        ids.forEach(id => this.updateDisplayValue(id));
    }

    loadImage(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                this.image = img;
                this.prepareImage();
                this.reset();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    prepareImage() {
        // Scale image to max 400px
        let width = this.image.width;
        let height = this.image.height;
        const maxSize = 400;
        
        if (width > maxSize || height > maxSize) {
            if (width > height) {
                height = (height / width) * maxSize;
                width = maxSize;
            } else {
                width = (width / height) * maxSize;
                height = maxSize;
            }
        }
        
        // Set canvas dimensions
        this.originalCanvas.width = width;
        this.originalCanvas.height = height;
        this.approximationCanvas.width = width;
        this.approximationCanvas.height = height;
        this.diffCanvas.width = width;
        this.diffCanvas.height = height;
        
        // Draw original image
        this.originalCtx.drawImage(this.image, 0, 0, width, height);
        this.imageData = this.originalCtx.getImageData(0, 0, width, height);
        
        // Calculate background color
        this.calculateBackgroundColor();
    }

    calculateBackgroundColor() {
        const mode = document.getElementById('backgroundMode').value;
        const pixels = this.imageData.data;
        
        if (mode === 'black') {
            this.backgroundColor = [0, 0, 0];
        } else if (mode === 'white') {
            this.backgroundColor = [255, 255, 255];
        } else if (mode === 'average') {
            let r = 0, g = 0, b = 0, count = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                r += pixels[i];
                g += pixels[i + 1];
                b += pixels[i + 2];
                count++;
            }
            this.backgroundColor = [
                Math.round(r / count),
                Math.round(g / count),
                Math.round(b / count)
            ];
        } else if (mode === 'median') {
            const colors = { r: [], g: [], b: [] };
            for (let i = 0; i < pixels.length; i += 4) {
                colors.r.push(pixels[i]);
                colors.g.push(pixels[i + 1]);
                colors.b.push(pixels[i + 2]);
            }
            colors.r.sort((a, b) => a - b);
            colors.g.sort((a, b) => a - b);
            colors.b.sort((a, b) => a - b);
            const mid = Math.floor(colors.r.length / 2);
            this.backgroundColor = [colors.r[mid], colors.g[mid], colors.b[mid]];
        }
    }

    reset() {
        this.pause();
        
        if (!this.image) return;
        
        // Reset state
        this.iterations = 0;
        this.acceptedMutations = 0;
        this.worseAccepted = 0;
        this.dlasHistory = [];
        this.mseHistory = [];
        
        // Initialize rectangles
        this.initializeRectangles();
        
        // Calculate initial MSE
        this.currentMSE = this.calculateMSE();
        this.bestMSE = this.currentMSE;
        this.bestRectangles = JSON.parse(JSON.stringify(this.rectangles));
        
        // Render
        this.renderApproximation();
        this.updateStats();
        this.updateChart();
        
        document.getElementById('startBtn').disabled = false;
    }

    initializeRectangles() {
        const count = parseInt(document.getElementById('rectCount').value);
        const smartInit = document.getElementById('smartInit').checked;
        
        this.rectangles = [];
        
        if (smartInit && this.imageData) {
            // Smart initialization: place rectangles in high-error regions
            const errorMap = this.calculateErrorMap(this.backgroundColor);
            
            for (let i = 0; i < count; i++) {
                // Sample position based on error distribution
                const pos = this.sampleFromErrorMap(errorMap);
                const color = this.sampleColorFromImage(pos.x, pos.y);
                this.rectangles.push(this.createRectangle(pos.x, pos.y, color));
            }
        } else {
            // Random initialization
            for (let i = 0; i < count; i++) {
                this.rectangles.push(this.createRandomRectangle());
            }
        }
    }

    createRandomRectangle() {
        const width = this.approximationCanvas.width;
        const height = this.approximationCanvas.height;
        const minSize = parseInt(document.getElementById('minSize').value);
        const maxSize = parseInt(document.getElementById('maxSize').value);
        const minAlpha = parseFloat(document.getElementById('minAlpha').value);
        const maxAlpha = parseFloat(document.getElementById('maxAlpha').value);
        const allowRotation = document.getElementById('allowRotation').checked;
        
        return {
            x: Math.random() * width,
            y: Math.random() * height,
            width: minSize + Math.random() * (maxSize - minSize),
            height: minSize + Math.random() * (maxSize - minSize),
            r: Math.floor(Math.random() * 256),
            g: Math.floor(Math.random() * 256),
            b: Math.floor(Math.random() * 256),
            alpha: minAlpha + Math.random() * (maxAlpha - minAlpha),
            angle: allowRotation ? Math.random() * Math.PI * 2 : 0
        };
    }

    createRectangle(x, y, color) {
        const minSize = parseInt(document.getElementById('minSize').value);
        const maxSize = parseInt(document.getElementById('maxSize').value);
        const minAlpha = parseFloat(document.getElementById('minAlpha').value);
        const maxAlpha = parseFloat(document.getElementById('maxAlpha').value);
        const allowRotation = document.getElementById('allowRotation').checked;
        
        return {
            x: x,
            y: y,
            width: minSize + Math.random() * (maxSize - minSize),
            height: minSize + Math.random() * (maxSize - minSize),
            r: color[0],
            g: color[1],
            b: color[2],
            alpha: minAlpha + Math.random() * (maxAlpha - minAlpha),
            angle: allowRotation ? Math.random() * Math.PI * 2 : 0
        };
    }

    calculateErrorMap(bgColor) {
        const width = this.approximationCanvas.width;
        const height = this.approximationCanvas.height;
        const errorMap = new Float32Array(width * height);
        const pixels = this.imageData.data;
        
        for (let i = 0; i < pixels.length; i += 4) {
            const idx = i / 4;
            const dr = pixels[i] - bgColor[0];
            const dg = pixels[i + 1] - bgColor[1];
            const db = pixels[i + 2] - bgColor[2];
            errorMap[idx] = dr * dr + dg * dg + db * db;
        }
        
        return errorMap;
    }

    sampleFromErrorMap(errorMap) {
        const width = this.approximationCanvas.width;
        const height = this.approximationCanvas.height;
        
        // Sample proportional to error
        const totalError = errorMap.reduce((sum, e) => sum + e, 0);
        let sample = Math.random() * totalError;
        
        for (let i = 0; i < errorMap.length; i++) {
            sample -= errorMap[i];
            if (sample <= 0) {
                return {
                    x: (i % width) + Math.random(),
                    y: Math.floor(i / width) + Math.random()
                };
            }
        }
        
        return { x: Math.random() * width, y: Math.random() * height };
    }

    sampleColorFromImage(x, y) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const width = this.approximationCanvas.width;
        const idx = (iy * width + ix) * 4;
        const pixels = this.imageData.data;
        
        return [
            pixels[idx] || 128,
            pixels[idx + 1] || 128,
            pixels[idx + 2] || 128
        ];
    }

    start() {
        if (!this.image) {
            alert('Please upload an image first!');
            return;
        }
        
        this.isRunning = true;
        document.getElementById('startBtn').disabled = true;
        document.getElementById('pauseBtn').disabled = false;
        document.getElementById('activityIndicator').classList.remove('idle');
        
        this.lastIterationTime = Date.now();
        this.lastSecondIterations = 0;
        
        this.optimizationLoop();
    }

    pause() {
        this.isRunning = false;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        document.getElementById('startBtn').disabled = false;
        document.getElementById('pauseBtn').disabled = true;
        document.getElementById('activityIndicator').classList.add('idle');
    }

    optimizationLoop() {
        if (!this.isRunning) return;
        
        const startTime = performance.now();
        const budget = parseInt(document.getElementById('computeBudget').value);
        
        // Run iterations until budget is exhausted
        while (performance.now() - startTime < budget) {
            this.iterate();
        }
        
        // Update UI at throttled rate
        const now = performance.now();
        if (now - this.lastRenderTime > this.renderInterval) {
            this.renderApproximation();
            this.updateStats();
            this.lastRenderTime = now;
        }
        
        this.animationFrameId = requestAnimationFrame(() => this.optimizationLoop());
    }

    iterate() {
        const mutationsPerIter = parseInt(document.getElementById('mutations').value);
        
        for (let i = 0; i < mutationsPerIter; i++) {
            this.mutateSingleRectangle();
        }
        
        this.iterations++;
        this.lastSecondIterations++;
        
        // Update iterations per second
        const now = Date.now();
        if (now - this.lastIterationTime >= 1000) {
            this.iterationsPerSecond = this.lastSecondIterations;
            this.lastSecondIterations = 0;
            this.lastIterationTime = now;
        }
        
        // Auto-adapt mutation strength
        if (document.getElementById('autoAdapt').checked && this.iterations % 100 === 0) {
            this.adaptMutationStrength();
        }
    }

    mutateSingleRectangle() {
        // Select random rectangle
        const idx = Math.floor(Math.random() * this.rectangles.length);
        const rect = this.rectangles[idx];
        
        // Save old state
        const oldRect = { ...rect };
        
        // Mutate
        this.mutateRectangle(rect);
        
        // Calculate new MSE
        const newMSE = this.calculateMSE();
        
        // DLAS acceptance criterion
        const historyLength = parseInt(document.getElementById('historyLength').value);
        let accept = false;
        
        if (newMSE < this.currentMSE) {
            // Better solution - always accept
            accept = true;
        } else {
            // Worse solution - check DLAS history
            if (this.dlasHistory.length < historyLength) {
                accept = true; // Accept during warmup
            } else {
                const compareValue = this.dlasHistory[this.dlasHistory.length - historyLength];
                if (newMSE <= compareValue) {
                    accept = true;
                    this.worseAccepted++;
                }
            }
        }
        
        if (accept) {
            this.currentMSE = newMSE;
            this.acceptedMutations++;
            
            // Update history
            this.dlasHistory.push(newMSE);
            if (this.dlasHistory.length > historyLength * 2) {
                this.dlasHistory.shift();
            }
            
            // Check if best
            if (newMSE < this.bestMSE) {
                this.bestMSE = newMSE;
                this.bestRectangles = JSON.parse(JSON.stringify(this.rectangles));
                this.mseHistory.push({ iteration: this.iterations, mse: this.bestMSE });
                if (this.mseHistory.length > this.maxHistoryPoints) {
                    this.mseHistory.shift();
                }
                if (this.iterations % 10 === 0) {
                    this.updateChart();
                }
            }
        } else {
            // Reject - restore old state
            Object.assign(rect, oldRect);
        }
    }

    mutateRectangle(rect) {
        const width = this.approximationCanvas.width;
        const height = this.approximationCanvas.height;
        const strength = parseFloat(document.getElementById('mutationStrength').value);
        const minSize = parseInt(document.getElementById('minSize').value);
        const maxSize = parseInt(document.getElementById('maxSize').value);
        const minAlpha = parseFloat(document.getElementById('minAlpha').value);
        const maxAlpha = parseFloat(document.getElementById('maxAlpha').value);
        const colorFromTarget = document.getElementById('colorFromTarget').checked;
        const allowRotation = document.getElementById('allowRotation').checked;
        
        // Choose what to mutate
        const mutationType = Math.random();
        
        if (mutationType < 0.3) {
            // Position
            rect.x += (Math.random() - 0.5) * width * strength;
            rect.y += (Math.random() - 0.5) * height * strength;
            rect.x = Math.max(0, Math.min(width, rect.x));
            rect.y = Math.max(0, Math.min(height, rect.y));
        } else if (mutationType < 0.5) {
            // Size
            rect.width += (Math.random() - 0.5) * maxSize * strength;
            rect.height += (Math.random() - 0.5) * maxSize * strength;
            rect.width = Math.max(minSize, Math.min(maxSize, rect.width));
            rect.height = Math.max(minSize, Math.min(maxSize, rect.height));
        } else if (mutationType < 0.8) {
            // Color
            if (colorFromTarget && this.imageData) {
                const targetColor = this.sampleColorFromImage(rect.x, rect.y);
                rect.r = Math.max(0, Math.min(255, targetColor[0] + (Math.random() - 0.5) * 100 * strength));
                rect.g = Math.max(0, Math.min(255, targetColor[1] + (Math.random() - 0.5) * 100 * strength));
                rect.b = Math.max(0, Math.min(255, targetColor[2] + (Math.random() - 0.5) * 100 * strength));
            } else {
                rect.r = Math.max(0, Math.min(255, rect.r + (Math.random() - 0.5) * 100 * strength));
                rect.g = Math.max(0, Math.min(255, rect.g + (Math.random() - 0.5) * 100 * strength));
                rect.b = Math.max(0, Math.min(255, rect.b + (Math.random() - 0.5) * 100 * strength));
            }
        } else if (mutationType < 0.95) {
            // Alpha
            rect.alpha += (Math.random() - 0.5) * (maxAlpha - minAlpha) * strength;
            rect.alpha = Math.max(minAlpha, Math.min(maxAlpha, rect.alpha));
        } else if (allowRotation) {
            // Rotation
            rect.angle += (Math.random() - 0.5) * Math.PI * strength;
            rect.angle = rect.angle % (Math.PI * 2);
        }
    }

    adaptMutationStrength() {
        const acceptRate = this.acceptedMutations / this.iterations;
        const targetRate = 0.3; // Target 30% acceptance
        const currentStrength = parseFloat(document.getElementById('mutationStrength').value);
        
        let newStrength = currentStrength;
        if (acceptRate < targetRate) {
            newStrength *= 0.95; // Decrease strength
        } else {
            newStrength *= 1.05; // Increase strength
        }
        
        newStrength = Math.max(0.01, Math.min(1, newStrength));
        document.getElementById('mutationStrength').value = newStrength;
        this.updateDisplayValue('mutationStrength');
    }

    calculateMSE() {
        // Render current state to offscreen canvas
        const offCanvas = document.createElement('canvas');
        offCanvas.width = this.approximationCanvas.width;
        offCanvas.height = this.approximationCanvas.height;
        const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
        
        // Fill background
        offCtx.fillStyle = `rgb(${this.backgroundColor[0]}, ${this.backgroundColor[1]}, ${this.backgroundColor[2]})`;
        offCtx.fillRect(0, 0, offCanvas.width, offCanvas.height);
        
        // Draw rectangles
        this.rectangles.forEach(rect => {
            offCtx.save();
            offCtx.translate(rect.x, rect.y);
            offCtx.rotate(rect.angle);
            offCtx.fillStyle = `rgba(${Math.round(rect.r)}, ${Math.round(rect.g)}, ${Math.round(rect.b)}, ${rect.alpha})`;
            offCtx.fillRect(-rect.width / 2, -rect.height / 2, rect.width, rect.height);
            offCtx.restore();
        });
        
        // Calculate MSE
        const approxData = offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height);
        const originalPixels = this.imageData.data;
        const approxPixels = approxData.data;
        
        let mse = 0;
        for (let i = 0; i < originalPixels.length; i += 4) {
            const dr = originalPixels[i] - approxPixels[i];
            const dg = originalPixels[i + 1] - approxPixels[i + 1];
            const db = originalPixels[i + 2] - approxPixels[i + 2];
            mse += dr * dr + dg * dg + db * db;
        }
        
        return mse / (originalPixels.length / 4);
    }

    renderApproximation() {
        const ctx = this.approximationCtx;
        
        // Fill background
        ctx.fillStyle = `rgb(${this.backgroundColor[0]}, ${this.backgroundColor[1]}, ${this.backgroundColor[2]})`;
        ctx.fillRect(0, 0, this.approximationCanvas.width, this.approximationCanvas.height);
        
        // Draw rectangles
        this.rectangles.forEach(rect => {
            ctx.save();
            ctx.translate(rect.x, rect.y);
            ctx.rotate(rect.angle);
            ctx.fillStyle = `rgba(${Math.round(rect.r)}, ${Math.round(rect.g)}, ${Math.round(rect.b)}, ${rect.alpha})`;
            ctx.fillRect(-rect.width / 2, -rect.height / 2, rect.width, rect.height);
            ctx.restore();
        });
        
        // Update diff map if enabled
        if (document.getElementById('showDiffMap').checked) {
            this.renderDiffMap();
        }
    }

    renderDiffMap() {
        const approxData = this.approximationCtx.getImageData(0, 0, this.approximationCanvas.width, this.approximationCanvas.height);
        const originalPixels = this.imageData.data;
        const approxPixels = approxData.data;
        const diffData = this.diffCtx.createImageData(this.diffCanvas.width, this.diffCanvas.height);
        
        for (let i = 0; i < originalPixels.length; i += 4) {
            const dr = Math.abs(originalPixels[i] - approxPixels[i]);
            const dg = Math.abs(originalPixels[i + 1] - approxPixels[i + 1]);
            const db = Math.abs(originalPixels[i + 2] - approxPixels[i + 2]);
            const diff = (dr + dg + db) / 3;
            
            // Amplify by 4x for visibility
            const amplified = Math.min(255, diff * 4);
            
            diffData.data[i] = amplified;
            diffData.data[i + 1] = amplified;
            diffData.data[i + 2] = amplified;
            diffData.data[i + 3] = 255;
        }
        
        this.diffCtx.putImageData(diffData, 0, 0);
    }

    updateStats() {
        document.getElementById('statIterations').textContent = this.iterations.toLocaleString();
        document.getElementById('statIterPerSec').textContent = this.iterationsPerSecond.toLocaleString();
        document.getElementById('statCurrentMSE').textContent = this.currentMSE.toFixed(2);
        document.getElementById('statBestMSE').textContent = this.bestMSE.toFixed(2);
        
        // Calculate similarity percentage (0 = identical, higher = more different)
        // Max possible MSE for RGB is 3 * 255^2 = 195075
        const similarity = Math.max(0, 100 - (this.bestMSE / 1950.75));
        document.getElementById('statSimilarity').textContent = similarity.toFixed(2) + '%';
        
        const acceptRate = this.iterations > 0 ? (this.acceptedMutations / (this.iterations * parseInt(document.getElementById('mutations').value))) * 100 : 0;
        document.getElementById('statAcceptRate').textContent = acceptRate.toFixed(1) + '%';
        
        document.getElementById('statWorseAccepted').textContent = this.worseAccepted.toLocaleString();
        
        const currentStrength = parseFloat(document.getElementById('mutationStrength').value);
        document.getElementById('statMutationStrength').textContent = currentStrength.toFixed(2);
    }

    initChart() {
        this.chartCanvas = document.getElementById('mseChart');
        this.chartCtx = this.chartCanvas.getContext('2d');
        
        // Set canvas size
        this.chartCanvas.width = this.chartCanvas.offsetWidth;
        this.chartCanvas.height = 300;
    }

    updateChart() {
        if (!this.chartCanvas || this.mseHistory.length === 0) return;
        
        const ctx = this.chartCtx;
        const width = this.chartCanvas.width;
        const height = this.chartCanvas.height;
        const padding = 40;
        
        // Clear canvas
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        
        // Calculate bounds
        const minIter = Math.min(...this.mseHistory.map(p => p.iteration));
        const maxIter = Math.max(...this.mseHistory.map(p => p.iteration));
        const minMSE = Math.min(...this.mseHistory.map(p => p.mse));
        const maxMSE = Math.max(...this.mseHistory.map(p => p.mse));
        
        const iterRange = maxIter - minIter || 1;
        const mseRange = maxMSE - minMSE || 1;
        
        // Draw axes
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padding, padding);
        ctx.lineTo(padding, height - padding);
        ctx.lineTo(width - padding, height - padding);
        ctx.stroke();
        
        // Draw grid lines
        ctx.strokeStyle = '#f0f0f0';
        ctx.lineWidth = 1;
        for (let i = 1; i < 5; i++) {
            const y = padding + (height - 2 * padding) * i / 5;
            ctx.beginPath();
            ctx.moveTo(padding, y);
            ctx.lineTo(width - padding, y);
            ctx.stroke();
        }
        
        // Draw data line
        if (this.mseHistory.length > 1) {
            ctx.strokeStyle = '#667eea';
            ctx.lineWidth = 2;
            ctx.beginPath();
            
            this.mseHistory.forEach((point, i) => {
                const x = padding + ((point.iteration - minIter) / iterRange) * (width - 2 * padding);
                const y = height - padding - ((point.mse - minMSE) / mseRange) * (height - 2 * padding);
                
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });
            
            ctx.stroke();
        }
        
        // Draw labels
        ctx.fillStyle = '#666';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Iteration', width / 2, height - 10);
        
        ctx.save();
        ctx.translate(15, height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('Best MSE', 0, 0);
        ctx.restore();
        
        // Draw min/max values
        ctx.textAlign = 'right';
        ctx.fillText(maxMSE.toFixed(1), padding - 5, padding + 5);
        ctx.fillText(minMSE.toFixed(1), padding - 5, height - padding + 5);
    }

    exportBest() {
        if (this.bestRectangles.length === 0) {
            alert('No approximation to export yet!');
            return;
        }
        
        // Render best approximation to a canvas
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = this.approximationCanvas.width;
        exportCanvas.height = this.approximationCanvas.height;
        const ctx = exportCanvas.getContext('2d');
        
        // Fill background
        ctx.fillStyle = `rgb(${this.backgroundColor[0]}, ${this.backgroundColor[1]}, ${this.backgroundColor[2]})`;
        ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
        
        // Draw best rectangles
        this.bestRectangles.forEach(rect => {
            ctx.save();
            ctx.translate(rect.x, rect.y);
            ctx.rotate(rect.angle);
            ctx.fillStyle = `rgba(${Math.round(rect.r)}, ${Math.round(rect.g)}, ${Math.round(rect.b)}, ${rect.alpha})`;
            ctx.fillRect(-rect.width / 2, -rect.height / 2, rect.width, rect.height);
            ctx.restore();
        });
        
        // Download
        exportCanvas.toBlob(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `dlas-approximation-${Date.now()}.png`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    window.optimizer = new DLASOptimizer();
});
