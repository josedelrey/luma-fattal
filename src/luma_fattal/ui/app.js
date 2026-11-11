'use strict';
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');
const secured = path => `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
for (const [family, file, weight] of [
  ['Luma Sans', 'Arimo-Regular.ttf', '400'],
  ['Luma Sans', 'Arimo-Bold.ttf', '700'],
  ['Luma Mono', 'Cousine-Regular.ttf', '400'],
  ['Luma Serif', 'Tinos-Regular.ttf', '400'],
]) {
  const font = new FontFace(family, `url('${secured(`/assets/${file}`)}')`, {weight, display: 'block'});
  document.fonts.add(font);
  font.load().catch(error => status(`Could not load UI font: ${error.message}`, true));
}
$('logo-image').src = secured('/assets/logo-purple.png');
$('title-logo').src = secured('/assets/app-icon.png');
for (const [surface, filename] of Object.entries({body: 'viscera', controls: 'panel-078-red', previews: 'panel-078-red'})) {
  document.documentElement.style.setProperty(`--${surface}-texture`, `url('${secured(`/assets/${filename}.png`)}')`);
}
document.documentElement.style.setProperty('--monitor-texture', `url('${secured('/assets/panel-078-red.png')}')`);
let config, baseline, presets, upload, originalUrl, resultUrl, busy = false, revision = 0, previewRevision = -1, timer, resultConfig, pendingImport;
let previewRun, pendingSubmission = Promise.resolve(), importing = false;
let processJob, stopRequested = false;
const player = $('player');
const fileDialogs = window.desktopFiles;
if (window.desktopWindow) {
  const {width, height} = window.desktopWindow.referenceSize;
  document.documentElement.style.setProperty('--desktop-width', `${width}px`);
  document.documentElement.style.setProperty('--desktop-height', `${height}px`);
  const fitCanvas = () => {
    const scale = Math.min(innerWidth / width, Math.max(0, innerHeight - 44) / (height - 44));
    const left = (innerWidth - width * scale) / 2;
    document.documentElement.style.setProperty('--desktop-scale', scale);
    document.documentElement.style.setProperty('--desktop-left', `${left}px`);
    document.documentElement.style.setProperty('--desktop-export-top', `${44 + 19 * scale}px`);
    document.documentElement.style.setProperty('--desktop-export-right', `${innerWidth - left - (width - 19) * scale}px`);
  };
  window.addEventListener('resize', fitCanvas);
  fitCanvas();
  document.documentElement.classList.add('desktop');
  document.body.append($('export-panel'));
  $('app-frame-controls').hidden = false;
  $('window-minimize').onclick = () => window.desktopWindow.minimize();
  $('window-close').onclick = () => window.desktopWindow.close();
}
const settingsPanel = new ConfigurationPanel($('parameters'), $('advanced'), changed);
function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = error; }
async function api(path, options = {}) {
  const response = await fetch(secured(path), options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `Request failed (${response.status})`), {status: response.status, missingSource: body.missing_source});
  }
  return response.json();
}
function formatTime(seconds) { if (!Number.isFinite(seconds)) return '00:00'; return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function setBusy(value) {
  busy = value;
  if (value) {
    clearTimeout(timer);
    previewRun = undefined;
  }
  $('rescan').disabled = value || !upload;
  for (const id of ['process', 'refresh']) $(id).disabled = value || !upload;
  for (const id of ['open-video', 'screen-load']) $(id).disabled = value;
  for (const id of ['presets', 'import-preset', 'filter', 'reset', 'save-preset']) $(id).disabled = !config;
  settingsPanel.setDisabled(!config);
  if (!value) schedulePreview();
}
function setProcessing(value) {
  document.querySelector('.process-slot').classList.toggle('is-processing', value);
  $('process-metrics').hidden = !value;
  if (value) { $('process-speed').textContent = 'Preparing…'; $('process-eta').textContent = 'ETA —'; $('stop-process').disabled = false; $('stop-process').textContent = 'Stop ■'; }
}
function updateProcessing(job) {
  if (job.kind !== 'process' || job.state !== 'running') return;
  $('process-speed').textContent = Number.isFinite(job.fps) && job.fps > 0 ? `${job.fps.toFixed(2)} frames/s` : 'Preparing…';
  $('process-eta').textContent = job.total && !job.total_estimated && job.completed >= job.total ? 'Finalizing…' :
    Number.isFinite(job.eta) ? `ETA ${job.total_estimated ? '~' : ''}${formatTime(Math.ceil(job.eta))}` : 'ETA —';
}
function schedulePreview(delay = 350) {
  clearTimeout(timer);
  if (!busy && upload && $('auto-preview').checked && previewRevision !== revision) timer = setTimeout(preview, delay);
}
function changed(sliderCommit = false) {
  revision++;
  $('preview-state').textContent = upload ? 'Settings changed. Preview is out of date.' : 'Five evenly spaced frames:';
  schedulePreview(sliderCommit ? 120 : 350);
}
function loadConfig(value, name = $('presets').value) {
  config = structuredClone(value);
  baseline = structuredClone(value);
  settingsPanel.load(config);
  $('filter').value = config.filter;
  $('presets').value = name;
  changed();
}
function loadImported(value, name) {
  let option = $('presets').querySelector('option[value="imported"]');
  if (!option) { option = document.createElement('option'); option.value = 'imported'; $('presets').append(option); }
  option.textContent = name;
  presets.imported = structuredClone(value);
  loadConfig(value, 'imported');
}
let previewFrames = [], selectedFrame = null, previewError = false;
function updateLightbox() {
  if (selectedFrame === null) return;
  const frame = previewFrames[selectedFrame];
  if (!frame) return;
  const image = $('large-frame'), loading = $('preview-loading');
  const url = frame.url;
  image.width = frame.width || upload.width;
  image.height = frame.height || upload.height;
  image.style.setProperty('--sample-width', `${image.width}px`);
  image.style.setProperty('--sample-ratio', image.width / image.height);
  loading.textContent = previewError ? 'PREVIEW FAILED' : 'LOADING...';
  loading.hidden = false;
  image.style.visibility = url ? '' : 'hidden';
  if (!url) { image.removeAttribute('src'); return; }
  const source = secured(url);
  const loaded = () => { loading.hidden = !previewError; };
  image.onload = loaded;
  image.onerror = () => { loading.hidden = false; loading.textContent = 'PREVIEW FAILED'; };
  if (image.getAttribute('src') !== source) image.src = source;
  else if (image.complete && image.naturalWidth) loaded();
}
function updatePreviewFrames(job) {
  if (!job.frames) return;
  previewFrames = job.frames;
  previewFrames.forEach((frame, index) => {
    const button = $('frames').children[index];
    const source = frame.url;
    let image = button.querySelector('img');
    if (source) {
      if (!image) { image = document.createElement('img'); image.alt = `Filtered frame at ${formatTime(frame.time)}`; button.prepend(image); }
      if (image.getAttribute('src') !== secured(source)) image.src = secured(source);
    }
    button.querySelector('.frame-num').textContent = `${index + 1} / ${formatTime(frame.time)}`;
    button.setAttribute('aria-label', `Enlarge filtered sample ${index + 1} at ${formatTime(frame.time)}`);
  });
  if ($('lightbox').open) updateLightbox();
}
function placeholders() {
  selectedFrame = null;
  previewError = false;
  previewFrames = Array.from({length: 5}, (_, index) => ({time: upload ? upload.duration * (index + .5) / 5 : 0}));
  $('frames').replaceChildren();
  for (let index = 0; index < 5; index++) {
    const button = document.createElement('button'); button.className = 'frame'; button.disabled = !upload;
    const label = document.createElement('span'); label.className = 'frame-num'; label.textContent = String(index + 1).padStart(2, '0');
    button.append(label); button.setAttribute('aria-label', `Enlarge preview sample ${index + 1}, loading`);
    button.onclick = () => {
      selectedFrame = index;
      $('frame-title').textContent = `SAMPLE ${index + 1} / ${formatTime(previewFrames[index].time)}`;
      updateLightbox();
      if (!$('lightbox').open) $('lightbox').showModal();
    };
    $('frames').append(button);
  }
}

function showVideo(processed) {
  if (processed && !resultUrl) return;
  player.pause(); player.src = secured(processed ? resultUrl : originalUrl);
  $('original-tab').classList.toggle('active', !processed); $('result-tab').classList.toggle('active', processed);
  $('original-tab').setAttribute('aria-pressed', !processed); $('result-tab').setAttribute('aria-pressed', processed);
}
async function poll(identifier, onUpdate, current) {
  while (current()) {
    const job = await api(`/api/jobs/${identifier}`);
    if (!current() || job.state === 'superseded') return;
    onUpdate?.(job);
    updateProcessing(job);
    const progress = $('progress');
    if (job.total) { progress.value = Math.min(job.total_estimated ? 99 : 100, 100 * job.completed / job.total); }
    else progress.removeAttribute('value');
    status(`${job.kind === 'analyze' ? 'ANALYZING' : job.kind === 'preview' ? 'PREVIEW' : 'PROCESSING'} / ${job.completed}${job.total ? ` OF ${job.total_estimated ? '~' : ''}${job.total}` : ''} FRAMES`);
    if (job.state === 'error') throw new Error(job.error);
    if (job.state === 'cancelled') return job;
    if (job.state === 'cancelling') status('Stopping processing…');
    if (job.state === 'done') { progress.value = 100; return job; }
    await new Promise(resolve => setTimeout(resolve, onUpdate ? 100 : 600));
  }
}
async function start(kind, onUpdate, current = () => true, onSubmitted) {
  $('progress').style.visibility = '';
  const body = JSON.stringify({upload: upload.upload, config});
  // Keep submissions ordered even if an older preview is still waiting for its job ID.
  const submission = pendingSubmission.then(() => current() && api(`/api/${kind}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body,
  }));
  pendingSubmission = submission.catch(() => {});
  const response = await submission;
  if (response) await onSubmitted?.(response.job);
  if (response && current()) return poll(response.job, onUpdate, current);
}
async function preview() {
  if (busy || !upload || previewRevision === revision || previewRun?.revision === revision || !settingsPanel.valid()) return;
  clearTimeout(timer);
  const run = {revision};
  previewRun = run;
  const current = () => previewRun === run && revision === run.revision;
  $('preview-state').textContent = 'Generating previews…';
  status('PREPARING PREVIEW / first use may compile numerical kernels');
  try {
    placeholders();
    const job = await start('preview', updatePreviewFrames, current);
    if (!current() || !job) return;
    previewRevision = run.revision;
    $('preview-state').textContent = 'Current settings / five independent frames';
    status('Preview ready. Click a frame to enlarge.');
  } catch (error) {
    if (!current()) return;
    previewError = true;
    if ($('lightbox').open) updateLightbox();
    status(error.message, true);
    $('preview-state').textContent = 'PREVIEW FAILED / adjust settings and retry';
  } finally {
    if (previewRun === run) previewRun = undefined;
  }
}
async function loadVideo(file, nextUpload) {
  setBusy(true); status('COPYING SOURCE TO LOCAL SESSION…'); $('progress').style.visibility = ''; $('progress').removeAttribute('value');
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
$('presets').onchange = () => { pendingImport = undefined; loadConfig(presets[$('presets').value]); };
$('reset').onclick = () => loadConfig(baseline);
$('filter').onchange = () => { config.filter = $('filter').value; changed(); };
$('auto-preview').onchange = () => { if ($('auto-preview').checked) preview(); else clearTimeout(timer); };
$('import-preset').onclick = async () => {
  if (!fileDialogs) return $('preset-file').click();
  if (importing) return;
  importing = true;
  try { const selected = await fileDialogs.open('preset'); if (selected) { loadImported(selected.config, selected.name); status(`RECIPE LOADED / ${selected.name}`); } }
  catch (error) { status(error.message, true); }
  finally { importing = false; }
};
$('preset-file').onchange = async event => {
  const file = event.target.files[0]; if (!file || importing) return;
  importing = true;
  try {
    pendingImport ??= {filename: file.name, files: {}};
    const name = pendingImport.missingSource || file.name;
    if (file.name !== name.split(/[\\/]/).at(-1)) throw new Error(`Select ${name} to complete this recipe, or cancel the file picker to start over.`);
    pendingImport.files[name] = await file.text();
    const imported = await api('/api/import', {method:'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(pendingImport)});
    loadImported(imported, pendingImport.filename);
    status(`RECIPE LOADED / ${pendingImport.filename}`);
    pendingImport = undefined;
  } catch (error) {
    if (error.missingSource) {
      pendingImport.missingSource = error.missingSource;
      status(`Open… ${error.missingSource} to complete this recipe. Cancel the file picker to start over.`, true);
    } else { pendingImport = undefined; status(error.message, true); }
  }
  finally { importing = false; event.target.value = ''; }
};
$('preset-file').oncancel = () => { pendingImport = undefined; };
$('refresh').onclick = () => { if (!settingsPanel.valid(true)) return; revision++; preview(); };
async function requestStop() {
  if (processJob) await api(`/api/cancel/${processJob}`, {method: 'POST'});
}
$('stop-process').onclick = async () => {
  stopRequested = true;
  $('stop-process').disabled = true; $('stop-process').textContent = 'Stopping…';
  status('Stopping processing…');
  try { await requestStop(); } catch (error) { stopRequested = false; $('stop-process').disabled = false; $('stop-process').textContent = 'Stop ■'; status(error.message, true); }
};
$('process').onclick = async () => {
  if (busy || !upload || !settingsPanel.valid(true)) return;
  setBusy(true); setProcessing(true); $('export-panel').hidden = true; status('VALIDATING SOURCE / preparing encoder and filter');
  const snapshot = structuredClone(config);
  try {
    stopRequested = false; processJob = undefined;
    const job = await start('process', undefined, undefined, async identifier => { processJob = identifier; if (stopRequested) await requestStop(); });
    if (job.state === 'cancelled') { $('progress').style.visibility = 'hidden'; status('Processing cancelled.'); return; }
    resultUrl = job.url; resultConfig = snapshot;
    $('result-tab').disabled = false; $('export-panel').hidden = false;
    $('save-video').href = secured(job.url); $('save-meta').href = secured(job.metadata);
    $('export-info').textContent = `RENDER COMPLETE / ${job.encoder} / SILENT MP4`;
    showVideo(true); $('progress').style.visibility = 'hidden'; status('Processing complete. Play or save the video.');
  } catch (error) { status(error.message, true); }
  finally { processJob = undefined; setProcessing(false); setBusy(false); }
};
$('close-export').onclick = () => { $('export-panel').hidden = true; };
async function saveConfig(value) {
  try {
    const validated = await api('/api/config', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});
    const content = JSON.stringify(validated, null, 2);
    if (fileDialogs) { await fileDialogs.save('config', null, content); return; }
    const url = URL.createObjectURL(new Blob([content], {type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'luma-fattal-config.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { status(error.message, true); }
}
$('save-config').onclick = () => saveConfig(resultConfig);
$('save-preset').onclick = () => { if (config && settingsPanel.valid(true)) saveConfig(config); };
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
$('lightbox').addEventListener('close', () => { selectedFrame = null; });
$('close-preview').onclick = () => $('lightbox').close();
$('lightbox').onclick = event => { if (event.target === $('lightbox')) $('lightbox').close(); };
const previewDialog = $('lightbox'), previewImage = $('large-frame');
new ResizeObserver(() => {
  if (!previewDialog.open) return;
  // Include the title, footer, and border when matching the outer spacing.
  const chrome = previewDialog.offsetHeight - previewImage.offsetHeight;
  const value = `${chrome}px`;
  if (previewDialog.style.getPropertyValue('--preview-chrome') !== value) {
    previewDialog.style.setProperty('--preview-chrome', value);
  }
}).observe(previewDialog);
placeholders();
setBusy(true);
api('/api/presets').then(value => {
  presets = value;
  Object.keys(value).forEach(name => { const option = document.createElement('option'); option.value = name; option.textContent = name.toUpperCase().replaceAll('-', ' '); $('presets').append(option); });
  $('presets').value = value['fattal-1'] ? 'fattal-1' : Object.keys(value)[0]; loadConfig(value[$('presets').value]);
  setBusy(false);
}).catch(error => status(error.message, true));

const spectrumSize = 64;
const spectrumSampleInterval = 125, spectrumDrawInterval = 1000 / 30;
const spectrumCount = spectrumSize * spectrumSize;
const spectrumCanvas = $('signal-chart'), spectrumContext = spectrumCanvas.getContext('2d');
const spectrumImage = document.createElement('canvas');
spectrumImage.width = spectrumCanvas.width; spectrumImage.height = spectrumCanvas.height;
const spectrumImageContext = spectrumImage.getContext('2d');
let spectrumCursorX = null;
const frameCanvas = document.createElement('canvas');
frameCanvas.width = frameCanvas.height = spectrumSize;
const frameContext = frameCanvas.getContext('2d', {willReadFrequently: true});
const spectrumTexture = document.createElement('canvas');
spectrumTexture.width = spectrumTexture.height = spectrumSize;
const spectrumTextureContext = spectrumTexture.getContext('2d');
const spectrumPixels = spectrumTextureContext.createImageData(spectrumSize, spectrumSize);
for (let offset = 3; offset < spectrumPixels.data.length; offset += 4) spectrumPixels.data[offset] = 255;
const cosine = new Float32Array(spectrumSize / 2);
const sine = new Float32Array(spectrumSize / 2);
const reversed = new Uint8Array(spectrumSize);
const windowWeights = new Float32Array(spectrumSize);
for (let index = 0; index < spectrumSize; index++) {
  windowWeights[index] = .5 - .5 * Math.cos(2 * Math.PI * index / (spectrumSize - 1));
  let bits = index, reverse = 0;
  for (let span = spectrumSize; span > 1; span >>= 1) {
    reverse = (reverse << 1) | (bits & 1); bits >>= 1;
  }
  reversed[index] = reverse;
  if (index >= spectrumSize / 2) continue;
  cosine[index] = Math.cos(2 * Math.PI * index / spectrumSize);
  sine[index] = Math.sin(2 * Math.PI * index / spectrumSize);
}
const spectrumReal = new Float32Array(spectrumCount), spectrumImaginary = new Float32Array(spectrumCount);
const spectrumTarget = new Float32Array(spectrumCount), spectrumDisplay = new Float32Array(spectrumCount);
// Apply the same in-place FFT to rows and columns by changing the stride.
function transformSpectrum(offset, stride) {
  for (let index = 0; index < spectrumSize; index++) {
    if (reversed[index] <= index) continue;
    const a = offset + index * stride, b = offset + reversed[index] * stride;
    const real = spectrumReal[a], imaginary = spectrumImaginary[a];
    spectrumReal[a] = spectrumReal[b]; spectrumImaginary[a] = spectrumImaginary[b];
    spectrumReal[b] = real; spectrumImaginary[b] = imaginary;
  }
  for (let span = 2; span <= spectrumSize; span *= 2) {
    const half = span / 2, step = spectrumSize / span;
    for (let start = 0; start < spectrumSize; start += span) for (let index = 0; index < half; index++) {
      const a = offset + (start + index) * stride, b = a + half * stride;
      const phase = index * step;
      const real = spectrumReal[b] * cosine[phase] + spectrumImaginary[b] * sine[phase];
      const imaginary = spectrumImaginary[b] * cosine[phase] - spectrumReal[b] * sine[phase];
      spectrumReal[b] = spectrumReal[a] - real; spectrumImaginary[b] = spectrumImaginary[a] - imaginary;
      spectrumReal[a] += real; spectrumImaginary[a] += imaginary;
    }
  }
}
const spectrumStops = [[0,0,0],[9,2,3],[30,4,7],[62,8,12],[102,17,20],
  [155,32,29],[210,61,39],[246,114,58],[255,184,102],[255,238,181]];
const spectrumPalette = Array.from({length: 256}, (_, index) => {
  const position = index / 255 * (spectrumStops.length - 1);
  const start = Math.min(spectrumStops.length - 2, Math.floor(position));
  const rgb = spectrumStops[start].map((value, channel) => Math.round(value +
    (spectrumStops[start + 1][channel] - value) * (position - start)));
  return rgb;
});
let spectrumAnimation = null, spectrumAvailable = false;
let spectrumSampleTime = 0, spectrumDrawTime = 0, spectrumVideoTime = null;
const spectrumPlot = {left: 12, top: 20, width: 266, height: 176};
function stopSpectrum() { cancelAnimationFrame(spectrumAnimation); spectrumAnimation = null; }
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
    for (let y = 0; y < spectrumSize; y++) for (let x = 0; x < spectrumSize; x++) {
      const fx = (x + spectrumSize / 2) % spectrumSize, fy = (y + spectrumSize / 2) % spectrumSize;
      const rgb = spectrumPalette[Math.min(255, Math.round(levels[fy * spectrumSize + fx] * 255))];
      const offset = (y * spectrumSize + x) * 4;
      spectrumPixels.data[offset] = rgb[0]; spectrumPixels.data[offset + 1] = rgb[1];
      spectrumPixels.data[offset + 2] = rgb[2];
    }
    spectrumTextureContext.putImageData(spectrumPixels, 0, 0);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(spectrumTexture, left, top, width, height);
  } else {
    context.fillStyle = '#180607'; context.fillRect(left, top, width, height);
    context.fillStyle = '#f5ad76'; context.font = '9px "Luma Mono"';
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
  context.fillStyle = '#f7d989'; context.font = '8px "Luma Mono"';
  context.fillText('SPATIAL FREQUENCY / LOG POWER', left, 11);
  context.fillText('-π', left, 208); context.fillText('0', left + width / 2 - 2, 208);
  context.fillText('+π', left + width - 13, 208);
  spectrumImageContext.drawImage(spectrumCanvas, 0, 0);
  renderSpectrumCursor();
}
function resetSpectrum() {
  stopSpectrum();
  spectrumAvailable = false; spectrumVideoTime = null;
  $('analysis-state').textContent = 'NO SOURCE / WAITING';
  $('signal-readings').textContent = `${spectrumSize}×${spectrumSize} SPATIAL FREQUENCY\nLOAD VIDEO TO ACQUIRE FRAME`;
  drawSpectrum();
}
function sampleSpectrum() {
  if (player.readyState < 2 || !player.videoWidth || document.hidden) return;
  let rgba;
  try {
    frameContext.drawImage(player, 0, 0, spectrumSize, spectrumSize);
    rgba = frameContext.getImageData(0, 0, spectrumSize, spectrumSize).data;
  } catch (error) { $('analysis-state').textContent = 'FRAME UNAVAILABLE'; return; }
  let mean = 0;
  for (let pixel = 0; pixel < spectrumCount; pixel++) {
    const offset = pixel * 4;
    const value = rgba[offset] * .2126 + rgba[offset + 1] * .7152 + rgba[offset + 2] * .0722;
    spectrumReal[pixel] = value; mean += value;
  }
  mean /= spectrumCount;
  for (let y = 0; y < spectrumSize; y++) for (let x = 0; x < spectrumSize; x++) {
    const pixel = y * spectrumSize + x;
    spectrumReal[pixel] = (spectrumReal[pixel] - mean) * windowWeights[x] * windowWeights[y];
  }
  spectrumImaginary.fill(0);
  for (let y = 0; y < spectrumSize; y++) transformSpectrum(y * spectrumSize, 1);
  for (let x = 0; x < spectrumSize; x++) transformSpectrum(x, spectrumSize);
  let peak = 0, low = 0, middle = 0, high = 0, lowCount = 0, middleCount = 0, highCount = 0;
  for (let fy = 0; fy < spectrumSize; fy++) for (let fx = 0; fx < spectrumSize; fx++) {
    const index = fy * spectrumSize + fx;
    const magnitude = Math.log1p(Math.hypot(spectrumReal[index], spectrumImaginary[index]));
    spectrumTarget[index] = magnitude; peak = Math.max(peak, magnitude);
    const radius = Math.hypot(Math.min(fx, spectrumSize - fx), Math.min(fy, spectrumSize - fy));
    if (radius < spectrumSize / 8) { low += magnitude; lowCount++; }
    else if (radius < spectrumSize * 5 / 16) { middle += magnitude; middleCount++; }
    else { high += magnitude; highCount++; }
  }
  const scale = Math.max(1, peak);
  for (let index = 0; index < spectrumCount; index++) spectrumTarget[index] = Math.pow(spectrumTarget[index] / scale, 2.2);
  if (!spectrumAvailable || player.paused) {
    spectrumDisplay.set(spectrumTarget);
    drawSpectrum(spectrumDisplay);
  }
  spectrumAvailable = true; spectrumVideoTime = player.currentTime;
  $('analysis-state').textContent = player.paused ? 'FRAME SPECTRUM / HOLD' : 'LIVE SPECTRUM / 8 HZ';
  $('signal-readings').textContent = `FRAME ${player.currentTime.toFixed(2)}s / ${spectrumSize}×${spectrumSize} LUMA\nLOW ${(low / lowCount).toFixed(1)}  MID ${(middle / middleCount).toFixed(1)}  HIGH ${(high / highCount).toFixed(1)}`;
}
function animateSpectrum(now) {
  if (document.hidden || player.paused || player.ended) { stopSpectrum(); return; }
  if (now - spectrumSampleTime >= spectrumSampleInterval) {
    if (player.currentTime !== spectrumVideoTime) sampleSpectrum();
    spectrumSampleTime = now - (now - spectrumSampleTime) % spectrumSampleInterval;
  }
  const elapsed = now - spectrumDrawTime;
  if (elapsed >= spectrumDrawInterval) {
    if (spectrumAvailable) {
      // Ease between real samples for fluid motion without more frame readbacks.
      const blend = 1 - Math.exp(-elapsed / 70);
      for (let index = 0; index < spectrumCount; index++) {
        spectrumDisplay[index] += (spectrumTarget[index] - spectrumDisplay[index]) * blend;
      }
      drawSpectrum(spectrumDisplay);
    }
    spectrumDrawTime = now - elapsed % spectrumDrawInterval;
  }
  spectrumAnimation = requestAnimationFrame(animateSpectrum);
}
function startSpectrum() {
  stopSpectrum();
  if (document.hidden) return;
  sampleSpectrum();
  spectrumSampleTime = spectrumDrawTime = performance.now();
  spectrumAnimation = requestAnimationFrame(animateSpectrum);
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
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopSpectrum();
  else if (!player.paused && !player.ended) startSpectrum();
  else sampleSpectrum();
});
resetSpectrum();

document.fonts.ready.then(() => drawSpectrum(spectrumAvailable ? spectrumDisplay : null));
