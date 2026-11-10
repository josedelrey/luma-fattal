'use strict';

// This list defines the panel independently of the selected recipe.
const settingGroups = [
  ['parameters', 'Effect', [
    ['alpha', 'Alpha / gradient scale', 0, 100, 0.01, {exclusiveMin: true}],
    ['beta', 'Beta / detail response', 0, 100, 0.1],
    ['saturation', 'Saturation', 0, 100, 1],
    ['tone_strength', 'Tone strength', 0, 100, 1],
    ['noise', 'Noise', 0, 100, 1],
    ['fade', 'Fade / original blend', 0, 100, 1],
    ['output_gamma', 'Output gamma', 0, null, 0.05, {exclusiveMin: true, sliderMax: 5}],
    ['highlight_compression', 'Highlight compression', 0, 100, 1],
    ['black_level', 'Black level', 0, 100, 1],
    ['white_level', 'White level', 0, 100, 1],
    ['vibrance', 'Vibrance', 0, 100, 1],
  ]],
  ['processing', 'Processing', [
    ['working_resampler', 'Working resampler', ['nearest', 'bilinear', 'bicubic']],
    ['transparency', 'Transparency', ['reject', 'straight']],
    ['blend_mode', 'Blend mode', ['normal']],
  ]],
  ['numerics', 'Numerical controls', [
    ['iterations', 'Solver iterations', 1, null, 1],
    ['relaxation', 'Solver relaxation', 0, 2, 0.01, {exclusiveMin: true, exclusiveMax: true}],
    ['pyramid_min_size', 'Minimum pyramid size', 2, null, 1],
    ['normalization_low', 'Normalization low', 0, 1, 0.001, {exclusiveMax: true}],
    ['normalization_high', 'Normalization high', 0, 1, 0.001, {exclusiveMax: true}],
    ['normalization_floor', 'Normalization floor', 0, 1, 0.0001, {exclusiveMin: true}],
    ['gradient_threshold', 'Gradient threshold', 0, 1, 0.0001, {exclusiveMin: true}],
    ['log_offset', 'Luminance log offset', 0, 1, 0.001, {exclusiveMin: true}],
    ['shadow_threshold', 'Shadow threshold', 0, 255, 1],
    ['shadow_softness', 'Shadow softness', 0, 255, 1],
    ['detail_level', 'Omitted detail levels', 0, null, 1],
    ['power_mode', 'Power function', ['approximate', 'standard']],
    ['luminance_mode', 'Luminance', ['rounded', 'fractional']],
  ]],
  ['video', 'Video source and treatment', [
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
    ['pre_noise_seed', 'Source noise seed', 0, null, 1],
    ['frame_rate', 'Output frame rate', 'text', {placeholder: 'auto or 30000/1001'}],
    ['input_color', 'Source color', ['auto', 'bt709', 'bt601-pal', 'bt601-ntsc', 'srgb', 'bt2020-pq', 'bt2020-hlg']],
    ['input_range', 'Source range', ['auto', 'limited', 'full']],
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
    for (const [section, title, definitions] of settingGroups) {
      const group = document.createElement('fieldset');
      group.className = 'settings-group';
      const legend = document.createElement('legend');
      legend.textContent = title;
      group.append(legend);
      advanced.append(group);
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
            input.min = type;
            if (max !== null) input.max = max;
            input.step = step === 1 && section !== 'parameters' ? '1' : 'any';
            input.required = !settings.nullable;
          } else input.required = type !== 'rgb' && type !== 'boolean';
          if (settings.placeholder) input.placeholder = settings.placeholder;
        }
        row.append(text, input);
        let range;
        if (row.className === 'slider') {
          range = document.createElement('input');
          range.type = 'range';
          range.id = `${section}-${key}-range`;
          range.setAttribute('aria-label', `${label} slider`);
          range.step = step;
          row.append(range);
          range.addEventListener('input', () => {
            input.value = range.value;
          });
        }
        const control = {section, key, input, range, type, max, step, settings};
        this.controls.push(control);
        range?.addEventListener('change', () => this.edit(control));
        input.addEventListener(Array.isArray(type) || type === 'boolean' ? 'change' : 'input', () => this.edit(control));
        (section === 'parameters' && index < 7 ? basic : group).append(row);
      }
    }
  }

  load(config) {
    this.config = config;
    for (const control of this.controls) this.sync(control);
    this.validate();
  }

  sync({section, key, input, range, type, max, step, settings}) {
    const value = this.config[section][key];
    input.setCustomValidity('');
    if (type === 'boolean') input.checked = value;
    else input.value = Array.isArray(value) ? value.join(', ') : value ?? '';
    if (range) {
      // Sliders use practical increments. Numeric fields preserve exact recipe values.
      range.min = Math.min(settings.exclusiveMin ? step : type, value);
      range.max = Math.max(settings.exclusiveMax ? max - step : max ?? settings.sliderMax, value);
      range.value = value;
    }
  }

  edit(control) {
    const {section, key, input, type, settings} = control;
    input.setCustomValidity('');
    let value = input.value;
    if (type === 'boolean') value = input.checked;
    else if (typeof type === 'number') value = value === '' && settings.nullable ? null : input.valueAsNumber;
    else if (type === 'rgb') {
      value = value.trim() === '' ? null : value.split(',').map(part => part.trim() === '' ? NaN : Number(part));
    }
    this.config[section][key] = value;
    if (control.range && Number.isFinite(value)) {
      const draft = input.value;
      this.sync(control);
      input.value = draft;
    }
    this.validate();
    this.onChange();
  }

  validate() {
    for (const {input, type, settings, max} of this.controls) {
      input.setCustomValidity('');
      if (typeof type === 'number' && input.value !== '') {
        const value = input.valueAsNumber;
        if ((settings.exclusiveMin && value <= type) || (settings.exclusiveMax && value >= max)) {
          input.setCustomValidity('Value must be strictly inside the permitted range.');
        }
      }
      if (type === 'rgb' && input.value.trim()) {
        const parts = input.value.split(',');
        if (parts.length !== 3 || parts.some(part => !/^\d+$/.test(part.trim()) || Number(part) > 255)) {
          input.setCustomValidity('Enter three RGB integers from 0 to 255, or leave blank.');
        }
      }
    }
    const check = (section, key, valid, message) => {
      if (!valid) this.controls.find(item => item.section === section && item.key === key).input.setCustomValidity(message);
    };
    const {parameters, numerics, video} = this.config;
    check('parameters', 'black_level', parameters.black_level < parameters.white_level, 'Black level must be below white level.');
    check('numerics', 'normalization_low', numerics.normalization_low < numerics.normalization_high, 'Low quantile must be below high quantile.');
    check('video', 'frame_rate', video.frame_rate === 'auto' || /^(?:\d+(?:\.\d+)?|\d+\/\d+)$/.test(video.frame_rate) &&
      video.frame_rate.split('/').every(part => Number(part) > 0), 'Enter auto or a positive frame rate, such as 30000/1001.');
  }

  valid(report = false) {
    const invalid = this.controls.find(({input}) => !input.validity.valid);
    if (invalid && report) {
      const details = invalid.input.closest('details');
      if (details) details.open = true;
      invalid.input.reportValidity();
    }
    return !invalid;
  }

  setDisabled(value) {
    for (const {input, range} of this.controls) {
      input.disabled = value;
      if (range) range.disabled = value;
    }
  }
}

if (typeof module !== 'undefined') module.exports = {settingGroups, ConfigurationPanel};
