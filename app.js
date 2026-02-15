const $ = (id) => document.getElementById(id);
const ui = {
  imageUpload: $("imageUpload"), startBtn: $("startBtn"), pauseBtn: $("pauseBtn"), resetBtn: $("resetBtn"), exportBtn: $("exportBtn"),
  rectCount: $("rectCount"), minSize: $("minSize"), maxSize: $("maxSize"), minAlpha: $("minAlpha"), maxAlpha: $("maxAlpha"),
  mutPerIter: $("mutPerIter"), mutationStrength: $("mutationStrength"), autoAdapt: $("autoAdapt"), dlasHistory: $("dlasHistory"),
  computeBudget: $("computeBudget"), bgMode: $("bgMode"), smartInit: $("smartInit"), colorFromTarget: $("colorFromTarget"),
  allowRotation: $("allowRotation"), showDiff: $("showDiff"), runningDot: $("runningDot"), statsPanel: $("statsPanel")
};

const originalCanvas = $("originalCanvas");
const approxCanvas = $("approxCanvas");
const diffCanvas = $("diffCanvas");
const chartCanvas = $("mseChart");
const octx = originalCanvas.getContext("2d", { willReadFrequently: true });
const actx = approxCanvas.getContext("2d", { willReadFrequently: true });
const dctx = diffCanvas.getContext("2d", { willReadFrequently: true });
const cctx = chartCanvas.getContext("2d");

const evalCanvas = document.createElement("canvas");
const evalCtx = evalCanvas.getContext("2d", { willReadFrequently: true });
const bestCanvas = document.createElement("canvas");
const bestCtx = bestCanvas.getContext("2d");

const state = {
  running: false,
  rects: [],
  bestRects: [],
  targetData: null,
  evalTargetData: null,
  width: 0,
  height: 0,
  evalW: 0,
  evalH: 0,
  bg: [0, 0, 0],
  mse: Infinity,
  bestMse: Infinity,
  iterations: 0,
  accepted: 0,
  worseAccepted: 0,
  acceptWindow: [],
  lastTick: 0,
  chart: [],
  dlasHistory: [],
  dlasIndex: 0,
  mutationStrength: 1,
  lastUiDraw: 0,
  startedAt: 0,
  cachedScaledRects: null,
  rectsVersion: 0,
  chartMin: Infinity,
  chartMax: -Infinity,
  cachedApproxData: null,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const randi = (n) => Math.floor(Math.random() * n);
const rand = (a, b) => a + Math.random() * (b - a);

function readSettings() {
  return {
    rectCount: clamp(parseInt(ui.rectCount.value, 10) || 160, 10, 5000),
    minSize: clamp(parseFloat(ui.minSize.value) || 2, 1, 400),
    maxSize: clamp(parseFloat(ui.maxSize.value) || 20, 1, 400),
    minAlpha: clamp(parseFloat(ui.minAlpha.value) || 0.05, 0, 1),
    maxAlpha: clamp(parseFloat(ui.maxAlpha.value) || 0.4, 0, 1),
    mutPerIter: clamp(parseInt(ui.mutPerIter.value, 10) || 100, 1, 10000),
    mutationStrength: clamp(parseFloat(ui.mutationStrength.value) || 1, 0.1, 4),
    autoAdapt: ui.autoAdapt.checked,
    dlasHistory: clamp(parseInt(ui.dlasHistory.value, 10) || 1000, 5, 50000),
    computeBudget: clamp(parseFloat(ui.computeBudget.value) || 8, 1, 40),
    bgMode: ui.bgMode.value,
    smartInit: ui.smartInit.checked,
    colorFromTarget: ui.colorFromTarget.checked,
    allowRotation: ui.allowRotation.checked,
    showDiff: ui.showDiff.checked,
  };
}

function setCanvasSize(w, h) {
  [originalCanvas, approxCanvas, diffCanvas, bestCanvas].forEach((cv) => { cv.width = w; cv.height = h; });
}

function computeBackground(mode, data) {
  if (mode === "black") return [0, 0, 0];
  if (mode === "white") return [255, 255, 255];
  if (mode === "average") {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    const px = data.length / 4;
    return [Math.round(r / px), Math.round(g / px), Math.round(b / px)];
  }
  const rs = [], gs = [], bs = [];
  for (let i = 0; i < data.length; i += 4) { rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); }
  rs.sort((a, b) => a - b); gs.sort((a, b) => a - b); bs.sort((a, b) => a - b);
  const m = Math.floor(rs.length / 2);
  return [rs[m], gs[m], bs[m]];
}

function drawRect(ctx, rect) {
  ctx.save();
  ctx.translate(rect.x, rect.y);
  if (rect.angle) ctx.rotate(rect.angle);
  ctx.fillStyle = `rgba(${rect.r},${rect.g},${rect.b},${rect.a})`;
  ctx.fillRect(-rect.w / 2, -rect.h / 2, rect.w, rect.h);
  ctx.restore();
}

function drawScene(ctx, rects, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = `rgb(${state.bg[0]},${state.bg[1]},${state.bg[2]})`;
  ctx.fillRect(0, 0, w, h);
  for (const rect of rects) drawRect(ctx, rect);
}

function scoreMse(renderData, targetData) {
  let err = 0;
  for (let i = 0; i < targetData.length; i += 4) {
    const dr = renderData[i] - targetData[i];
    const dg = renderData[i + 1] - targetData[i + 1];
    const db = renderData[i + 2] - targetData[i + 2];
    err += dr * dr + dg * dg + db * db;
  }
  return err / ((targetData.length / 4) * 3);
}

function evaluateCurrent() {
  drawScene(evalCtx, state.rects, state.evalW, state.evalH);
  return scoreMse(evalCtx.getImageData(0, 0, state.evalW, state.evalH).data, state.evalTargetData);
}

function randomRect(settings, smart = false) {
  let x = rand(0, state.evalW), y = rand(0, state.evalH);
  if (smart && state.rects.length > 0) {
    let best = null;
    const currentData = evalCtx.getImageData(0, 0, state.evalW, state.evalH).data;
    for (let i = 0; i < 40; i++) {
      const tx = randi(state.evalW), ty = randi(state.evalH);
      const idx = (ty * state.evalW + tx) * 4;
      const tr = state.evalTargetData[idx], tg = state.evalTargetData[idx + 1], tb = state.evalTargetData[idx + 2];
      const ar = currentData[idx], ag = currentData[idx + 1], ab = currentData[idx + 2];
      const e = Math.abs(tr - ar) + Math.abs(tg - ag) + Math.abs(tb - ab);
      if (!best || e > best.e) best = { tx, ty, e };
    }
    if (best) { x = best.tx; y = best.ty; }
  }
  const minS = Math.min(settings.minSize, settings.maxSize);
  const maxS = Math.max(settings.minSize, settings.maxSize);
  const rect = {
    x, y,
    w: rand(minS, maxS),
    h: rand(minS, maxS),
    r: randi(256), g: randi(256), b: randi(256),
    a: rand(Math.min(settings.minAlpha, settings.maxAlpha), Math.max(settings.minAlpha, settings.maxAlpha)),
    angle: settings.allowRotation ? rand(-Math.PI, Math.PI) : 0,
  };
  if (settings.colorFromTarget) {
    const ix = clamp(Math.round(x), 0, state.evalW - 1);
    const iy = clamp(Math.round(y), 0, state.evalH - 1);
    const idx = (iy * state.evalW + ix) * 4;
    rect.r = state.evalTargetData[idx]; rect.g = state.evalTargetData[idx + 1]; rect.b = state.evalTargetData[idx + 2];
  }
  return rect;
}

function mutateRect(rect, settings) {
  const s = state.mutationStrength;
  const minS = Math.min(settings.minSize, settings.maxSize);
  const maxS = Math.max(settings.minSize, settings.maxSize);
  const minA = Math.min(settings.minAlpha, settings.maxAlpha);
  const maxA = Math.max(settings.minAlpha, settings.maxAlpha);
  const next = { ...rect };
  const mode = randi(6 + (settings.allowRotation ? 1 : 0));
  if (mode === 0) { next.x = clamp(next.x + rand(-20, 20) * s, 0, state.evalW); next.y = clamp(next.y + rand(-20, 20) * s, 0, state.evalH); }
  else if (mode === 1) { next.w = clamp(next.w + rand(-20, 20) * s, minS, maxS); next.h = clamp(next.h + rand(-20, 20) * s, minS, maxS); }
  else if (mode === 2) { next.a = clamp(next.a + rand(-0.25, 0.25) * s, minA, maxA); }
  else if (mode === 3) {
    if (settings.colorFromTarget && Math.random() < 0.8) {
      const ix = clamp(Math.round(next.x), 0, state.evalW - 1);
      const iy = clamp(Math.round(next.y), 0, state.evalH - 1);
      const idx = (iy * state.evalW + ix) * 4;
      next.r = clamp(state.evalTargetData[idx] + rand(-30, 30), 0, 255);
      next.g = clamp(state.evalTargetData[idx + 1] + rand(-30, 30), 0, 255);
      next.b = clamp(state.evalTargetData[idx + 2] + rand(-30, 30), 0, 255);
    } else {
      next.r = clamp(next.r + rand(-70, 70) * s, 0, 255);
      next.g = clamp(next.g + rand(-70, 70) * s, 0, 255);
      next.b = clamp(next.b + rand(-70, 70) * s, 0, 255);
    }
  } else if (mode === 4) {
    next.x = rand(0, state.evalW); next.y = rand(0, state.evalH);
  } else if (mode === 5) {
    Object.assign(next, randomRect(settings, false));
  } else {
    next.angle += rand(-0.6, 0.6) * s;
  }
  return next;
}

function rescaleRectsToDisplay(rects, forceRecalc = false) {
  if (!forceRecalc && state.cachedScaledRects && state.cachedScaledRects.length === rects.length) {
    return state.cachedScaledRects;
  }
  const sx = state.width / state.evalW;
  const sy = state.height / state.evalH;
  state.cachedScaledRects = rects.map((r) => ({ ...r, x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy }));
  return state.cachedScaledRects;
}

function rebuildBestCanvas() {
  const scaled = rescaleRectsToDisplay(state.bestRects, true);
  drawScene(bestCtx, scaled, state.width, state.height);
}

function updateUi(force = false) {
  const now = performance.now();
  if (!force && now - state.lastUiDraw < 65) return;
  state.lastUiDraw = now;

  const scaledRects = rescaleRectsToDisplay(state.rects);
  drawScene(actx, scaledRects, state.width, state.height);
  const showDiff = ui.showDiff.checked;
  diffCanvas.classList.toggle("hidden", !showDiff);
  if (showDiff) {
    if (!state.cachedApproxData || force) {
      state.cachedApproxData = actx.getImageData(0, 0, state.width, state.height).data;
    }
    const approx = state.cachedApproxData;
    const diff = dctx.createImageData(state.width, state.height);
    for (let i = 0; i < diff.data.length; i += 4) {
      diff.data[i] = clamp(Math.abs(state.targetData[i] - approx[i]) * 4, 0, 255);
      diff.data[i + 1] = clamp(Math.abs(state.targetData[i + 1] - approx[i + 1]) * 4, 0, 255);
      diff.data[i + 2] = clamp(Math.abs(state.targetData[i + 2] - approx[i + 2]) * 4, 0, 255);
      diff.data[i + 3] = 255;
    }
    dctx.putImageData(diff, 0, 0);
  }

  const elapsed = (performance.now() - state.startedAt) / 1000;
  const ips = elapsed > 0 ? Math.round(state.iterations / elapsed) : 0;
  const accRate = state.acceptWindow.length ? (state.acceptWindow.reduce((a, b) => a + b, 0) / state.acceptWindow.length) * 100 : 0;
  const sim = Math.max(0, 100 * (1 - state.bestMse / (255 * 255)));
  const stats = {
    Iterations: state.iterations.toLocaleString(),
    "Iterations/sec": ips.toLocaleString(),
    "Current MSE": state.mse.toFixed(2),
    "Best MSE": state.bestMse.toFixed(2),
    "Similarity %": sim.toFixed(2),
    "Acceptance %": accRate.toFixed(2),
    "Worse accepted": state.worseAccepted.toLocaleString(),
    "Mutation strength": state.mutationStrength.toFixed(2),
  };
  ui.statsPanel.innerHTML = Object.entries(stats)
    .map(([k, v]) => `<div class="stat">${k}<br><b>${v}</b></div>`)
    .join("");

  const curMse = state.mse;
  const bestMse = state.bestMse;
  state.chart.push({ cur: curMse, best: bestMse });
  if (state.chart.length > 240) {
    const removed = state.chart.shift();
    if (removed.cur === state.chartMin || removed.cur === state.chartMax || removed.best === state.chartMin || removed.best === state.chartMax) {
      state.chartMin = Infinity;
      state.chartMax = -Infinity;
      state.chart.forEach(p => {
        state.chartMin = Math.min(state.chartMin, p.cur, p.best);
        state.chartMax = Math.max(state.chartMax, p.cur, p.best);
      });
    }
  } else {
    state.chartMin = Math.min(state.chartMin, curMse, bestMse);
    state.chartMax = Math.max(state.chartMax, curMse, bestMse);
  }
  renderChart();
}

function renderChart() {
  const w = chartCanvas.width, h = chartCanvas.height;
  cctx.clearRect(0, 0, w, h);
  cctx.fillStyle = "#0f141f";
  cctx.fillRect(0, 0, w, h);
  if (state.chart.length < 2) return;
  const min = state.chartMin, max = state.chartMax;
  const span = Math.max(1e-6, max - min);
  const drawLine = (key, color) => {
    cctx.strokeStyle = color;
    cctx.lineWidth = 2;
    cctx.beginPath();
    state.chart.forEach((p, i) => {
      const x = (i / (state.chart.length - 1)) * (w - 10) + 5;
      const y = h - 10 - ((p[key] - min) / span) * (h - 20);
      if (i === 0) cctx.moveTo(x, y); else cctx.lineTo(x, y);
    });
    cctx.stroke();
  };
  drawLine("cur", "#69c0ff");
  drawLine("best", "#f6c36b");
}

function resetOptimizer() {
  state.running = false;
  ui.runningDot.className = "dot idle";
  const settings = readSettings();
  state.mutationStrength = settings.mutationStrength;
  state.rects = [];
  state.cachedScaledRects = null;
  state.cachedApproxData = null;
  state.chartMin = Infinity;
  state.chartMax = -Infinity;
  drawScene(evalCtx, [], state.evalW, state.evalH);
  for (let i = 0; i < settings.rectCount; i++) {
    state.rects.push(randomRect(settings, settings.smartInit));
    if (settings.smartInit && i % 8 === 0) drawScene(evalCtx, state.rects, state.evalW, state.evalH);
  }
  state.mse = evaluateCurrent();
  state.bestMse = state.mse;
  state.bestRects = new Array(state.rects.length);
  for (let i = 0; i < state.rects.length; i++) {
    state.bestRects[i] = { ...state.rects[i] };
  }
  state.iterations = 0;
  state.accepted = 0;
  state.worseAccepted = 0;
  state.acceptWindow = [];
  state.chart = [];
  state.dlasHistory = new Array(settings.dlasHistory).fill(state.mse);
  state.dlasIndex = 0;
  state.startedAt = performance.now();
  rebuildBestCanvas();
  updateUi(true);
}

function optimizerStep() {
  if (!state.running) return;
  const settings = readSettings();
  const frameStart = performance.now();
  for (let outer = 0; outer < settings.mutPerIter; outer++) {
    if (performance.now() - frameStart > settings.computeBudget) break;
    const idx = randi(state.rects.length);
    const old = state.rects[idx];
    const next = mutateRect(old, settings);
    state.rects[idx] = next;

    const candMse = evaluateCurrent();
    const dlasThreshold = state.dlasHistory[state.dlasIndex];
    const accept = candMse <= state.mse || candMse <= dlasThreshold;
    state.iterations++;

    if (accept) {
      if (candMse > state.mse) state.worseAccepted++;
      state.mse = candMse;
      state.accepted++;
      state.acceptWindow.push(1);
      if (candMse < state.bestMse) {
        state.bestMse = candMse;
        if (state.bestRects.length !== state.rects.length) {
          state.bestRects = new Array(state.rects.length);
        }
        for (let i = 0; i < state.rects.length; i++) {
          state.bestRects[i] = { ...state.rects[i] };
        }
        rebuildBestCanvas();
      }
      state.cachedScaledRects = null;
      state.cachedApproxData = null;
    } else {
      state.rects[idx] = old;
      state.acceptWindow.push(0);
    }

    state.dlasHistory[state.dlasIndex] = state.mse;
    state.dlasIndex = (state.dlasIndex + 1) % state.dlasHistory.length;
    if (state.acceptWindow.length > 250) state.acceptWindow.shift();
  }

  if (settings.autoAdapt && state.acceptWindow.length > 40) {
    const rate = state.acceptWindow.reduce((a, b) => a + b, 0) / state.acceptWindow.length;
    if (rate < 0.08) state.mutationStrength = clamp(state.mutationStrength * 0.97, 0.08, 5);
    else if (rate > 0.45) state.mutationStrength = clamp(state.mutationStrength * 1.03, 0.08, 5);
  } else {
    state.mutationStrength = settings.mutationStrength;
  }

  updateUi();
  requestAnimationFrame(optimizerStep);
}

async function loadImage(file) {
  const img = new Image();
  img.decoding = "async";
  img.src = URL.createObjectURL(file);
  await img.decode();

  const maxDim = 400;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  state.width = Math.max(1, Math.round(img.width * scale));
  state.height = Math.max(1, Math.round(img.height * scale));

  setCanvasSize(state.width, state.height);
  octx.drawImage(img, 0, 0, state.width, state.height);
  state.targetData = octx.getImageData(0, 0, state.width, state.height).data;

  const evalMax = 128;
  const evalScale = Math.min(1, evalMax / Math.max(state.width, state.height));
  state.evalW = Math.max(8, Math.round(state.width * evalScale));
  state.evalH = Math.max(8, Math.round(state.height * evalScale));
  evalCanvas.width = state.evalW;
  evalCanvas.height = state.evalH;
  evalCtx.drawImage(originalCanvas, 0, 0, state.evalW, state.evalH);
  state.evalTargetData = evalCtx.getImageData(0, 0, state.evalW, state.evalH).data;

  state.bg = computeBackground(readSettings().bgMode, state.targetData);
  resetOptimizer();
  ui.startBtn.disabled = false;
  ui.pauseBtn.disabled = false;
  ui.resetBtn.disabled = false;
  ui.exportBtn.disabled = false;
}

ui.imageUpload.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await loadImage(file);
});
ui.startBtn.addEventListener("click", () => {
  if (!state.targetData) return;
  if (!state.running) {
    state.running = true;
    ui.runningDot.className = "dot running";
    optimizerStep();
  }
});
ui.pauseBtn.addEventListener("click", () => { state.running = false; ui.runningDot.className = "dot idle"; updateUi(true); });
ui.resetBtn.addEventListener("click", () => {
  if (!state.targetData) return;
  state.bg = computeBackground(readSettings().bgMode, state.targetData);
  resetOptimizer();
});
ui.exportBtn.addEventListener("click", () => {
  if (!state.bestRects.length) return;
  const a = document.createElement("a");
  a.download = "dlas-approximation.png";
  a.href = bestCanvas.toDataURL("image/png");
  a.click();
});
ui.showDiff.addEventListener("change", () => updateUi(true));
