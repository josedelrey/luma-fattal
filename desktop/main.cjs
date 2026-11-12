'use strict'

const { app, dialog, Menu } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { Backend } = require('./backend.cjs')
const { createWorkbenchWindow } = require('./window.cjs')
const { runtimePaths } = require('./paths.cjs')

app.setName('Luma Fattal')

let backend
let quitting = false

async function openWindow() {
  const paths = runtimePaths(__dirname, process.resourcesPath, app.getPath('userData'), app.isPackaged)
  backend = new Backend(paths, error => {
    if (quitting) return
    dialog.showErrorBox('Luma Fattal backend stopped', error.message)
    app.quit()
  })
  const url = await backend.ready
  if (quitting) return
  const { window, loaded } = createWorkbenchWindow(url, paths.icon)
  await loaded
  if (process.env.LUMA_FATTAL_SMOKE === '1') {
    if (!window.isResizable()) throw new Error('Desktop window is not resizable')
    const state = await window.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      const canvasScale = Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-scale'));
      const bounds = element => {
        const rect = element.getBoundingClientRect();
        return Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height']
          .map(key => [key, rect[key] / canvasScale]));
      };
      const deadline = Date.now() + 10000;
      while (document.querySelector('#presets').options.length < 2 && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 100));
      const panelRect = selector => {
        const rect = bounds(document.querySelector(selector));
        return [rect.left, rect.top, rect.right, rect.bottom];
      };
      const exportPanel = document.querySelector('#export-panel');
      const beforeExport = ['.monitor', '.controls', '.previews', '.signal-lab'].map(panelRect);
      exportPanel.hidden = false;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const exportLayout = {
        top: bounds(exportPanel).top,
        right: bounds(exportPanel).right,
        headerRight: bounds(document.querySelector('.masthead')).right,
        headerBottom: bounds(document.querySelector('.masthead')).bottom,
        panelsStable: ['.monitor', '.controls', '.previews', '.signal-lab'].every((selector, index) =>
          panelRect(selector).every((value, coordinate) => Math.abs(value - beforeExport[index][coordinate]) < 1)),
        bottom: bounds(exportPanel).bottom,
        previewBottom: bounds(document.querySelector('.previews')).bottom,
        signalBottom: bounds(document.querySelector('.signal-lab')).bottom
      };
      document.querySelector('#close-export').click();
      if (!exportPanel.hidden) throw new Error('Export popup did not close');
      const advanced = document.querySelector('.controls details');
      const summary = advanced.querySelector('summary');
      const label = summary.querySelector('span');
      const controlBody = document.querySelector('.control-body');
      const status = document.querySelector('#status');
      const originalStatus = status.textContent;
      for (const message of [originalStatus, 'Processing failed. ' + 'The source could not be decoded. '.repeat(8)]) {
        status.textContent = message;
        const rect = label.getBoundingClientRect();
        for (const fraction of [.2, .5, .8]) {
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height * fraction);
          if (!summary.contains(hit)) throw new Error('More settings label was covered by ' + hit?.className +
            ' at ' + fraction + ' with status length ' + message.length);
        }
      }
      status.textContent = originalStatus;
      label.click();
      if (!advanced.open) throw new Error('More settings did not open from its label');
      await new Promise(resolve => requestAnimationFrame(resolve));
      const workbench = document.querySelector('.workbench');
      const expandedPanels = {
        monitor: panelRect('.monitor'), controls: panelRect('.controls'),
        previews: panelRect('.previews'), spectrum: panelRect('.signal-lab')
      };
      workbench.scrollTop = 200;
      const expandedLayout = {
        panels: expandedPanels,
        viewport: workbench.clientHeight,
        content: workbench.scrollHeight,
        scrollbar: getComputedStyle(workbench).overflowY,
        scrolled: workbench.scrollTop,
        titleTop: bounds(document.querySelector('.application-title')).top,
        titleWidth: bounds(document.querySelector('.application-title')).width
      };
      workbench.scrollTop = workbench.scrollHeight;
      await new Promise(resolve => requestAnimationFrame(resolve));
      expandedLayout.bottomGap = bounds(workbench).bottom -
        bounds(document.querySelector('.signal-lab')).bottom;
      workbench.scrollTop = 200;
      exportPanel.hidden = false;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const expandedExportLayout = {
        exportTop: bounds(exportPanel).top,
        previewBottom: bounds(document.querySelector('.previews')).bottom,
        signalBottom: bounds(document.querySelector('.signal-lab')).bottom,
        exportBottom: bounds(exportPanel).bottom,
        content: workbench.scrollHeight
      };
      exportPanel.hidden = true;
      workbench.scrollTop = 0;
      advanced.open = false;
      const signalReadings = document.querySelector('.signal-readings');
      const originalReadings = signalReadings.innerHTML;
      signalReadings.textContent = [
        'S16 @ 1234.56s | Y 255.00 σ 255.00',
        'R 255.00 G 255.00 B 255.00',
        'Δ 255.00 | EDGE 255.00',
        'Y<5 100.00% / Y≥250 100.00%'
      ].join(String.fromCharCode(10));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const populatedSignalOverflow = Math.max(
        signalReadings.scrollHeight - signalReadings.clientHeight,
        document.querySelector('.signal-lab').scrollHeight - document.querySelector('.signal-lab').clientHeight
      );
      signalReadings.innerHTML = originalReadings;
      controlBody.scrollTop = controlBody.scrollHeight;
      const progressBottom = bounds(document.querySelector('.job-status progress')).bottom;
      controlBody.scrollTop = 0;
      return ({
      title: document.title,
      presets: document.querySelector('#presets').options.length,
      logo: document.querySelector('#logo-image').naturalWidth,
      titleLogo: document.querySelector('#title-logo').naturalWidth,
      video: document.querySelector('#player').canPlayType('video/mp4; codecs="avc1.42E01E"'),
      frame: !!window.desktopWindow && !document.querySelector('#app-frame-controls').hidden,
      styles: document.styleSheets.length,
      texture: getComputedStyle(document.documentElement).getPropertyValue('--body-texture').includes('/assets/viscera.png'),
      fonts: [...document.fonts].every(font => font.status === 'loaded') && document.fonts.size === 4,
      background: getComputedStyle(document.body).backgroundColor,
      viewport: [innerWidth / canvasScale, innerHeight / canvasScale],
      content: [document.documentElement.scrollWidth / canvasScale, document.documentElement.scrollHeight / canvasScale],
      workbench: [document.querySelector('.workbench').offsetWidth, document.querySelector('.workbench').offsetHeight],
      workbenchBottom: bounds(document.querySelector('.workbench')).bottom,
      panels: {
        monitor: panelRect('.monitor'), controls: panelRect('.controls'),
        previews: panelRect('.previews'), spectrum: panelRect('.signal-lab')
      },
      previewOverflow: document.querySelector('.previews').scrollHeight - document.querySelector('.previews').clientHeight,
      signalOverflow: document.querySelector('.signal-lab').scrollHeight - document.querySelector('.signal-lab').clientHeight,
      populatedSignalOverflow,
      videoBottom: bounds(document.querySelector('.monitor')).bottom,
      controlsBottom: bounds(document.querySelector('.controls')).bottom,
      progressBottom,
      previewTop: bounds(document.querySelector('.previews')).top,
      signalTop: bounds(document.querySelector('.signal-lab')).top,
      previewPadding: bounds(document.querySelector('.previews')).bottom - bounds(document.querySelector('.preview-note')).bottom,
      previewBottom: bounds(document.querySelector('.previews')).bottom,
      signalBottom: bounds(document.querySelector('.signal-lab')).bottom,
      signalReadingsBottom: bounds(document.querySelector('.signal-readings')).bottom,
      exportLayout,
      expandedLayout,
      expandedExportLayout
      });
    })()`)
    const { monitor, controls, previews, spectrum } = state.panels
    const alignedPanels = [0, 2].every(index =>
      Math.abs(monitor[index] - previews[index]) < 1 &&
      Math.abs(controls[index] - spectrum[index]) < 1) &&
      [1, 3].every(index =>
        Math.abs(monitor[index] - controls[index]) < 1 &&
        Math.abs(previews[index] - spectrum[index]) < 1)
    const expanded = state.expandedLayout.panels
    const panelHeight = rect => rect[3] - rect[1]
    const panelWidth = rect => rect[2] - rect[0]
    const stableExpandedPanels = ['monitor', 'previews', 'spectrum'].every(name =>
      Math.abs(panelHeight(expanded[name]) - panelHeight(state.panels[name])) < 1) &&
      Math.abs(expanded.previews[1] - previews[1]) < 1 &&
      Math.abs(panelWidth(expanded.monitor) - panelWidth(expanded.previews)) < 1 &&
      Math.abs(panelWidth(expanded.controls) - panelWidth(expanded.spectrum)) < 1 &&
      Math.abs(expanded.spectrum[1] - expanded.controls[3] - 16) < 1
    if (!state.title.includes('Luma Fattal') || state.presets < 2 ||
        !state.logo || !state.titleLogo || !state.video || !state.background || !state.frame ||
        !state.styles || !state.texture || !state.fonts || state.content[1] > state.viewport[1] ||
        state.previewBottom > state.viewport[1] || state.signalReadingsBottom > state.viewport[1] ||
        state.populatedSignalOverflow > 0 || !alignedPanels || !stableExpandedPanels ||
        Math.abs(state.videoBottom - state.controlsBottom) > 1 ||
        state.progressBottom > state.controlsBottom - 4 ||
        state.controlsBottom - state.progressBottom > 11 ||
        Math.abs(state.previewTop - state.signalTop) > 1 ||
        Math.abs(state.previewBottom - state.signalBottom) > 1 ||
        state.previewPadding > 10 ||
        state.exportLayout.bottom > state.viewport[1] ||
        !state.exportLayout.panelsStable ||
        state.exportLayout.bottom > state.exportLayout.headerBottom + 1 ||
        Math.abs(state.exportLayout.right - state.exportLayout.headerRight) > 1 ||
        state.exportLayout.previewBottom > state.viewport[1] ||
        state.exportLayout.signalBottom > state.viewport[1] ||
        Math.abs(state.exportLayout.previewBottom - state.exportLayout.signalBottom) > 1 ||
        state.expandedLayout.content <= state.expandedLayout.viewport ||
        state.expandedLayout.scrollbar !== 'auto' || !state.expandedLayout.scrolled ||
        Math.abs(state.expandedLayout.bottomGap -
          (state.workbenchBottom - state.panels.spectrum[3])) > 3 ||
        state.expandedLayout.titleTop !== 0 ||
        Math.abs(state.expandedExportLayout.exportTop - state.exportLayout.top) > 1 ||
        Math.abs(state.expandedLayout.titleWidth - state.viewport[0]) > 1) {
      throw new Error(`Packaged window smoke failed: ${JSON.stringify(state)}`)
    }
    if (process.env.LUMA_FATTAL_SMOKE_SCREENSHOT) {
      const image = await window.webContents.capturePage()
      writeFileSync(process.env.LUMA_FATTAL_SMOKE_SCREENSHOT, image.toPNG())
    }
    if (process.env.LUMA_FATTAL_SMOKE_EXPANDED_SCREENSHOT) {
      await window.webContents.executeJavaScript("document.querySelector('.controls details').open = true; document.querySelector('.workbench').scrollTop = 200")
      const image = await window.webContents.capturePage()
      writeFileSync(process.env.LUMA_FATTAL_SMOKE_EXPANDED_SCREENSHOT, image.toPNG())
      await window.webContents.executeJavaScript("document.querySelector('.workbench').scrollTop = 0; document.querySelector('.controls details').open = false")
    }
    if (process.env.LUMA_FATTAL_SMOKE_EXPANDED_EXPORT_SCREENSHOT) {
      await window.webContents.executeJavaScript("document.querySelector('.controls details').open = true; document.querySelector('#export-panel').hidden = false; document.querySelector('.workbench').scrollTop = document.querySelector('.workbench').scrollHeight")
      const image = await window.webContents.capturePage()
      writeFileSync(process.env.LUMA_FATTAL_SMOKE_EXPANDED_EXPORT_SCREENSHOT, image.toPNG())
      await window.webContents.executeJavaScript("document.querySelector('#export-panel').hidden = true; document.querySelector('.workbench').scrollTop = 0; document.querySelector('.controls details').open = false")
    }
    if (process.env.LUMA_FATTAL_SMOKE_VIDEO) {
      const endpoint = new URL('/api/upload', url)
      endpoint.search = new URL(url).search
      const response = await fetch(endpoint, {
        method: 'POST', body: readFileSync(process.env.LUMA_FATTAL_SMOKE_VIDEO),
      })
      if (!response.ok) throw new Error(`Packaged playback upload failed (${response.status})`)
      const uploaded = await response.json()
      const videoURL = new URL(uploaded.url, url)
      videoURL.search = new URL(url).search
      const playback = await window.webContents.executeJavaScript(`(async () => {
        const player = document.querySelector('#player');
        player.src = ${JSON.stringify(videoURL.href)};
        await new Promise((resolve, reject) => {
          player.onloadeddata = resolve;
          player.onerror = () => reject(new Error('Packaged video decode failed'));
        });
        await player.play();
        await new Promise(resolve => setTimeout(resolve, 350));
        const seconds = player.currentTime;
        player.pause();
        await new Promise(resolve => setTimeout(resolve, 50));
        return {
          seconds,
          spectrum: document.querySelector('#analysis-state').textContent,
          readings: document.querySelector('#signal-readings').textContent
        };
      })()`)
      if (playback.seconds <= 0 || !playback.spectrum.includes('SPECTRUM') ||
          !playback.readings.includes('LOW')) {
        throw new Error(`Packaged video spectrum failed: ${JSON.stringify(playback)}`)
      }
      if (process.env.LUMA_FATTAL_SMOKE_SPECTRUM_SCREENSHOT) {
        await window.webContents.executeJavaScript(`(() => {
          const chart = document.querySelector('#signal-chart');
          const rect = chart.getBoundingClientRect();
          chart.dispatchEvent(new PointerEvent('pointermove', {
            clientX: rect.left + rect.width * .64,
            clientY: rect.top + rect.height * .5
          }));
        })()`)
        const image = await window.webContents.capturePage()
        writeFileSync(process.env.LUMA_FATTAL_SMOKE_SPECTRUM_SCREENSHOT, image.toPNG())
      }
    }
    const originalSize = window.getContentSize()
    const contentRatio = originalSize[0] / (originalSize[1] - 44)
    for (const [width, height] of [[originalSize[0] - 200, originalSize[1]],
      [originalSize[0] - 200, originalSize[1] - 300]]) {
      window.setContentSize(width, height)
      await new Promise(resolve => setTimeout(resolve, 100))
      const [actualWidth, actualHeight] = window.getContentSize()
      if (Math.abs(actualWidth - (actualHeight - 44) * contentRatio) > 2)
        throw new Error(`Window resize left unused space at ${actualWidth}x${actualHeight}`)
    }
    window.setContentSize(...originalSize)
    await new Promise(resolve => setTimeout(resolve, 100))
    let referenceLayout
    let checkedSizes = 0
    for (const factor of [1, 0.75, 0.5, 0.3]) {
      const width = Math.floor(originalSize[0] * factor)
      const height = Math.round(44 + width * (originalSize[1] - 44) / originalSize[0])
      if (width < 300 || height < 225) continue
      window.setContentSize(width, height)
      const layout = await window.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const workbench = document.querySelector('.workbench');
        const advanced = document.querySelector('.controls details');
        const exported = document.querySelector('#export-panel');
        const layouts = [];
        for (const [expanded, exporting] of [[false, false], [false, true], [true, false], [true, true]]) {
          advanced.open = expanded;
          exported.hidden = !exporting;
          workbench.scrollTop = 0;
          await frame(); await frame();
          const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-scale'));
          const title = document.querySelector('.application-title').getBoundingClientRect();
          const close = document.querySelector('#window-close').getBoundingClientRect();
          if (Math.abs(title.height - 44) > 1 || Math.abs(close.height - 28) > 1)
            throw new Error('Title bar changed size while resizing');
          const origin = workbench.getBoundingClientRect();
          const selectors = ['.monitor', '.controls', '.previews', '.signal-lab',
            '.logo h1', '.logo img', '#parameters', '.slider input'];
          if (exporting) selectors.push('#export-panel');
          layouts.push(selectors.flatMap(selector => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return [(rect.left - origin.left) / scale, (rect.top - origin.top) / scale,
              rect.width / scale, rect.height / scale];
          }));
          if (expanded) {
            const preview = document.querySelector('.previews');
            const initial = preview.getBoundingClientRect();
            const monitor = document.querySelector('.monitor');
            const monitorTop = monitor.getBoundingClientRect().top;
            for (const offset of [1, 200, workbench.scrollHeight, 0]) {
              workbench.scrollTop = offset;
              const current = preview.getBoundingClientRect();
              if (['top', 'right', 'bottom', 'left'].some(edge =>
                Math.abs(current[edge] - initial[edge]) > 1)) {
                throw new Error('Filter preview moved while scrolling at offset ' + offset);
              }
              if (offset > 1 && (!workbench.scrollTop || monitor.getBoundingClientRect().top >= monitorTop))
                throw new Error('Expanded settings did not scroll');
              const auto = document.querySelector('#auto-preview');
              const checkbox = auto.getBoundingClientRect();
              if (document.elementFromPoint(checkbox.left + checkbox.width / 2,
                  checkbox.top + checkbox.height / 2) !== auto)
                throw new Error('Pinned preview checkbox missed its hit area');
            }
          }
        }
        advanced.open = false; exported.hidden = true; workbench.scrollTop = 0;
        const picture = document.querySelector('#large-frame');
        const previousSource = picture.getAttribute('src');
        picture.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"/>';
        await picture.decode();
        const dialog = document.querySelector('#lightbox');
        dialog.showModal();
        await frame(); await frame();
        const rect = dialog.getBoundingClientRect();
        const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-scale'));
        layouts.push([rect.width / scale, rect.height / scale]);
        if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight ||
            Math.abs((rect.left + rect.right) / 2 - innerWidth / 2) > 1 ||
            Math.abs((rect.top + rect.bottom) / 2 - innerHeight / 2) > 1) {
          throw new Error('Scaled preview dialog did not fit centrally');
        }
        const close = document.querySelector('#close-preview');
        const button = close.getBoundingClientRect();
        if (document.elementFromPoint(button.left + button.width / 2,
            button.top + button.height / 2) !== close) throw new Error('Scaled preview button missed its hit area');
        close.click();
        if (dialog.open) throw new Error('Scaled preview did not close');
        if (previousSource === null) picture.removeAttribute('src');
        else picture.src = previousSource;
        return layouts;
      })()`)
      referenceLayout ||= layout
      const differences = layout.flatMap((values, index) => values.flatMap((value, coordinate) =>
        Math.abs(value - referenceLayout[index][coordinate]) > 1
          ? [{ state: index, coordinate, expected: referenceLayout[index][coordinate], actual: value }] : []))
      if (differences.length) {
        throw new Error(`Desktop proportions changed at ${width}x${height}: ${JSON.stringify(differences)}`)
      }
      const actual = window.getContentSize()
      // Fractional display scaling can round native dimensions by one DIP.
      if (Math.abs(actual[0] - width) > 1 || Math.abs(actual[1] - height) > 1) {
        throw new Error(`Desktop scaling smoke could not resize to ${width}x${height}`)
      }
      checkedSizes++
    }
    window.setContentSize(...originalSize)
    console.log(`Packaged window smoke passed: ${JSON.stringify(state)}`)
    console.log(`Desktop scaling smoke passed at ${checkedSizes} window sizes`)
    await window.webContents.executeJavaScript('window.desktopWindow.minimize()')
    window.restore()
    await window.webContents.executeJavaScript("setTimeout(() => document.querySelector('#window-close').click(), 0)")
  }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' }, { role: 'toggleDevTools' }] },
      { role: 'windowMenu' },
    ]))
  } else {
    Menu.setApplicationMenu(null)
  }
  return openWindow()
}).catch(error => {
  if (process.env.LUMA_FATTAL_SMOKE === '1') {
    console.error(error)
    app.exit(1)
    return
  }
  if (quitting) return
  dialog.showErrorBox('Luma Fattal could not start', error.message)
  app.quit()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', event => {
  quitting = true
  if (!backend) return
  event.preventDefault()
  backend.stop().then(() => {
    backend = null
    app.quit()
  }).catch(error => {
    dialog.showErrorBox('Luma Fattal could not stop its backend', error.message)
    app.exit(1)
  })
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit())
