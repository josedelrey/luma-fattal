'use strict';
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');
const secured = path => `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
$('logo-image').src = secured('/assets/logo-purple.png');
$('title-logo').src = secured('/assets/app-icon.png');
for (const [surface, filename] of Object.entries({body: 'viscera', controls: 'panel-078-red', previews: 'panel-078-red'})) {
  document.documentElement.style.setProperty(`--${surface}-texture`, `url('${secured(`/assets/${filename}.png`)}')`);
}
document.documentElement.style.setProperty('--monitor-texture', `url('${secured('/assets/panel-078-red.png')}')`);
let config, baseline, presets, upload, originalUrl, resultUrl, busy = false, revision = 0, previewRevision = -1, timer, resultConfig;
const player = $('player');
const fileDialogs = window.desktopFiles;
if (window.desktopWindow) {
  document.documentElement.classList.add('desktop');
  document.querySelector('.video-column').append($('export-panel'));
  $('app-frame-controls').hidden = false;
  $('window-minimize').onclick = () => window.desktopWindow.minimize();
  $('window-close').onclick = () => window.desktopWindow.close();
}
const definitions = [
  ['parameters', 'alpha', 'Alpha / gradient scale', 0.01, 100, 0.01],
  ['parameters', 'beta', 'Beta / detail response', 0, 100, 0.1],
  ['parameters', 'saturation', 'Saturation', 0, 100, 1],
  ['parameters', 'tone_strength', 'Tone strength', 0, 100, 1],
  ['parameters', 'noise', 'Noise', 0, 100, 1],
  ['parameters', 'fade', 'Fade / original blend', 0, 100, 1],
  ['parameters', 'output_gamma', 'Output gamma', 0.1, 5, 0.05],
  ['parameters', 'highlight_compression', 'Highlight compression', 0, 100, 1],
  ['parameters', 'black_level', 'Black level', 0, 100, 1],
  ['parameters', 'white_level', 'White level', 0, 100, 1],
  ['parameters', 'vibrance', 'Vibrance', 0, 100, 1],
  ['numerics', 'shadow_softness', 'Shadow softness', 0, 255, 1],
  ['video', 'denoise', 'Source denoise', 0, 1, 0.05],
  ['video', 'flat_cleanup', 'Flat cleanup', 0, 1, 0.05],
  ['video', 'pre_noise_rms', 'Source noise RMS', 0, 4, 0.05],
  ['video', 'crf', 'CPU quality / CRF', 0, 51, 1],
  ['video', 'nvenc_cq', 'NVIDIA quality / CQ', 0, 51, 1],
];
function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = error; }
async function api(path, options = {}) {
  const response = await fetch(secured(path), options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `Request failed (${response.status})`), {status: response.status});
  }
  return response.json();
}
function formatTime(seconds) { if (!Number.isFinite(seconds)) return '00:00'; return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function setBusy(value) {
  busy = value;
  $('rescan').disabled = value || !upload;
  for (const id of ['process', 'refresh']) $(id).disabled = value || !upload;
  for (const id of ['open-video', 'screen-load', 'presets', 'import-preset', 'filter', 'reset', 'encoder']) $(id).disabled = value;
  document.querySelectorAll('.slider input').forEach(element => element.disabled = value);
}
function changed() {
  revision++;
  $('preview-state').textContent = upload ? 'Settings changed. Preview is out of date.' : 'Five evenly spaced frames:';
  clearTimeout(timer);
  if (upload && $('auto-preview').checked) timer = setTimeout(preview, 700);
}
function buildControls() {
  $('parameters').replaceChildren(); $('advanced').replaceChildren();
  definitions.forEach(([section, key, label, min, max, step], index) => {
    const row = document.createElement('div'); row.className = 'slider';
    const text = document.createElement('label'); text.textContent = label; text.htmlFor = `${section}-${key}-range`;
    const number = document.createElement('input'); number.type = 'number'; number.setAttribute('aria-label', `${label} value`);
    const range = document.createElement('input'); range.type = 'range'; range.id = text.htmlFor; range.setAttribute('aria-label', label);
    for (const input of [number, range]) {
      input.min = min; input.max = max; input.step = step; input.value = config[section][key];
      input.addEventListener('input', () => {
        if (input.value === '' || !input.validity.valid) return;
        const value = Number(input.value);
        config[section][key] = value;
        (input === range ? number : range).value = value;
        changed();
      });
    }
    row.append(text, number, range); $(index < 7 ? 'parameters' : 'advanced').append(row);
  });
  $('filter').value = config.filter; $('encoder').value = config.video.encoder;
}
function loadConfig(value) { config = structuredClone(value); baseline = structuredClone(value); buildControls(); changed(); }
function placeholders() {
  $('frames').replaceChildren();
  for (let index = 0; index < 5; index++) {
    const button = document.createElement('button'); button.className = 'frame'; button.disabled = true;
    button.textContent = String(index + 1).padStart(2, '0'); button.setAttribute('aria-label', `Preview sample ${index + 1}, not generated yet`);
    $('frames').append(button);
  }
}
function showVideo(processed) {
  if (processed && !resultUrl) return;
  player.pause(); player.src = secured(processed ? resultUrl : originalUrl);
  $('original-tab').classList.toggle('active', !processed); $('result-tab').classList.toggle('active', processed);
  $('original-tab').setAttribute('aria-pressed', !processed); $('result-tab').setAttribute('aria-pressed', processed);
}
async function poll(identifier) {
  while (true) {
    const job = await api(`/api/jobs/${identifier}`);
    const progress = $('progress');
    if (job.total) { progress.value = 100 * job.completed / job.total; }
    else progress.removeAttribute('value');
    status(`${job.kind === 'analyze' ? 'ANALYZING' : job.kind === 'preview' ? 'PREVIEW' : 'PROCESSING'} / ${job.completed}${job.total ? ` OF ${job.total}` : ''} FRAMES`);
    if (job.state === 'error') throw new Error(job.error);
    if (job.state === 'done') { progress.value = 100; return job; }
    await new Promise(resolve => setTimeout(resolve, 600));
  }
}
async function start(kind) {
  const response = await api(`/api/${kind}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({upload: upload.upload, config})});
  return poll(response.job);
}
async function preview() {
  if (busy || !upload || previewRevision === revision) return;
  clearTimeout(timer); setBusy(true); $('preview-state').textContent = 'Generating previews…';
  status('PREPARING PREVIEW / first use may compile numerical kernels');
  try {
    const atRevision = revision;
    const job = await start('preview');
    $('frames').replaceChildren();
    job.frames.forEach((frame, index) => {
      const button = document.createElement('button'); button.className = 'frame'; button.setAttribute('aria-label', `Enlarge filtered sample ${index + 1} at ${formatTime(frame.time)}`);
      const img = document.createElement('img'); img.src = secured(frame.url); img.alt = `Filtered frame at ${formatTime(frame.time)}`;
      const label = document.createElement('span'); label.className = 'frame-num'; label.textContent = `${index + 1} / ${formatTime(frame.time)}`;
      button.append(img, label);
      button.onclick = () => { $('large-frame').src = img.src; $('frame-title').textContent = `SAMPLE ${index + 1} / ${formatTime(frame.time)}`; $('lightbox').showModal(); };
      $('frames').append(button);
    });
    previewRevision = atRevision;
    $('preview-state').textContent = 'Current settings / five independent frames';
    status('Preview ready. Click a frame to enlarge.');
  } catch (error) { status(error.message, true); $('preview-state').textContent = 'PREVIEW FAILED / adjust settings and retry'; }
  finally { setBusy(false); }
}
async function loadVideo(file, nextUpload) {
  clearTimeout(timer); setBusy(true); status('COPYING SOURCE TO LOCAL SESSION…'); $('progress').removeAttribute('value');
  try {
    nextUpload ??= await api('/api/upload', {method: 'POST', body: file});
    upload = nextUpload; originalUrl = upload.url; resultUrl = undefined;
    $('result-tab').disabled = true; $('export-panel').hidden = true; $('empty-screen').hidden = true;
    $('signal-name').textContent = file.name; $('file-info').textContent = `${upload.width} × ${upload.height} / ${formatTime(upload.duration)}`;
    resetSpectrum(); showVideo(false); placeholders(); revision++; previewRevision = -1;
    status('Video loaded.'); $('progress').value = 0;
  } catch (error) { status(error.message, true); }
  finally { setBusy(false); }
  if (upload && $('auto-preview').checked) preview();
}
$('open-video').onclick = $('screen-load').onclick = async () => {
  if (!fileDialogs) return $('video-file').click();
  if (busy) return;
  setBusy(true);
  try { const selected = await fileDialogs.open('video'); if (selected) await loadVideo({name: selected.name}, selected.upload); }
  catch (error) { status(error.message, true); }
  finally { setBusy(false); }
};
$('video-file').onchange = async event => {
  const file = event.target.files[0]; if (!file || busy) return;
  await loadVideo(file); event.target.value = '';
};
$('presets').onchange = () => loadConfig(presets[$('presets').value]);
$('reset').onclick = () => loadConfig(baseline);
$('filter').onchange = () => { config.filter = $('filter').value; changed(); };
$('encoder').onchange = () => { config.video.encoder = $('encoder').value; changed(); };
$('auto-preview').onchange = () => { if ($('auto-preview').checked) preview(); else clearTimeout(timer); };
$('import-preset').onclick = async () => {
  if (!fileDialogs) return $('preset-file').click();
  if (busy) return;
  setBusy(true);
  try { const selected = await fileDialogs.open('preset'); if (selected) { loadConfig(selected.config); status(`RECIPE LOADED / ${selected.name}`); } }
  catch (error) { status(error.message, true); }
  finally { setBusy(false); }
};
$('preset-file').onchange = async event => {
  const file = event.target.files[0]; if (!file || busy) return;
  setBusy(true);
  try { const imported = await api('/api/import', {method:'POST', body:await file.text()}); loadConfig(imported); status(`RECIPE LOADED / ${file.name}`); }
  catch (error) { status(error.message, true); }
  finally { setBusy(false); event.target.value = ''; }
};
$('refresh').onclick = () => { previewRevision = -1; preview(); };
$('process').onclick = async () => {
  if (busy || !upload) return;
  clearTimeout(timer); setBusy(true); status('VALIDATING SOURCE / preparing encoder and filter');
  const snapshot = structuredClone(config);
  try {
    const job = await start('process'); resultUrl = job.url; resultConfig = snapshot;
    $('result-tab').disabled = false; $('export-panel').hidden = false;
    $('save-video').href = secured(job.url); $('save-meta').href = secured(job.metadata);
    $('export-info').textContent = `RENDER COMPLETE / ${job.encoder} / SILENT MP4`;
    showVideo(true); status('Processing complete. Play or save the video.');
  } catch (error) { status(error.message, true); }
  finally { setBusy(false); }
};
$('save-config').onclick = async () => {
  if (fileDialogs) {
    try { await fileDialogs.save('config', null, JSON.stringify(resultConfig, null, 2)); }
    catch (error) { status(error.message, true); }
    return;
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(resultConfig, null, 2)], {type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'luma-fattal-config.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
for (const [id, kind] of [['save-video', 'video'], ['save-meta', 'metadata']]) {
  $(id).addEventListener('click', async event => {
    if (!fileDialogs) return;
    event.preventDefault();
    try { await fileDialogs.save(kind, new URL($(id).href).pathname); }
    catch (error) { status(error.message, true); }
  });
}
$('original-tab').onclick = () => { if (originalUrl) showVideo(false); };
$('result-tab').onclick = () => showVideo(true);
$('play').onclick = () => { if (player.paused) player.play().catch(error => status(error.message, true)); else player.pause(); };
$('rewind').onclick = () => { player.currentTime = 0; };
$('mute').onclick = () => { player.muted = !player.muted; $('mute').textContent = player.muted ? 'MUTE' : 'VOL'; };
$('fullscreen').onclick = () => player.requestFullscreen().catch(error => status(error.message, true));
$('seek').oninput = () => { if (Number.isFinite(player.duration)) player.currentTime = player.duration * $('seek').value / 1000; };
player.onloadedmetadata = () => { for (const id of ['play','rewind','seek','mute','fullscreen']) $(id).disabled = false; updateTime(); };
player.ontimeupdate = updateTime;
function updateTime() { $('timecode').textContent = `${formatTime(player.currentTime)} / ${formatTime(player.duration)}`; $('seek').value = Number.isFinite(player.duration) ? player.currentTime / player.duration * 1000 : 0; }
player.onplay = () => $('play').textContent = '❚❚'; player.onpause = () => $('play').textContent = '▶';
player.onerror = () => status('This source codec cannot play in this browser. Preview and processing can still work through FFmpeg.', true);
$('close-preview').onclick = () => $('lightbox').close();
$('lightbox').onclick = event => { if (event.target === $('lightbox')) $('lightbox').close(); };
placeholders();
api('/api/presets').then(value => {
  presets = value;
  Object.keys(value).forEach(name => { const option = document.createElement('option'); option.value = name; option.textContent = name.toUpperCase().replaceAll('-', ' '); $('presets').append(option); });
  $('presets').value = value['fattal-1'] ? 'fattal-1' : Object.keys(value)[0]; loadConfig(value[$('presets').value]);
}).catch(error => status(error.message, true));

const spectrumSize = 32;
const spectrumCanvas = $('signal-chart'), spectrumContext = spectrumCanvas.getContext('2d');
const spectrumImage = document.createElement('canvas');
spectrumImage.width = spectrumCanvas.width; spectrumImage.height = spectrumCanvas.height;
const spectrumImageContext = spectrumImage.getContext('2d');
let spectrumCursorX = null;
const frameCanvas = document.createElement('canvas');
frameCanvas.width = frameCanvas.height = spectrumSize;
const frameContext = frameCanvas.getContext('2d', {willReadFrequently: true});
const cosine = new Float32Array(spectrumSize * spectrumSize);
const sine = new Float32Array(spectrumSize * spectrumSize);
const windowWeights = new Float32Array(spectrumSize);
for (let frequency = 0; frequency < spectrumSize; frequency++) {
  windowWeights[frequency] = .5 - .5 * Math.cos(2 * Math.PI * frequency / (spectrumSize - 1));
  for (let position = 0; position < spectrumSize; position++) {
    const angle = 2 * Math.PI * frequency * position / spectrumSize;
    cosine[frequency * spectrumSize + position] = Math.cos(angle);
    sine[frequency * spectrumSize + position] = Math.sin(angle);
  }
}
const spectrumStops = [[0,0,0],[9,2,3],[30,4,7],[62,8,12],[102,17,20],
  [155,32,29],[210,61,39],[246,114,58],[255,184,102],[255,238,181]];
const spectrumPalette = Array.from({length: 256}, (_, index) => {
  const position = index / 255 * (spectrumStops.length - 1);
  const start = Math.min(spectrumStops.length - 2, Math.floor(position));
  const rgb = spectrumStops[start].map((value, channel) => Math.round(value +
    (spectrumStops[start + 1][channel] - value) * (position - start)));
  return `rgb(${rgb.join(',')})`;
});
let spectrumTimer = null;
const spectrumPlot = {left: 12, top: 20, width: 266, height: 176};
function stopSpectrum() { clearInterval(spectrumTimer); spectrumTimer = null; }
function renderSpectrumCursor() {
  const context = spectrumContext;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.drawImage(spectrumImage, 0, 0);
  if (spectrumCursorX === null) return;
  context.setTransform(2, 0, 0, 2, 0, 0);
  context.strokeStyle = '#ffffff'; context.lineWidth = 1;
  context.setLineDash([3, 3]);
  context.beginPath(); context.moveTo(spectrumCursorX, spectrumPlot.top);
  context.lineTo(spectrumCursorX, spectrumPlot.top + spectrumPlot.height); context.stroke();
  context.setLineDash([]);
}
function drawSpectrum(levels = null) {
  const context = spectrumContext;
  const {left, top, width, height} = spectrumPlot;
  context.setTransform(2, 0, 0, 2, 0, 0);
  context.fillStyle = '#000000'; context.fillRect(0, 0, 290, 220);
  if (levels) {
    const cellWidth = width / spectrumSize, cellHeight = height / spectrumSize;
    for (let y = 0; y < spectrumSize; y++) for (let x = 0; x < spectrumSize; x++) {
      const fx = (x + spectrumSize / 2) % spectrumSize, fy = (y + spectrumSize / 2) % spectrumSize;
      context.fillStyle = spectrumPalette[Math.min(255, Math.round(levels[fy * spectrumSize + fx] * 255))];
      context.fillRect(left + x * cellWidth, top + y * cellHeight, cellWidth + .2, cellHeight + .2);
    }
  } else {
    context.fillStyle = '#180607'; context.fillRect(left, top, width, height);
    context.fillStyle = '#f5ad76'; context.font = '9px monospace';
    context.fillText('AWAITING VIDEO FRAME', 88, 106);
  }
  context.strokeStyle = '#ffffff55'; context.lineWidth = .5;
  for (let index = 0; index <= 4; index++) {
    const x = left + index * width / 4, y = top + index * height / 4;
    context.beginPath(); context.moveTo(x, top); context.lineTo(x, top + height); context.stroke();
    context.beginPath(); context.moveTo(left, y); context.lineTo(left + width, y); context.stroke();
  }
  context.strokeStyle = '#fff8';
  context.beginPath(); context.moveTo(left + width / 2, top); context.lineTo(left + width / 2, top + height); context.stroke();
  context.beginPath(); context.moveTo(left, top + height / 2); context.lineTo(left + width, top + height / 2); context.stroke();
  context.fillStyle = '#f7d989'; context.font = '8px monospace';
  context.fillText('SPATIAL FREQUENCY / LOG POWER', left, 11);
  context.fillText('-π', left, 208); context.fillText('0', left + width / 2 - 2, 208);
  context.fillText('+π', left + width - 13, 208);
  spectrumImageContext.drawImage(spectrumCanvas, 0, 0);
  renderSpectrumCursor();
}
function resetSpectrum() {
  stopSpectrum();
  $('analysis-state').textContent = 'NO SOURCE / WAITING';
  $('signal-readings').textContent = '32×32 SPATIAL FREQUENCY\nLOAD VIDEO TO ACQUIRE FRAME';
  drawSpectrum();
}
function sampleSpectrum() {
  if (player.readyState < 2 || !player.videoWidth || document.hidden) return;
  let rgba;
  try {
    frameContext.drawImage(player, 0, 0, spectrumSize, spectrumSize);
    rgba = frameContext.getImageData(0, 0, spectrumSize, spectrumSize).data;
  } catch (error) { $('analysis-state').textContent = 'FRAME UNAVAILABLE'; return; }
  const count = spectrumSize * spectrumSize, luminance = new Float32Array(count);
  let mean = 0;
  for (let pixel = 0; pixel < count; pixel++) {
    const offset = pixel * 4;
    const value = rgba[offset] * .2126 + rgba[offset + 1] * .7152 + rgba[offset + 2] * .0722;
    luminance[pixel] = value; mean += value;
  }
  mean /= count;
  for (let y = 0; y < spectrumSize; y++) for (let x = 0; x < spectrumSize; x++) {
    const pixel = y * spectrumSize + x;
    luminance[pixel] = (luminance[pixel] - mean) * windowWeights[x] * windowWeights[y];
  }
  const rowReal = new Float32Array(count), rowImaginary = new Float32Array(count);
  for (let y = 0; y < spectrumSize; y++) for (let fx = 0; fx < spectrumSize; fx++) {
    let real = 0, imaginary = 0;
    for (let x = 0; x < spectrumSize; x++) {
      const value = luminance[y * spectrumSize + x], phase = fx * spectrumSize + x;
      real += value * cosine[phase]; imaginary -= value * sine[phase];
    }
    rowReal[y * spectrumSize + fx] = real; rowImaginary[y * spectrumSize + fx] = imaginary;
  }
  const power = new Float32Array(count);
  let peak = 0, low = 0, middle = 0, high = 0, lowCount = 0, middleCount = 0, highCount = 0;
  for (let fy = 0; fy < spectrumSize; fy++) for (let fx = 0; fx < spectrumSize; fx++) {
    let real = 0, imaginary = 0;
    for (let y = 0; y < spectrumSize; y++) {
      const index = y * spectrumSize + fx, phase = fy * spectrumSize + y;
      real += rowReal[index] * cosine[phase] + rowImaginary[index] * sine[phase];
      imaginary += rowImaginary[index] * cosine[phase] - rowReal[index] * sine[phase];
    }
    const magnitude = Math.log1p(Math.hypot(real, imaginary)), index = fy * spectrumSize + fx;
    power[index] = magnitude; peak = Math.max(peak, magnitude);
    const radius = Math.hypot(Math.min(fx, spectrumSize - fx), Math.min(fy, spectrumSize - fy));
    if (radius < 4) { low += magnitude; lowCount++; }
    else if (radius < 10) { middle += magnitude; middleCount++; }
    else { high += magnitude; highCount++; }
  }
  const scale = Math.max(1, peak);
  for (let index = 0; index < count; index++) power[index] = Math.pow(power[index] / scale, 2.2);
  drawSpectrum(power);
  $('analysis-state').textContent = player.paused ? 'FRAME SPECTRUM / HOLD' : 'LIVE SPECTRUM / 3 HZ';
  $('signal-readings').textContent = `FRAME ${player.currentTime.toFixed(2)}s / 32×32 LUMA\nLOW ${(low / lowCount).toFixed(1)}  MID ${(middle / middleCount).toFixed(1)}  HIGH ${(high / highCount).toFixed(1)}`;
}
function startSpectrum() {
  stopSpectrum(); sampleSpectrum();
  spectrumTimer = setInterval(sampleSpectrum, 320);
}
$('rescan').onclick = sampleSpectrum;
spectrumCanvas.addEventListener('pointermove', event => {
  const rect = spectrumCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width * 290;
  const y = (event.clientY - rect.top) / rect.height * 220;
  const next = x >= spectrumPlot.left && x <= spectrumPlot.left + spectrumPlot.width &&
    y >= spectrumPlot.top && y <= spectrumPlot.top + spectrumPlot.height ? x : null;
  if (next === spectrumCursorX) return;
  spectrumCursorX = next;
  renderSpectrumCursor();
}, {passive: true});
spectrumCanvas.addEventListener('pointerleave', () => {
  spectrumCursorX = null;
  renderSpectrumCursor();
});
player.addEventListener('loadeddata', sampleSpectrum);
player.addEventListener('seeked', sampleSpectrum);
player.addEventListener('play', startSpectrum);
player.addEventListener('pause', () => { stopSpectrum(); sampleSpectrum(); });
player.addEventListener('ended', () => { stopSpectrum(); sampleSpectrum(); });
player.addEventListener('emptied', resetSpectrum);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sampleSpectrum(); });
resetSpectrum();
