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
    const state = await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 10000;
      while (document.querySelector('#presets').options.length < 2 && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 100));
      const exportPanel = document.querySelector('#export-panel');
      exportPanel.hidden = false;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const exportLayout = {
        bottom: exportPanel.getBoundingClientRect().bottom,
        previewBottom: document.querySelector('.previews').getBoundingClientRect().bottom,
        signalBottom: document.querySelector('.signal-lab').getBoundingClientRect().bottom
      };
      exportPanel.hidden = true;
      const advanced = document.querySelector('.controls details');
      advanced.open = true;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const workbench = document.querySelector('.workbench');
      workbench.scrollTop = 200;
      const expandedLayout = {
        viewport: workbench.clientHeight,
        content: workbench.scrollHeight,
        scrollbar: getComputedStyle(workbench).overflowY,
        scrolled: workbench.scrollTop,
        titleTop: document.querySelector('.application-title').getBoundingClientRect().top,
        titleWidth: document.querySelector('.application-title').getBoundingClientRect().width
      };
      exportPanel.hidden = false;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const expandedExportLayout = {
        exportTop: exportPanel.getBoundingClientRect().top,
        previewBottom: document.querySelector('.previews').getBoundingClientRect().bottom,
        signalBottom: document.querySelector('.signal-lab').getBoundingClientRect().bottom,
        exportBottom: exportPanel.getBoundingClientRect().bottom,
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
      return ({
      title: document.title,
      presets: document.querySelector('#presets').options.length,
      logo: document.querySelector('#logo-image').naturalWidth,
      titleLogo: document.querySelector('#title-logo').naturalWidth,
      video: document.querySelector('#player').canPlayType('video/mp4; codecs="avc1.42E01E"'),
      frame: !!window.desktopWindow && !document.querySelector('#app-frame-controls').hidden,
      styles: document.styleSheets.length,
      texture: getComputedStyle(document.documentElement).getPropertyValue('--body-texture').includes('/assets/viscera.png'),
      background: getComputedStyle(document.body).backgroundColor,
      viewport: [innerWidth, innerHeight],
      content: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      workbench: [document.querySelector('.workbench').offsetWidth, document.querySelector('.workbench').offsetHeight],
      previewOverflow: document.querySelector('.previews').scrollHeight - document.querySelector('.previews').clientHeight,
      signalOverflow: document.querySelector('.signal-lab').scrollHeight - document.querySelector('.signal-lab').clientHeight,
      populatedSignalOverflow,
      videoBottom: document.querySelector('.monitor').getBoundingClientRect().bottom,
      controlsBottom: document.querySelector('.controls').getBoundingClientRect().bottom,
      previewTop: document.querySelector('.previews').getBoundingClientRect().top,
      signalTop: document.querySelector('.signal-lab').getBoundingClientRect().top,
      previewPadding: document.querySelector('.previews').getBoundingClientRect().bottom - document.querySelector('.preview-note').getBoundingClientRect().bottom,
      previewBottom: document.querySelector('.previews').getBoundingClientRect().bottom,
      signalBottom: document.querySelector('.signal-lab').getBoundingClientRect().bottom,
      signalReadingsBottom: document.querySelector('.signal-readings').getBoundingClientRect().bottom,
      exportLayout,
      expandedLayout,
      expandedExportLayout
      });
    })()`)
    if (!state.title.includes('Luma Fattal') || state.presets < 2 ||
        !state.logo || !state.titleLogo || !state.video || !state.background || !state.frame ||
        !state.styles || !state.texture || state.content[1] > state.viewport[1] ||
        state.previewBottom > state.viewport[1] || state.signalReadingsBottom > state.viewport[1] ||
        state.populatedSignalOverflow > 0 ||
        Math.abs(state.videoBottom - state.controlsBottom) > 1 ||
        Math.abs(state.previewTop - state.signalTop) > 1 ||
        Math.abs(state.previewBottom - state.signalBottom) > 1 ||
        state.previewPadding > 10 ||
        state.exportLayout.bottom > state.viewport[1] ||
        state.exportLayout.previewBottom > state.viewport[1] ||
        state.exportLayout.signalBottom > state.viewport[1] ||
        Math.abs(state.exportLayout.previewBottom - state.exportLayout.signalBottom) > 1 ||
        state.expandedLayout.content <= state.expandedLayout.viewport ||
        state.expandedLayout.scrollbar !== 'auto' || !state.expandedLayout.scrolled ||
        state.expandedLayout.titleTop !== 0 ||
        state.expandedExportLayout.exportTop < state.expandedExportLayout.previewBottom ||
        state.expandedExportLayout.exportTop - state.expandedExportLayout.previewBottom > 20 ||
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
    console.log(`Packaged window smoke passed: ${JSON.stringify(state)}`)
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
      { role: 'viewMenu' },
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
