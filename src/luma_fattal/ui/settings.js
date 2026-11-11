'use strict';

function curveValue(points, position) {
  const index = Math.min(Math.floor(position), 3);
  const left = points[index + 1] - points[index];
  const before = index > 0 ? points[index] - points[index - 1] : left;
  const after = index < 3 ? points[index + 2] - points[index + 1] : left;
  const m0 = before * left > 0 ? 2 * before * left / (before + left) : 0;
  const m1 = left * after > 0 ? 2 * left * after / (left + after) : 0;
  const t = position - index, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * points[index] + (t3 - 2 * t2 + t) * m0 +
    (-2 * t3 + 3 * t2) * points[index + 1] + (t3 - t2) * m1;
}

// This list defines the panel independently of the selected recipe.
const settingGroups = [
  ['parameters', 'Effect', [
    ['alpha', 'Alpha / gradient scale', 0, 500, 0.01, {exclusiveMin: true}],
    ['beta', 'Beta / detail response', 0, 100, 0.1],
    ['saturation', 'Saturation', 0, 100, 1],
    ['tone_strength', 'Tone strength', 0, 100, 1],
    ['noise', 'Noise', 0, 100, 1],
    ['fade', 'Fade / original blend', 0, 100, 1],
    ['output_gamma', 'Output gamma', 0, null, 0.05, {exclusiveMin: true, sliderMax: 5}],
    ['highlight_compression', 'Highlight compression', 0, 100, 1],
    ['black_level', 'Black level', 0, 100, 1],
    ['white_level', 'White level', 0, 100, 1],
    ['vibrance', 'Vibrance', -100, 500, 1],
    ['brightness', 'Brightness', -100, 100, 1],
    ['contrast', 'Contrast', -100, 100, 1],
    ['pre_curve_wet', 'Pre curve dry / wet', 0, 100, 1],
    ['post_curve_wet', 'Post curve dry / wet', 0, 100, 1],
    ['pre_curve_0', 'Pre curve / blacks', 0, 100, 1],
    ['pre_curve_25', 'Pre curve / shadows', 0, 100, 1],
    ['pre_curve_50', 'Pre curve / midtones', 0, 100, 1],
    ['pre_curve_75', 'Pre curve / highlights', 0, 100, 1],
    ['pre_curve_100', 'Pre curve / whites', 0, 100, 1],
    ['curve_0', 'Curve / blacks', 0, 100, 1],
    ['curve_25', 'Curve / shadows', 0, 100, 1],
    ['curve_50', 'Curve / midtones', 0, 100, 1],
    ['curve_75', 'Curve / highlights', 0, 100, 1],
    ['curve_100', 'Curve / whites', 0, 100, 1],
  ]],
  ['numerics', 'Numerical controls', [
    ['iterations', 'Solver iterations', 1, null, 1],
    ['relaxation', 'Solver relaxation', 0, 2, 0.01, {exclusiveMin: true, exclusiveMax: true}],
    ['pyramid_min_size', 'Minimum pyramid size', 2, null, 1],
    ['normalization_low', 'Normalization low', 0, 1, 0.001, {exclusiveMax: true}],
    ['normalization_high', 'Normalization high', 0, 1, 0.001, {exclusiveMax: true}],
    ['normalization_floor', 'Normalization floor', 0, 1, 0.0001, {exclusiveMin: true}],
    ['shadow_threshold', 'Shadow threshold', 0, 255, 1],
    ['shadow_softness', 'Shadow softness', 0, 255, 1],
  ]],
  ['video', 'Video source', [
    ['deblock', 'Source deblocking', ['off', 'weak4', 'weak8']],
    ['deband', 'Source debanding', ['off', 'gentle']],
    ['denoise', 'Source denoise', 0, 1, 0.05],
    ['flat_cleanup', 'Flat cleanup', 0, 1, 0.05],
    ['flat_cleanup_mode', 'Cleanup mode', ['standard', 'multiscale']],
    ['flat_cleanup_coarse_strength', 'Broad cleanup strength', 0, 1, 0.05],
    ['flat_cleanup_sigma', 'Broad cleanup radius', 0.01, 16, 0.01],
    ['pre_noise_rms', 'Source noise RMS', 0, 4, 0.05],
    ['pre_noise_kind', 'Source noise kind', ['highpass', 'fbm']],
    ['pre_noise_masked', 'Mask source noise', 'boolean'],
  ]],
  ['video', 'Video encoding', [
    ['encoder', 'Encoder', ['libx264', 'h264_nvenc']],
    ['crf', 'CPU quality / CRF', 0, 51, 1],
    ['preset', 'CPU encoding speed', ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']],
    ['nvenc_cq', 'NVIDIA quality / CQ', 0, 51, 1],
    ['nvenc_preset', 'NVIDIA encoding speed', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']],
  ]],
  ['video', 'Video performance', [
    ['filter_backend', 'Filter backend', ['cpu', 'auto']],
    ['calibration_cache', 'Cache GPU calibration', 'boolean'],
    ['gpu_iterations', 'GPU solver iterations', 1, null, 1, {nullable: true, placeholder: 'Solver iterations'}],
    ['lighting_scale', 'GPU lighting scale', 0.25, 1, 0.05],
    ['decode_prefetch', 'Decode prefetch', 0, 16, 1],
    ['pinned_frames', 'Pinned frame memory', 'boolean'],
    ['gpu_buffer_reuse', 'Reuse GPU buffers', 'boolean'],
    ['gpu_cleanup_graph', 'GPU cleanup graph', 'boolean'],
    ['solver_halo', 'GPU solver halo', 32, 96, 1],
    ['pipeline_depth', 'Pipeline depth', 0, 8, 1],
    ['validation_mode', 'Video validation', ['scan', 'stream']],
  ]],
  ['image', 'Image input (no video effect)', [
    ['color_space', 'Image color space', ['encoded', 'srgb']],
    ['color_backend', 'Image color backend', ['matrix_trc', 'lcms']],
    ['exif_orientation', 'EXIF orientation', ['ignore', 'apply']],
    ['decode_sampling', 'Sample image decoding', 'boolean'],
  ]],
  ['output', 'Image export (no video effect)', [
    ['format', 'Image format', ['png', 'jpeg']],
    ['jpeg_quality', 'JPEG quality', 1, 100, 1],
    ['jpeg_subsampling', 'JPEG subsampling', ['444', '422', '420']],
    ['embed_icc', 'Embed image ICC', 'boolean'],
    ['jpeg_background', 'JPEG background RGB', 'rgb', {placeholder: 'None or 255, 255, 255'}],
  ]],
];

class ConfigurationPanel {
  constructor(basic, advanced, onChange) {
    this.onChange = onChange;
    this.controls = [];
    this.curves = [];
    for (const [section, title, definitions] of settingGroups) {
      const group = document.createElement('fieldset');
      group.className = 'settings-group';
      const legend = document.createElement('legend');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'settings-group-toggle';
      const rows = [];
      const setExpanded = expanded => {
        toggle.textContent = `${expanded ? '−' : '+'} ${title}`;
        toggle.setAttribute('aria-expanded', String(expanded));
        for (const row of rows) row.hidden = !expanded;
      };
      toggle.addEventListener('click', () => setExpanded(toggle.getAttribute('aria-expanded') !== 'true'));
      legend.append(toggle);
      group.append(legend);
      advanced.append(group);
      if (section === 'parameters') for (const [prefix, name] of [['pre_curve_', 'Pre'], ['curve_', 'Post']]) {
        const wrapper = document.createElement('div');
        const heading = document.createElement('div');
        heading.textContent = `${name} curve`;
        wrapper.append(heading);
        const curve = document.createElement('canvas');
        curve.className = 'tone-curve';
        curve.width = 256;
        curve.height = 160;
        curve.setAttribute('aria-label', 'Tone curve. Left and right select a point. Up and down adjust it.');
        curve.tabIndex = 0;
        curve.title = 'Drag a point to adjust the tone curve';
        let selectedPoint = 0;
        const move = event => {
          const bounds = curve.getBoundingClientRect();
          const value = Math.max(0, Math.min(100, Math.round((1 - (event.clientY - bounds.top) / bounds.height) * 100)));
          const control = this.controls.find(item => item.key === `${prefix}${selectedPoint * 25}`);
          if (!control) return;
          control.input.value = String(value);
          this.edit(control, true);
        };
        curve.addEventListener('pointerdown', event => {
          if (this.disabled) return;
          const bounds = curve.getBoundingClientRect();
          selectedPoint = Math.max(0, Math.min(4, Math.round((event.clientX - bounds.left) / bounds.width * 4)));
          curve.setPointerCapture(event.pointerId);
          move(event);
        });
        curve.addEventListener('pointermove', event => { if (curve.hasPointerCapture(event.pointerId)) move(event); });
        curve.addEventListener('keydown', event => {
          if (this.disabled || !this.config) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            selectedPoint = Math.max(0, Math.min(4, selectedPoint + (event.key === 'ArrowRight' ? 1 : -1)));
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            const control = this.controls.find(item => item.key === `${prefix}${selectedPoint * 25}`);
            control.input.value = String(Math.max(0, Math.min(100, Number(control.input.value) + (event.key === 'ArrowUp' ? 1 : -1))));
            this.edit(control, true);
          } else return;
          event.preventDefault();
          curve.setAttribute('aria-label', `Tone curve point ${selectedPoint + 1} of 5, value ${this.config.parameters[`${prefix}${selectedPoint * 25}`]}. Left and right select a point. Up and down adjust it.`);
        });
        const resetCurve = document.createElement('button');
        resetCurve.type = 'button';
        resetCurve.textContent = `Reset ${name.toLowerCase()} curve`;
        resetCurve.addEventListener('click', () => {
          for (const control of this.controls.filter(item => item.key.startsWith(prefix) && /^\d+$/.test(item.key.slice(prefix.length)))) {
            this.config.parameters[control.key] = this.baseline.parameters[control.key];
            this.sync(control);
          }
          this.drawCurve();
          this.onChange();
        });
        this.curves.push({prefix, curve, resetCurve, wrapper});
        wrapper.append(curve);
        group.append(wrapper);
        rows.push(wrapper);
      }
      for (const [index, definition] of definitions.entries()) {
        const [key, label, type, max, step, options = {}] = definition;
        const numeric = typeof type === 'number';
        const settings = numeric ? options : (max || {});
        const row = document.createElement('div');
        row.className = (numeric && max !== null && !settings.nullable) || settings.sliderMax ? 'slider' : 'setting-row';
        row.dataset.setting = `${section}.${key}`;
        const text = document.createElement('label');
        text.textContent = label;
        const input = document.createElement(Array.isArray(type) ? 'select' : 'input');
        input.id = key === 'encoder' ? 'encoder' : `${section}-${key}`;
        text.htmlFor = input.id;
        input.setAttribute('aria-label', label);
        input.title = `${section}.${key}`;
        if (Array.isArray(type)) {
          for (const value of type) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            input.append(option);
          }
        } else {
          input.type = numeric ? 'number' : type === 'boolean' ? 'checkbox' : 'text';
          if (numeric) {
            input.step = step === 1 && section !== 'parameters' ? '1' : 'any';
            input.required = !settings.nullable;
          } else input.required = type !== 'rgb' && type !== 'boolean';
          if (settings.placeholder) input.placeholder = settings.placeholder;
        }
        row.append(text, input);
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'setting-reset';
        reset.textContent = '↺';
        reset.title = `Reset ${label} to preset`;
        reset.setAttribute('aria-label', reset.title);
        row.append(reset);
        let range;
        if (row.className === 'slider') {
          range = document.createElement('input');
          range.type = 'range';
          range.id = `${section}-${key}-range`;
          range.setAttribute('aria-label', `${label} slider`);
          range.step = step;
          range.min = settings.exclusiveMin ? step : type;
          range.max = settings.exclusiveMax ? max - step : max ?? settings.sliderMax;
          row.append(range);
          range.addEventListener('input', () => {
            input.value = range.value;
          });
        }
        const isBasic = section === 'parameters' && index < 7;
        const control = {section, key, input, range, reset, type, settings, expand: isBasic ? null : setExpanded};
        this.controls.push(control);
        reset.addEventListener('click', () => {
          this.config[section][key] = structuredClone(this.baseline[section][key]);
          this.sync(control);
          this.validate();
          this.drawCurve();
          this.onChange();
        });
        range?.addEventListener('change', () => this.edit(control, true));
        input.addEventListener(Array.isArray(type) || type === 'boolean' ? 'change' : 'input', () => this.edit(control));
        if (key === 'pre_curve_wet' || key === 'post_curve_wet') {
          const curve = this.curves[key === 'pre_curve_wet' ? 0 : 1];
          curve.wrapper.append(row, curve.resetCurve);
        } else if (!/^(?:pre_)?curve_\d+$/.test(key)) {
          (isBasic ? basic : group).append(row);
          if (!isBasic) rows.push(row);
        }
      }
      setExpanded(section === 'parameters');
    }
  }

  load(config) {
    this.config = config;
    this.baseline = structuredClone(config);
    for (const control of this.controls) this.sync(control);
    this.validate();
    this.drawCurve();
  }

  drawCurve() {
    if (!this.config) return;
    for (const {curve, prefix} of this.curves) {
    if (!curve.getContext) continue;
    const ctx = curve.getContext('2d');
    const width = curve.width, height = curve.height;
    ctx.fillStyle = '#080000'; ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#4d0808'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * width / 4, 0); ctx.lineTo(i * width / 4, height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * height / 4); ctx.lineTo(width, i * height / 4); ctx.stroke();
    }
    const values = [0, 25, 50, 75, 100].map(x => this.config.parameters[`${prefix}${x}`]);
    const points = values.map((value, i) => [i / 4 * (width - 8) + 4, (1 - Math.max(0, Math.min(100, value)) / 100) * (height - 8) + 4]);
    ctx.strokeStyle = '#ff3030'; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= 256; i++) {
      const x = i / 256 * (width - 8) + 4;
      const value = Math.max(0, Math.min(100, curveValue(values, i / 64)));
      const y = (1 - value / 100) * (height - 8) + 4;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke(); ctx.fillStyle = '#ffb0a0';
    points.forEach(([x, y]) => ctx.fillRect(x - 3, y - 3, 6, 6));
    }
  }

  sync({section, key, input, range, type}) {
    const value = this.config[section][key];
    input.setCustomValidity('');
    if (type === 'boolean') input.checked = value;
    else input.value = Array.isArray(value) ? value.join(', ') : value ?? '';
    if (range) range.value = value;
  }

  edit(control, sliderCommit = false) {
    const {section, key, input, type, settings} = control;
    input.setCustomValidity('');
    let value = input.value;
    if (type === 'boolean') value = input.checked;
    else if (typeof type === 'number') value = value === '' && settings.nullable ? null : input.valueAsNumber;
    else if (type === 'rgb') {
      value = value.trim() === '' ? null : value.split(',').map(part => part.trim() === '' ? NaN : Number(part));
    }
    this.config[section][key] = value;
    if (control.range && Number.isFinite(value)) control.range.value = value;
    this.validate();
    this.drawCurve();
    this.onChange(sliderCommit);
  }

  validate() {
    for (const {input, type} of this.controls) {
      input.setCustomValidity('');
      if (type === 'rgb' && input.value.trim()) {
        const parts = input.value.split(',');
        if (parts.length !== 3 || parts.some(part => !/^\d+$/.test(part.trim()) || Number(part) > 255)) {
          input.setCustomValidity('Enter three RGB integers from 0 to 255, or leave blank.');
        }
      }
    }
    const {numerics} = this.config;
    if (!(numerics.normalization_low < numerics.normalization_high)) {
      const low = this.controls.find(item => item.section === 'numerics' && item.key === 'normalization_low');
      low.input.setCustomValidity('Low quantile must be below high quantile.');
    }
  }

  valid(report = false) {
    const invalid = this.controls.find(({input}) => !input.validity.valid);
    if (invalid && report) {
      const details = invalid.input.closest('details');
      if (details) details.open = true;
      invalid.expand?.(true);
      invalid.input.reportValidity();
    }
    return !invalid;
  }

  setDisabled(value) {
    this.disabled = value;
    for (const {resetCurve} of this.curves) resetCurve.disabled = value;
    for (const {input, range, reset} of this.controls) {
      input.disabled = value;
      reset.disabled = value;
      if (range) range.disabled = value;
    }
  }
}

if (typeof module !== 'undefined') module.exports = {settingGroups, ConfigurationPanel, curveValue};
