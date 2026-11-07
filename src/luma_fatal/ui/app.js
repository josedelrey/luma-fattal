'use strict';
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');
const secured = path => `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
$('logo-image').src = secured('/assets/logo-purple.png');
for (const [surface, filename] of Object.entries({body: 'viscera', controls: 'panel-078-red', previews: 'panel-078-red'})) {
  document.documentElement.style.setProperty(`--${surface}-texture`, `url('${secured(`/assets/${filename}.png`)}')`);
}
document.documentElement.style.setProperty('--monitor-texture', `url('${secured('/assets/panel-078-red.png')}')`);
let config, baseline, presets, upload, originalUrl, resultUrl, busy = false, revision = 0, previewRevision = -1, timer, resultConfig;
const player = $('player');
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
    if (job.analysis) renderSignal(job.analysis, job.state);
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
$('open-video').onclick = $('screen-load').onclick = () => $('video-file').click();
$('video-file').onchange = async event => {
  const file = event.target.files[0]; if (!file || busy) return;
  clearTimeout(timer); setBusy(true); status('COPYING SOURCE TO LOCAL SESSION…'); $('progress').removeAttribute('value');
  try {
    const nextUpload = await api('/api/upload', {method: 'POST', body: file});
    upload = nextUpload; originalUrl = upload.url; resultUrl = undefined;
    $('result-tab').disabled = true; $('export-panel').hidden = true; $('empty-screen').hidden = true;
    $('signal-name').textContent = file.name; $('file-info').textContent = `${upload.width} × ${upload.height} / ${formatTime(upload.duration)}`;
    showVideo(false); placeholders(); revision++; previewRevision = -1;
    resetSignal();
    await acquireSignal();
    status('Video loaded.'); $('progress').value = 0;
  } catch (error) { status(error.message, true); }
  finally { setBusy(false); event.target.value = ''; }
  if (upload && $('auto-preview').checked) preview();
};
$('presets').onchange = () => loadConfig(presets[$('presets').value]);
$('reset').onclick = () => loadConfig(baseline);
$('filter').onchange = () => { config.filter = $('filter').value; changed(); };
$('encoder').onchange = () => { config.video.encoder = $('encoder').value; changed(); };
$('auto-preview').onchange = () => { if ($('auto-preview').checked) preview(); else clearTimeout(timer); };
$('import-preset').onclick = () => $('preset-file').click();
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
$('save-config').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(resultConfig, null, 2)], {type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'luma-fatal-config.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
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

let signalData = null, signalSelected = null, signalState = 'done';
const signalTexture = new Image();
signalTexture.onload = () => renderSignal(signalData, signalState);
signalTexture.src = secured('/assets/viscera.png');
const signalCanvas = $('signal-chart'), signalContext = signalCanvas.getContext('2d');
function resetSignal() { signalData=null; signalSelected=null; renderSignal(null); }
async function acquireSignal() {
  $('analysis-state').textContent='ACQUIRING / LOW-RES SCAN';
  try {
    try { await start('analyze'); }
    catch (error) { if (error.status !== 404) throw error; await analyzeInBrowser(); }
  } catch (error) { $('analysis-state').textContent='SCAN ERROR / RETRY'; $('signal-readings').textContent=error.message; }
}
// Compatibility path for a server started before /api/analyze was added.
function mediaEvent(video, event, action) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); video.removeEventListener(event, done); video.removeEventListener('error', failed); };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Browser cannot decode this source. Restart the UI server to use FFmpeg analysis.')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Video sample timed out. Restart the UI server for FFmpeg analysis.')); }, 15000);
    video.addEventListener(event, done, {once:true});
    video.addEventListener('error', failed, {once:true});
    try { action(); } catch (error) { cleanup(); reject(error); }
  });
}
function browserSignalMetrics(rgba, width, height, previous) {
  const histogram=Array(32).fill(0), rgb=[0,0,0], luma=new Float32Array(width*height);
  let sum=0, square=0, delta=0, dark=0, bright=0;
  for(let pixel=0;pixel<luma.length;pixel++) {
    const offset=pixel*4;
    for(let channel=0;channel<3;channel++) {
      rgb[channel]+=rgba[offset+channel];
      if(previous)delta+=Math.abs(rgba[offset+channel]-previous[offset+channel]);
    }
    const y=rgba[offset]*.2126+rgba[offset+1]*.7152+rgba[offset+2]*.0722;
    luma[pixel]=y; sum+=y; square+=y*y;
    histogram[Math.min(31,Math.floor(y/8))]++;
    if(y<5)dark++; if(y>=250)bright++;
  }
  let horizontal=0,vertical=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const i=y*width+x;
    if(x)horizontal+=Math.abs(luma[i]-luma[i-1]);
    if(y)vertical+=Math.abs(luma[i]-luma[i-width]);
  }
  const count=luma.length, mean=sum/count;
  return {rgb:rgb.map(value=>value/count),luma:mean,contrast:Math.sqrt(Math.max(0,square/count-mean*mean)),
    delta:previous?delta/(count*3):null,dark:dark/count*100,bright:bright/count*100,
    detail:(horizontal/(height*(width-1))+vertical/(width*(height-1)))/2,histogram:histogram.map(value=>value/count*100)};
}
async function analyzeInBrowser() {
  const video=document.createElement('video');
  video.preload='auto'; video.muted=true; video.playsInline=true;
  try {
    await mediaEvent(video,'loadeddata',()=>{video.src=secured(originalUrl);video.load();});
    const scale=Math.min(1,128/Math.max(video.videoWidth,video.videoHeight));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(2,Math.round(video.videoWidth*scale)); canvas.height=Math.max(2,Math.round(video.videoHeight*scale));
    const context=canvas.getContext('2d',{willReadFrequently:true});
    const data={samples:[],duration:upload.duration,dimensions:[canvas.width,canvas.height]};
    let previous=null;
    for(let index=0;index<16;index++) {
      const time=upload.duration*(index+.5)/16;
      await mediaEvent(video,'seeked',()=>{video.currentTime=time;});
      context.drawImage(video,0,0,canvas.width,canvas.height);
      const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
      data.samples.push({time,...browserSignalMetrics(pixels,canvas.width,canvas.height,previous)});
      previous=pixels;
      $('progress').value=(index+1)/16*100;
      status(`ANALYZING / ${index+1} OF 16 FRAMES`);
      renderSignal(data,index===15?'done':'running');
    }
  } finally { video.removeAttribute('src'); video.load(); }
}
$('rescan').onclick = async () => {
  if (busy || !upload) return;
  setBusy(true); resetSignal();
  try { await acquireSignal(); } finally { setBusy(false); }
};
function renderSignal(data, state = 'done') {
  signalData=data; signalState=state;
  const context=signalContext;
  context.setTransform(2,0,0,2,0,0); context.clearRect(0,0,290,220);
  context.font='8px monospace'; context.lineWidth=.5;
  const ink=(color,text,x,y) => { context.fillStyle=color; context.fillText(text,x,y); };
  context.fillStyle='#000000'; context.fillRect(0,0,290,220);
  for (let x=24;x<280;x+=16) { context.strokeStyle=x%32 ? '#440000':'#000088'; context.beginPath(); context.moveTo(x,14); context.lineTo(x,190); context.stroke(); }
  for (let y=20;y<191;y+=10) { context.strokeStyle='#440000'; context.beginPath(); context.moveTo(24,y); context.lineTo(280,y); context.stroke(); }
  ink('#0000ff','[A] RGB MEAN / 0..255',26,10);
  ink('#0000ff','[B] LUMA DISTRIBUTION / log(1+%)',26,118);
  for (const [label,y] of [['255',23],['128',61],['0',96]]) ink('#ffffff',label,1,y);
  ink('#ffffff','0',24,192); ink('#ffffff','128',141,192); ink('#ffffff','255',263,192);
  if (!data || !data.samples.length) {
    ink('#ff0000','... AWAITING SOURCE ...',59,55);
    ink('#0000ff','NO MEASUREMENTS',87,154);
    $('analysis-state').textContent='NO SOURCE / WAITING';
    $('signal-readings').innerHTML='Y: -- / σ: -- / Δ: --<br>LOAD SOURCE TO ACQUIRE SIGNAL';
    return;
  }
  const samples=data.samples;
  $('analysis-state').textContent=`${state==='running'?'SCANNING':'ACQUIRED'} ${samples.length}/16 / ${data.dimensions.join('×')}`;
  const line=(values,color,top,height,max) => {
    context.strokeStyle=color; context.lineWidth=1; context.beginPath();
    values.forEach((value,index) => { if(value===null)return; const x=24+index/15*252,y=top+height*(1-Math.min(1,value/max)); index ? context.lineTo(x,y):context.moveTo(x,y); });
    context.stroke();
    values.forEach((value,index) => { if(value===null)return; context.fillStyle=color; context.fillRect(23+index/15*252,top+height*(1-Math.min(1,value/max))-1,2,2); });
  };
  ['#0000ff','#ffffff','#0000ff'].forEach((color,channel) => line(samples.map(sample=>sample.rgb[channel]),color,19,76,255));
  context.setLineDash([2,2]);
  line(samples.map(sample=>sample.luma),'#ffffff',19,76,255);
  context.setLineDash([]);
  const histogram=Array.from({length:32},(_,i)=>samples.reduce((sum,sample)=>sum+sample.histogram[i],0)/samples.length);
  const barTexture = signalTexture.complete && signalTexture.naturalWidth ? context.createPattern(signalTexture, 'repeat') : null;
  if (barTexture) histogram.forEach((value,index)=>{ const height=Math.log1p(value)/Math.log(101)*63; context.fillStyle=barTexture; context.fillRect(25+index*7.8,184-height,6,height); });
  const selected=signalSelected===null ? samples.length-1 : Math.min(signalSelected,samples.length-1);
  const sample=samples[selected], x=24+selected/15*252;
  context.strokeStyle='#ffffff'; context.setLineDash([2,3]); context.beginPath(); context.moveTo(x,15); context.lineTo(x,190); context.stroke(); context.setLineDash([]);
  ink('#ffffff',`0s       SOURCE TIME       ${data.duration.toFixed(2)}s`,24,211);
  const f=value=>value===null?'--':value.toFixed(2);
  $('signal-readings').textContent=`S${String(selected+1).padStart(2,'0')} @ ${f(sample.time)}s | Y ${f(sample.luma)} σ ${f(sample.contrast)}\nR ${f(sample.rgb[0])} G ${f(sample.rgb[1])} B ${f(sample.rgb[2])}\nΔ ${f(sample.delta)} | EDGE ${f(sample.detail)}\nY<5 ${f(sample.dark)}% / Y≥250 ${f(sample.bright)}%`;
}
signalCanvas.addEventListener('pointermove', event => {
  if(!signalData)return;
  const rect=signalCanvas.getBoundingClientRect();
  signalSelected=Math.max(0,Math.min(15,Math.round(((event.clientX-rect.left)/rect.width*290-24)/252*15)));
  renderSignal(signalData, signalData.samples.length===16?'done':'running');
}, {passive:true});
signalCanvas.addEventListener('pointerleave',()=>{signalSelected=null;if(signalData)renderSignal(signalData,signalData.samples.length===16?'done':'running');});
resetSignal();
