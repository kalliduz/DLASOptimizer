const EPS = 1e-12;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const randi = (n) => Math.floor(Math.random() * n);
const rand = (a, b) => a + Math.random() * (b - a);

const state = {
  id: 0,
  running: false,
  settings: null,
  rects: [],
  bestRects: [],
  evalTargetData: null,
  evalRenderData: null,
  evalW: 0,
  evalH: 0,
  bg: [0, 0, 0],
  mse: Infinity,
  bestMse: Infinity,
  currentErrSum: Infinity,
  iterations: 0,
  accepted: 0,
  worseAccepted: 0,
  dlasHistory: [],
  dlasIndex: 0,
  dlasMax: Infinity,
  dlasMaxCount: 0,
  mutationStrength: 1,
  lastReport: 0,
};

const evalCanvas = new OffscreenCanvas(1, 1);
const evalCtx = evalCanvas.getContext("2d", { willReadFrequently: true });
const patchCanvas = new OffscreenCanvas(1, 1);
const patchCtx = patchCanvas.getContext("2d", { willReadFrequently: true });

function almostEqual(a, b) { return Math.abs(a - b) <= EPS; }
function mseFromErrSum(errSum) { return errSum / (state.evalW * state.evalH * 3); }

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

function scoreErrSum(renderData, targetData) {
  let err = 0;
  for (let i = 0; i < targetData.length; i += 4) {
    const dr = renderData[i] - targetData[i];
    const dg = renderData[i + 1] - targetData[i + 1];
    const db = renderData[i + 2] - targetData[i + 2];
    err += dr * dr + dg * dg + db * db;
  }
  return err;
}

function rectAabb(rect) {
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  if (!rect.angle) return { x0: rect.x - hw, y0: rect.y - hh, x1: rect.x + hw, y1: rect.y + hh };
  const c = Math.abs(Math.cos(rect.angle));
  const s = Math.abs(Math.sin(rect.angle));
  const ex = c * hw + s * hh;
  const ey = s * hw + c * hh;
  return { x0: rect.x - ex, y0: rect.y - ey, x1: rect.x + ex, y1: rect.y + ey };
}

function mergeDirtyRegion(a, b) {
  const x0 = clamp(Math.floor(Math.min(a.x0, b.x0)), 0, state.evalW - 1);
  const y0 = clamp(Math.floor(Math.min(a.y0, b.y0)), 0, state.evalH - 1);
  const x1 = clamp(Math.ceil(Math.max(a.x1, b.x1)), 0, state.evalW);
  const y1 = clamp(Math.ceil(Math.max(a.y1, b.y1)), 0, state.evalH);
  return { x0, y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function intersectsRegion(rect, region) {
  const b = rectAabb(rect);
  return !(b.x1 < region.x0 || b.x0 > region.x0 + region.w || b.y1 < region.y0 || b.y0 > region.y0 + region.h);
}

function renderRegion(rects, region) {
  patchCanvas.width = region.w;
  patchCanvas.height = region.h;
  patchCtx.clearRect(0, 0, region.w, region.h);
  patchCtx.fillStyle = `rgb(${state.bg[0]},${state.bg[1]},${state.bg[2]})`;
  patchCtx.fillRect(0, 0, region.w, region.h);
  for (const rect of rects) {
    if (!intersectsRegion(rect, region)) continue;
    patchCtx.save();
    patchCtx.translate(rect.x - region.x0, rect.y - region.y0);
    if (rect.angle) patchCtx.rotate(rect.angle);
    patchCtx.fillStyle = `rgba(${rect.r},${rect.g},${rect.b},${rect.a})`;
    patchCtx.fillRect(-rect.w / 2, -rect.h / 2, rect.w, rect.h);
    patchCtx.restore();
  }
  return patchCtx.getImageData(0, 0, region.w, region.h).data;
}

function evalMutationDelta(oldRect, newRect) {
  const region = mergeDirtyRegion(rectAabb(oldRect), rectAabb(newRect));
  const patchData = renderRegion(state.rects, region);
  let oldErr = 0;
  let newErr = 0;
  for (let y = 0; y < region.h; y++) {
    let rowBase = ((region.y0 + y) * state.evalW + region.x0) * 4;
    let patchBase = y * region.w * 4;
    for (let x = 0; x < region.w; x++) {
      const i = rowBase + x * 4;
      const p = patchBase + x * 4;
      const odr = state.evalRenderData[i] - state.evalTargetData[i];
      const odg = state.evalRenderData[i + 1] - state.evalTargetData[i + 1];
      const odb = state.evalRenderData[i + 2] - state.evalTargetData[i + 2];
      oldErr += odr * odr + odg * odg + odb * odb;
      const ndr = patchData[p] - state.evalTargetData[i];
      const ndg = patchData[p + 1] - state.evalTargetData[i + 1];
      const ndb = patchData[p + 2] - state.evalTargetData[i + 2];
      newErr += ndr * ndr + ndg * ndg + ndb * ndb;
    }
  }
  return { nextErrSum: state.currentErrSum - oldErr + newErr, region, patchData };
}

function applyPatchToEvalData(region, patchData) {
  for (let y = 0; y < region.h; y++) {
    const dstBase = ((region.y0 + y) * state.evalW + region.x0) * 4;
    const srcBase = y * region.w * 4;
    state.evalRenderData.set(patchData.subarray(srcBase, srcBase + region.w * 4), dstBase);
  }
}

function randomRect(smart = false) {
  const settings = state.settings;
  let x = rand(0, state.evalW), y = rand(0, state.evalH);
  if (smart && state.rects.length > 0) {
    let best = null;
    const currentData = state.evalRenderData;
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

function mutateRect(rect) {
  const settings = state.settings;
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
    Object.assign(next, randomRect(false));
  } else {
    next.angle += rand(-0.6, 0.6) * s;
  }
  return next;
}

function recalcDlasMax() {
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < state.dlasHistory.length; i++) {
    const v = state.dlasHistory[i];
    if (v > max) { max = v; count = 1; }
    else if (almostEqual(v, max)) count++;
  }
  state.dlasMax = max;
  state.dlasMaxCount = count;
}

function replaceDlasHistory(index, value) {
  const old = state.dlasHistory[index];
  if (almostEqual(old, value)) return;
  if (almostEqual(old, state.dlasMax)) state.dlasMaxCount--;
  state.dlasHistory[index] = value;
  if (value > state.dlasMax) { state.dlasMax = value; state.dlasMaxCount = 1; return; }
  if (almostEqual(value, state.dlasMax)) { state.dlasMaxCount++; return; }
  if (state.dlasMaxCount <= 0) recalcDlasMax();
}

function evaluateCurrent() {
  drawScene(evalCtx, state.rects, state.evalW, state.evalH);
  state.evalRenderData = evalCtx.getImageData(0, 0, state.evalW, state.evalH).data;
  state.currentErrSum = scoreErrSum(state.evalRenderData, state.evalTargetData);
  state.mse = mseFromErrSum(state.currentErrSum);
  state.bestMse = state.mse;
}

function resetOptimizer() {
  const settings = state.settings;
  state.rects = [];
  state.mutationStrength = settings.mutationStrength;
  evalCanvas.width = state.evalW;
  evalCanvas.height = state.evalH;
  drawScene(evalCtx, [], state.evalW, state.evalH);
  state.evalRenderData = evalCtx.getImageData(0, 0, state.evalW, state.evalH).data;

  for (let i = 0; i < settings.rectCount; i++) {
    state.rects.push(randomRect(settings.smartInit));
    if (settings.smartInit && i % 8 === 0) {
      drawScene(evalCtx, state.rects, state.evalW, state.evalH);
      state.evalRenderData = evalCtx.getImageData(0, 0, state.evalW, state.evalH).data;
    }
  }

  evaluateCurrent();
  state.bestRects = state.rects.map((r) => ({ ...r }));
  state.iterations = 0;
  state.accepted = 0;
  state.worseAccepted = 0;
  state.dlasHistory = new Array(settings.dlasHistory).fill(state.mse);
  state.dlasIndex = 0;
  state.dlasMax = state.mse;
  state.dlasMaxCount = state.dlasHistory.length;
}

function optimizationSlice() {
  if (!state.running) return;
  const settings = state.settings;
  const frameStart = performance.now();
  for (let outer = 0; outer < settings.mutPerIter; outer++) {
    if (performance.now() - frameStart > settings.computeBudget) break;
    const idx = randi(state.rects.length);
    const old = state.rects[idx];
    const next = mutateRect(old);
    state.rects[idx] = next;

    const delta = evalMutationDelta(old, next);
    const candMse = mseFromErrSum(delta.nextErrSum);
    const prevMse = state.mse;
    const accept = almostEqual(candMse, prevMse) || candMse < state.dlasMax;
    state.iterations++;

    if (accept) {
      if (candMse > state.mse) state.worseAccepted++;
      state.mse = candMse;
      state.currentErrSum = delta.nextErrSum;
      applyPatchToEvalData(delta.region, delta.patchData);
      state.accepted++;
      if (candMse < state.bestMse) {
        state.bestMse = candMse;
        state.bestRects = state.rects.map((r) => ({ ...r }));
      }
    } else {
      state.rects[idx] = old;
    }

    const historyValue = state.dlasHistory[state.dlasIndex];
    const shouldReplace = state.mse > historyValue || (state.mse < historyValue && state.mse + EPS < prevMse);
    if (shouldReplace) replaceDlasHistory(state.dlasIndex, state.mse);
    state.dlasIndex = (state.dlasIndex + 1) % state.dlasHistory.length;
  }

  if (settings.autoAdapt && state.iterations > 40) {
    const acceptance = state.accepted / Math.max(1, state.iterations);
    if (acceptance < 0.08) state.mutationStrength = clamp(state.mutationStrength * 0.97, 0.08, 5);
    else if (acceptance > 0.45) state.mutationStrength = clamp(state.mutationStrength * 1.03, 0.08, 5);
  }

  const now = performance.now();
  if (now - state.lastReport > 120) {
    state.lastReport = now;
    postMessage({
      type: 'stats',
      id: state.id,
      payload: {
        mse: state.mse,
        bestMse: state.bestMse,
        iterations: state.iterations,
        accepted: state.accepted,
        worseAccepted: state.worseAccepted,
        rects: state.rects,
        bestRects: state.bestRects,
      },
    });
  }
  setTimeout(optimizationSlice, 0);
}

onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    state.id = msg.id;
    const payload = msg.payload;
    state.settings = payload.settings;
    state.evalW = payload.evalW;
    state.evalH = payload.evalH;
    state.bg = payload.bg;
    state.evalTargetData = payload.targetData;
    resetOptimizer();
  } else if (msg.type === 'start') {
    state.running = true;
    optimizationSlice();
  } else if (msg.type === 'stop') {
    state.running = false;
  }
};
