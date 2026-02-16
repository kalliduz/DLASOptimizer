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
  acceptWindow: [],
  lastSentBestMse: Infinity,
};

if (typeof OffscreenCanvas === "undefined") {
  throw new Error("OffscreenCanvas is not supported in this environment; the optimizer worker requires OffscreenCanvas.");
}
const evalCanvas = new OffscreenCanvas(1, 1);

function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
    || canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error("WebGL unavailable in worker");

  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, `
    attribute vec2 a_pos;
    uniform vec2 u_resolution;
    uniform vec2 u_translate;
    uniform vec2 u_scale;
    uniform float u_angle;
    uniform vec2 u_offset;
    void main() {
      vec2 p = a_pos * u_scale;
      float c = cos(u_angle);
      float s = sin(u_angle);
      p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
      p += u_translate - u_offset;
      vec2 clip = vec2((p.x / u_resolution.x) * 2.0 - 1.0, 1.0 - (p.y / u_resolution.y) * 2.0);
      gl_Position = vec4(clip, 0.0, 1.0);
    }
  `);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(vs));

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, `
    precision mediump float;
    uniform vec4 u_color;
    void main() { gl_FragColor = u_color; }
  `);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(fs));

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
  gl.useProgram(program);
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uResolution = gl.getUniformLocation(program, "u_resolution");
  const uTranslate = gl.getUniformLocation(program, "u_translate");
  const uScale = gl.getUniformLocation(program, "u_scale");
  const uAngle = gl.getUniformLocation(program, "u_angle");
  const uColor = gl.getUniformLocation(program, "u_color");
  const uOffset = gl.getUniformLocation(program, "u_offset");

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return {
    drawScene(rects, w, h, bg, offsetX = 0, offsetY = 0, region = null) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.useProgram(program);
      gl.uniform2f(uResolution, w, h);
      gl.uniform2f(uOffset, offsetX, offsetY);
      gl.clearColor(bg[0] / 255, bg[1] / 255, bg[2] / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (const rect of rects) {
        if (region && !intersectsRegion(rect, region)) continue;
        gl.uniform2f(uTranslate, rect.x, rect.y);
        gl.uniform2f(uScale, rect.w, rect.h);
        gl.uniform1f(uAngle, rect.angle || 0);
        gl.uniform4f(uColor, rect.r / 255, rect.g / 255, rect.b / 255, rect.a);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    },
    readPixelsTopDown(w, h) {
      const raw = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      const flipped = new Uint8ClampedArray(raw.length);
      const row = w * 4;
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * row;
        const dst = y * row;
        flipped.set(raw.subarray(src, src + row), dst);
      }
      return flipped;
    }
  };
}

const evalRenderer = createRenderer(evalCanvas);

function almostEqual(a, b) { return Math.abs(a - b) <= EPS; }
function mseFromErrSum(errSum) { return errSum / (state.evalW * state.evalH * 3); }

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
  evalRenderer.drawScene(rects, region.w, region.h, state.bg, region.x0, region.y0, region);
  return evalRenderer.readPixelsTopDown(region.w, region.h);
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


function adoptElite(payload) {
  if (!payload || !Array.isArray(payload.rects) || !Array.isArray(payload.bestRects)) return;
  const rects = payload.rects.map((r) => ({ ...r }));
  const bestRects = payload.bestRects.map((r) => ({ ...r }));
  if (!rects.length || rects.length !== bestRects.length) return;
  state.rects = rects;
  state.bestRects = bestRects;
  evalRenderer.drawScene(state.rects, state.evalW, state.evalH, state.bg);
  state.evalRenderData = evalRenderer.readPixelsTopDown(state.evalW, state.evalH);
  state.currentErrSum = scoreErrSum(state.evalRenderData, state.evalTargetData);
  state.mse = mseFromErrSum(state.currentErrSum);
  state.bestMse = Math.min(Number.isFinite(payload.bestMse) ? payload.bestMse : Infinity, state.mse);
  state.dlasHistory = new Array(state.settings.dlasHistory).fill(state.mse);
  state.dlasIndex = 0;
  state.dlasMax = state.mse;
  state.dlasMaxCount = state.dlasHistory.length;
  state.acceptWindow = [];
}

function applyRuntimeSettings(nextSettings) {
  if (!nextSettings) return;
  if (Number.isFinite(nextSettings.mutPerIter)) state.settings.mutPerIter = Math.max(1, Math.floor(nextSettings.mutPerIter));
  if (Number.isFinite(nextSettings.computeBudget)) state.settings.computeBudget = clamp(nextSettings.computeBudget, 0.5, 50);
  if (typeof nextSettings.autoAdapt === 'boolean') state.settings.autoAdapt = nextSettings.autoAdapt;
  if (Number.isFinite(nextSettings.mutationStrength) && !state.settings.autoAdapt) {
    state.mutationStrength = clamp(nextSettings.mutationStrength, 0.08, 5);
  }
  if (Number.isFinite(nextSettings.dlasHistory)) {
    const target = Math.max(5, Math.floor(nextSettings.dlasHistory));
    if (target !== state.settings.dlasHistory) {
      state.settings.dlasHistory = target;
      state.dlasHistory = new Array(target).fill(state.mse);
      state.dlasIndex = 0;
      state.dlasMax = state.mse;
      state.dlasMaxCount = state.dlasHistory.length;
    }
  }
}

function evaluateCurrent() {
  evalRenderer.drawScene(state.rects, state.evalW, state.evalH, state.bg);
  state.evalRenderData = evalRenderer.readPixelsTopDown(state.evalW, state.evalH);
  state.currentErrSum = scoreErrSum(state.evalRenderData, state.evalTargetData);
  state.mse = mseFromErrSum(state.currentErrSum);
  state.bestMse = state.mse;
}

function resetOptimizer() {
  const settings = state.settings;
  state.rects = [];
  state.mutationStrength = settings.mutationStrength;
  evalRenderer.drawScene([], state.evalW, state.evalH, state.bg);
  state.evalRenderData = evalRenderer.readPixelsTopDown(state.evalW, state.evalH);

  for (let i = 0; i < settings.rectCount; i++) {
    state.rects.push(randomRect(settings.smartInit));
    if (settings.smartInit && i % 8 === 0) {
      evalRenderer.drawScene(state.rects, state.evalW, state.evalH, state.bg);
      state.evalRenderData = evalRenderer.readPixelsTopDown(state.evalW, state.evalH);
    }
  }

  evaluateCurrent();
  state.bestRects = state.rects.map((r) => ({ ...r }));
  state.iterations = 0;
  state.accepted = 0;
  state.worseAccepted = 0;
  state.acceptWindow = [];
  state.dlasHistory = new Array(settings.dlasHistory).fill(state.mse);
  state.dlasIndex = 0;
  state.dlasMax = state.mse;
  state.dlasMaxCount = state.dlasHistory.length;
  state.lastSentBestMse = Infinity;
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
    const accept = almostEqual(candMse, prevMse) || candMse <= state.dlasMax + EPS;
    state.iterations++;

    if (accept) {
      if (candMse > state.mse) state.worseAccepted++;
      state.mse = candMse;
      state.currentErrSum = delta.nextErrSum;
      applyPatchToEvalData(delta.region, delta.patchData);
      state.accepted++;
      state.acceptWindow.push(1);
      if (candMse < state.bestMse) {
        state.bestMse = candMse;
        state.bestRects = state.rects.map((r) => ({ ...r }));
      }
    } else {
      state.rects[idx] = old;
      state.acceptWindow.push(0);
    }

    if (state.acceptWindow.length > 250) state.acceptWindow.shift();

    const historyValue = state.dlasHistory[state.dlasIndex];
    const shouldReplace = state.mse > historyValue || (state.mse < historyValue && state.mse + EPS < prevMse);
    if (shouldReplace) replaceDlasHistory(state.dlasIndex, state.mse);
    state.dlasIndex = (state.dlasIndex + 1) % state.dlasHistory.length;
  }

  if (settings.autoAdapt && state.acceptWindow.length > 40) {
    const acceptance = state.acceptWindow.reduce((a, b) => a + b, 0) / state.acceptWindow.length;
    if (acceptance < 0.08) state.mutationStrength = clamp(state.mutationStrength * 0.97, 0.08, 5);
    else if (acceptance > 0.45) state.mutationStrength = clamp(state.mutationStrength * 1.03, 0.08, 5);
  } else if (!settings.autoAdapt) {
    state.mutationStrength = clamp(settings.mutationStrength, 0.08, 5);
  }

  const now = performance.now();
  if (now - state.lastReport > 120) {
    state.lastReport = now;
    const payload = {
      mse: state.mse,
      bestMse: state.bestMse,
      iterations: state.iterations,
      accepted: state.accepted,
      worseAccepted: state.worseAccepted,
      mutationStrength: state.mutationStrength,
    };
    if (state.bestMse + EPS < state.lastSentBestMse) {
      payload.rects = state.rects;
      payload.bestRects = state.bestRects;
      state.lastSentBestMse = state.bestMse;
    }
    postMessage({ type: 'stats', id: state.id, payload });
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
  } else if (msg.type === 'update-settings') {
    applyRuntimeSettings(msg.payload);
  } else if (msg.type === 'inject-elite') {
    adoptElite(msg.payload);
  }
};
