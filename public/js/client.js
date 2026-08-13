document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('convert-form');
  const input = document.getElementById('video-url');
  const errorMsg = document.getElementById('error-message');
  
  const stateInput = document.getElementById('state-input');
  const stateLoading = document.getElementById('state-loading');
  const stateResult = document.getElementById('state-result');
  
  const loadingStatus = document.getElementById('loading-status');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressPercent = document.getElementById('progress-percent');
  
  const videoTitle = document.getElementById('video-title');
  const videoChannel = document.getElementById('video-channel');
  const videoThumb = document.getElementById('video-thumb-container');
  
  const audio = document.getElementById('audio-element');
  const playBtn = document.getElementById('player-play-btn');
  const playSvg = playBtn?.querySelector('.play-svg');
  const pauseSvg = playBtn?.querySelector('.pause-svg');
  const loadingSvg = playBtn?.querySelector('.loading-svg');
  const timeCurrent = document.getElementById('player-time-current');
  const timeTotal = document.getElementById('player-time-total');
  const timeline = document.getElementById('player-timeline');
  const volumeBtn = document.getElementById('player-volume-btn');
  const volHighSvg = volumeBtn?.querySelector('.vol-high-svg');
  const volMuteSvg = volumeBtn?.querySelector('.vol-mute-svg');
  const volumeSlider = document.getElementById('player-volume-slider');
  
  const downloadBtn = document.getElementById('download-btn');
  const downloadSpinner = document.getElementById('download-spinner');
  const downloadLabel = document.getElementById('download-label');
  const convertAnotherBtn = document.getElementById('convert-another-btn');
  const converterBox = document.querySelector('.converter-box');
  const formatSelect = document.getElementById('format-select');
  const genericUrlMode = converterBox?.dataset.genericUrl === 'true';
  const fileInputMode = converterBox?.dataset.inputMode === 'file';
  const supportedInputFormats = ['m4a', 'aac', 'flac', 'mkv', 'mov'];
  const fileInputFormat = supportedInputFormats.includes(converterBox?.dataset.inputFormat) ? converterBox.dataset.inputFormat : 'm4a';
  const fileInputLabel = fileInputFormat.toUpperCase();
  const fileInputPattern = new RegExp(`\\.${fileInputFormat}$`, 'i');
  const supportedFormats = ['mp3', 'wav', 'flac', 'ogg', 'mp4'];
  const defaultFormat = supportedFormats.includes(converterBox?.dataset.format) ? converterBox.dataset.format : 'mp3';
  let outputFormat = defaultFormat;
  
  let videoDuration = 0;
  let currentSourceKey = null;
  let currentSourceUrl = null;
  let cacheReady = false;
  let cachePollingTimer = null;
  let isAudioLoading = false;
  let localObjectUrl = null;
  
  // Status text mapping based on language
  const pageLang = document.documentElement.lang || 'es';
  const isFr = pageLang.startsWith('fr');
  const isEn = pageLang.startsWith('en');
  const invalidUrlText = fileInputMode
    ? (isFr ? `Sélectionnez un fichier ${fileInputLabel} valide de 100 Mo maximum.` : isEn ? `Choose a valid ${fileInputLabel} file up to 100 MB.` : `Selecciona un archivo ${fileInputLabel} válido de hasta 100 MB.`)
    : isFr
      ? 'Veuillez saisir une URL YouTube valide.'
      : isEn
        ? 'Please enter a valid YouTube URL.'
        : 'Por favor, introduce una URL de YouTube válida.';

  function getSelectedFormat() {
    return supportedFormats.includes(formatSelect?.value) ? formatSelect.value : 'mp3';
  }

  function getFormatLabel(format = outputFormat) {
    return format.toUpperCase();
  }

  function getStatusSteps(format = outputFormat) {
    const label = getFormatLabel(format);
    if (fileInputMode) {
      return isFr
        ? ['Lecture du fichier...', 'Téléversement sécurisé...', `Conversion en ${label}...`, 'Finalisation...']
        : isEn
          ? ['Reading file...', 'Uploading securely...', `Converting to ${label}...`, 'Finishing...']
          : ['Leyendo archivo...', 'Subiendo de forma segura...', `Convirtiendo a ${label}...`, 'Finalizando...'];
    }
    if (isFr) {
      return ['Analyse du lien...', 'Récupération de la piste...', `Transcodage en ${label}...`, 'Finalisation...'];
    }
    if (isEn) {
      return ['Analyzing link...', 'Downloading stream...', `Converting to ${label}...`, 'Finishing...'];
    }
    return ['Analizando enlace...', 'Descargando flujo...', `Convirtiendo a ${label}...`, 'Finalizando...'];
  }

  function getDownloadText(format = outputFormat) {
    const label = getFormatLabel(format);
    return isFr ? `Télécharger le ${label}` : isEn ? `Download ${label}` : `Descargar ${label}`;
  }

  function syncSelectedFormat() {
    outputFormat = getSelectedFormat();
    if (converterBox) converterBox.dataset.format = outputFormat;
    if (downloadLabel && !currentSourceKey) downloadLabel.textContent = getDownloadText(outputFormat);
  }

  syncSelectedFormat();

  formatSelect?.addEventListener('change', syncSelectedFormat);

  // Keep the stricter YouTube check on YouTube-specific pages; the URL to MP3 homepage accepts any HTTP(S) video URL.
  const ytRegex = /^(?:https?:\/\/)?(?:www\.)?(?:m\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=)?([a-zA-Z0-9_-]{11})/;

  function isValidHttpUrl(value) {
    try {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname);
    } catch {
      return false;
    }
  }

  function getSourceQuery(sourceUrl) {
    return `source=${encodeURIComponent(sourceUrl)}`;
  }

  function formatTime(secs) {
    if (isNaN(secs) || secs === null || secs === undefined) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Poll cache status until ready
  function startCachePolling(sourceKey, sourceUrl) {
    if (cachePollingTimer) clearInterval(cachePollingTimer);
    cacheReady = false;

    const poll = async () => {
      try {
        const resp = await fetch(`/api/cache-status?${getSourceQuery(sourceUrl)}&format=${outputFormat}`);
        const data = await resp.json();
        if (data.ready) {
          cacheReady = true;
          if (cachePollingTimer) clearInterval(cachePollingTimer);
          onCacheReady(sourceKey, sourceUrl);
        }
      } catch (e) {
        // Silently retry
      }
    };

    // Poll immediately, then every 2s
    poll();
    cachePollingTimer = setInterval(poll, 2000);
  }

  // Called when cache file is ready on the server
  function onCacheReady(sourceKey, sourceUrl) {
    // Swap audio source to cached file for instant playback (supports seeking)
    if (audio && currentSourceKey === sourceKey) {
      const currentTime = audio.currentTime;
      const wasPlaying = !audio.paused;

      audio.src = `/api/stream?${getSourceQuery(sourceUrl)}&format=${outputFormat}`;
      audio.preload = 'auto';
      audio.load();

      // Restore position if user was already playing
      if (wasPlaying || currentTime > 0) {
        audio.addEventListener('canplay', function restore() {
          audio.currentTime = currentTime;
          if (wasPlaying) audio.play().catch(() => {});
          audio.removeEventListener('canplay', restore);
        });
      }
    }

    // Update download link — cached files serve with Content-Length for proper progress
    if (downloadBtn && currentSourceKey === sourceKey) {
      downloadBtn.href = `/api/download?${getSourceQuery(sourceUrl)}&format=${outputFormat}&title=${encodeURIComponent(videoTitle.textContent)}`;
    }

    // Remove preparing indicator from download button
    if (downloadBtn) {
      downloadBtn.classList.remove('preparing');
      if (downloadLabel) downloadLabel.textContent = getDownloadText();
    }
  }

  // Keep exactly one play-button icon visible at every point in the audio lifecycle.
  function setPlayButtonState(state) {
    const isLoading = state === 'loading';
    const isPlaying = state === 'playing';
    isAudioLoading = isLoading;

    playSvg?.classList.toggle('hidden', isLoading || isPlaying);
    pauseSvg?.classList.toggle('hidden', !isPlaying);
    loadingSvg?.classList.toggle('hidden', !isLoading);
    playBtn?.classList.toggle('loading', isLoading);
    playBtn?.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  }

  async function convertLocalFile(file) {
    errorMsg.classList.remove('visible');
    syncSelectedFormat();
    const statusSteps = getStatusSteps(outputFormat);
    stateInput.classList.remove('active');
    stateLoading.classList.add('active');

    let progress = 8;
    const progressInterval = setInterval(() => {
      progress = Math.min(92, progress + Math.max(1, (92 - progress) * 0.08));
      progressBarFill.style.width = `${Math.round(progress)}%`;
      progressPercent.textContent = `${Math.round(progress)}%`;
      loadingStatus.textContent = progress < 30 ? statusSteps[0] : progress < 60 ? statusSteps[1] : progress < 88 ? statusSteps[2] : statusSteps[3];
    }, 180);

    try {
      const response = await fetch(`/api/file-convert?format=${encodeURIComponent(outputFormat)}&input=${fileInputFormat}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name)
        },
        body: file
      });
      if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(details.error || 'File conversion failed');
      }

      const convertedBlob = await response.blob();
      if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
      localObjectUrl = URL.createObjectURL(convertedBlob);
      clearInterval(progressInterval);
      progressBarFill.style.width = '100%';
      progressPercent.textContent = '100%';
      loadingStatus.textContent = statusSteps[3];

      videoTitle.textContent = file.name.replace(fileInputPattern, '') || `Converted ${fileInputLabel} file`;
      videoChannel.textContent = `${fileInputLabel} file • ${(file.size / (1024 * 1024)).toFixed(1)} MB`;
      audio.src = localObjectUrl;
      audio.preload = 'metadata';
      audio.load();
      downloadBtn.href = localObjectUrl;
      downloadBtn.dataset.localBlob = 'true';
      downloadBtn.setAttribute('download', getDownloadFilename(file.name.replace(fileInputPattern, ''), outputFormat));

      window.setTimeout(() => {
        stateLoading.classList.remove('active');
        stateResult.classList.add('active');
      }, 250);
    } catch (error) {
      clearInterval(progressInterval);
      resetUI();
      errorMsg.textContent = error.message || invalidUrlText;
      errorMsg.classList.add('visible');
    }
  }

  // Handle conversion submit
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      if (fileInputMode) {
        const file = input.files?.[0];
        const validFile = file && fileInputPattern.test(file.name) && file.size > 0 && file.size <= 100 * 1024 * 1024;
        if (!validFile) {
          errorMsg.textContent = invalidUrlText;
          errorMsg.classList.add('visible');
          return;
        }
        await convertLocalFile(file);
        return;
      }

      const url = input.value.trim();
      const isValidSource = genericUrlMode ? isValidHttpUrl(url) : ytRegex.test(url);

      if (!isValidSource) {
        errorMsg.textContent = invalidUrlText;
        errorMsg.classList.add('visible');
        return;
      }
      
      errorMsg.classList.remove('visible');
      syncSelectedFormat();
      const conversionFormat = outputFormat;
      const statusSteps = getStatusSteps(conversionFormat);
      
      // Transition to Loading State
      stateInput.classList.remove('active');
      stateLoading.classList.add('active');
      
      // Adaptive progress: slow ramp that never stalls at a fixed percentage
      let progress = 0;
      let infoData = null;
      let fetchFinished = false;
      let errorOccurred = false;
      const startTime = Date.now();
      
      const progressInterval = setInterval(() => {
        if (fetchFinished) {
          // Quickly finish to 100% once API responds
          progress += 8;
        } else {
          // Adaptive slow-down: fast at start, gradually slows as it approaches 95%
          // Uses a logarithmic curve so it never "stalls" at a fixed point
          const elapsed = (Date.now() - startTime) / 1000; // seconds elapsed
          // Target: reach ~60% in 3s, ~80% in 8s, ~90% in 15s, ~95% max
          const target = Math.min(95, 60 * (1 - Math.exp(-elapsed / 3)) + 35 * (1 - Math.exp(-elapsed / 12)));
          progress = Math.max(progress, target);
        }
        
        if (progress > 100) progress = 100;
        
        progressBarFill.style.width = `${Math.round(progress)}%`;
        progressPercent.textContent = `${Math.round(progress)}%`;
        
        // Rotate status text based on progress
        if (progress < 30) {
          loadingStatus.textContent = statusSteps[0];
        } else if (progress < 60) {
          loadingStatus.textContent = statusSteps[1];
        } else if (progress < 90) {
          loadingStatus.textContent = statusSteps[2];
        } else {
          loadingStatus.textContent = statusSteps[3];
        }
        
        if (progress >= 100) {
          clearInterval(progressInterval);
          if (errorOccurred) {
            alert(isFr ? 'Une erreur est survenue lors de la conversion.' : 'Ocurrió un error al convertir el video.');
            resetUI();
            return;
          }
          
          setTimeout(() => {
            // Populate metadata card
            videoTitle.textContent = infoData.title;
            videoDuration = infoData.duration || 0;
            videoChannel.innerHTML = `${infoData.channel} &bull; ${formatTime(videoDuration)}`;
            
            // Set dynamic thumbnail if available
            if (infoData.thumbnail && videoThumb) {
              videoThumb.innerHTML = `<img src="${infoData.thumbnail}" alt="${infoData.title}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px;" />`;
            }
            
            // Store video ID and start cache polling
            currentSourceKey = infoData.sourceKey;
            currentSourceUrl = url;
            startCachePolling(infoData.sourceKey, url);
            
            // Configure audio player source (streaming initially)
            audio.src = `/api/stream?${getSourceQuery(url)}&format=${outputFormat}`;
            audio.preload = 'auto';
            audio.load();
            
            // Pre-populate slider and total time from metadata
            timeTotal.textContent = formatTime(videoDuration);
            timeline.max = videoDuration;
            timeline.value = 0;
            
            // Set download href — download works immediately via live streaming
            downloadBtn.href = `/api/download?${getSourceQuery(url)}&format=${outputFormat}&title=${encodeURIComponent(infoData.title)}`;
            delete downloadBtn.dataset.localBlob;
            downloadBtn.setAttribute('download', getDownloadFilename(infoData.title));
            
            // Transition to Result view
            stateLoading.classList.remove('active');
            stateResult.classList.add('active');
          }, 300);
        }
      }, 100);

      // Fetch metadata from backend
      try {
        const response = await fetch(`/api/info?url=${encodeURIComponent(url)}&format=${outputFormat}`);
        if (!response.ok) throw new Error('API error');
        infoData = await response.json();
        fetchFinished = true;
      } catch (err) {
        console.error('Fetch metadata error:', err);
        errorOccurred = true;
        fetchFinished = true;
      }
    });
  }

  // Sanitize title helper
  function sanitizeFilename(title) {
    return title.replace(/[^a-zA-Z0-9\s-_]/g, '').replace(/\s+/g, '_') || 'audio';
  }

  function getDownloadFilename(title, format = outputFormat) {
    const baseName = sanitizeFilename(title || 'audio');
    const prefixedName = /^convetube[_-]/i.test(baseName) ? baseName : `ConveTube_${baseName}`;
    return `${prefixedName}.${format}`;
  }

  // Reset function
  function resetUI() {
    // Stop cache polling
    if (cachePollingTimer) {
      clearInterval(cachePollingTimer);
      cachePollingTimer = null;
    }
    cacheReady = false;
    currentSourceKey = null;
    currentSourceUrl = null;
    isAudioLoading = false;
    if (localObjectUrl) {
      URL.revokeObjectURL(localObjectUrl);
      localObjectUrl = null;
    }

    // Reset player
    audio.pause();
    audio.src = '';
    audio.currentTime = 0;
    setPlayButtonState('paused');
    timeline.value = 0;
    timeCurrent.textContent = '0:00';
    timeline.style.background = 'rgba(44,40,36,0.1)';
    timeTotal.textContent = '0:00';
    
    // Clear inputs
    input.value = '';
    if (formatSelect) formatSelect.value = defaultFormat;
    syncSelectedFormat();
    progressBarFill.style.width = '0%';
    progressPercent.textContent = '0%';

    // Reset download button
    if (downloadBtn) {
      downloadBtn.classList.remove('preparing');
      delete downloadBtn.dataset.localBlob;
      if (downloadLabel) downloadLabel.textContent = getDownloadText();
    }
    
    // Switch state
    stateResult.classList.remove('active');
    stateLoading.classList.remove('active');
    stateInput.classList.add('active');
  }

  if (convertAnotherBtn) {
    convertAnotherBtn.addEventListener('click', resetUI);
  }

  // Custom Audio Player controls
  if (audio && playBtn) {
    playBtn.addEventListener('click', () => {
      if (isAudioLoading) return; // Don't allow clicks while loading

      if (audio.paused) {
        setPlayButtonState('loading');
        const playRequest = audio.play();
        if (playRequest?.catch) {
          playRequest.catch(err => {
            setPlayButtonState('paused');
            console.warn('Audio playback failed', err);
          });
        }
      } else {
        audio.pause();
      }
    });

    // Listen to native audio events to sync UI state instantly and eliminate flashing
    audio.addEventListener('play', () => {
      setPlayButtonState('playing');
    });

    audio.addEventListener('pause', () => {
      setPlayButtonState('paused');
    });

    // When audio can start playing, remove loading indicator
    audio.addEventListener('canplay', () => {
      if (isAudioLoading && audio.paused) setPlayButtonState('paused');
    });

    // Recover the play icon when the stream is unavailable or interrupted.
    audio.addEventListener('error', () => {
      setPlayButtonState('paused');
      console.warn('Audio element error', audio.error?.code || 'unknown');
    });

    audio.addEventListener('abort', () => {
      if (audio.paused) setPlayButtonState('paused');
    });
    
    // Loaded metadata event
    audio.addEventListener('loadedmetadata', () => {
      const duration = (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) ? audio.duration : videoDuration;
      timeTotal.textContent = formatTime(duration);
      timeline.max = duration;
    });

    // Also listen for durationchange to handle streamed audio
    audio.addEventListener('durationchange', () => {
      if (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) {
        timeTotal.textContent = formatTime(audio.duration);
        timeline.max = audio.duration;
      }
    });
    
    // Time update progress track
    audio.addEventListener('timeupdate', () => {
      timeCurrent.textContent = formatTime(audio.currentTime);
      timeline.value = audio.currentTime;
      // Use videoDuration from metadata as fallback when streaming (audio.duration is Infinity)
      const effectiveDuration = (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) ? audio.duration : videoDuration;
      const percent = effectiveDuration > 0 ? (audio.currentTime / effectiveDuration) * 100 : 0;
      timeline.style.background = `linear-gradient(to right, #C4593D ${percent}%, rgba(44,40,36,0.1) ${percent}%)`;
    });
    
    // Seeker slider control
    timeline.addEventListener('input', () => {
      audio.currentTime = timeline.value;
      const effectiveDuration = (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) ? audio.duration : videoDuration;
      const percent = effectiveDuration > 0 ? (timeline.value / effectiveDuration) * 100 : 0;
      timeline.style.background = `linear-gradient(to right, #C4593D ${percent}%, rgba(44,40,36,0.1) ${percent}%)`;
    });
    
    // Reset on end
    audio.addEventListener('ended', () => {
      setPlayButtonState('paused');
      timeline.value = 0;
      timeCurrent.textContent = '0:00';
      timeline.style.background = 'rgba(44,40,36,0.1)';
    });
    
    // Volume control slider
    if (volumeSlider) {
      volumeSlider.addEventListener('input', () => {
        audio.volume = volumeSlider.value;
        audio.muted = (audio.volume === 0);
        updateVolumeIcons();
      });
    }
    
    // Mute toggle click
    if (volumeBtn) {
      volumeBtn.addEventListener('click', () => {
        audio.muted = !audio.muted;
        if (audio.muted) {
          if (volumeSlider) volumeSlider.value = 0;
        } else {
          if (volumeSlider) volumeSlider.value = audio.volume;
        }
        updateVolumeIcons();
      });
    }
    
    function updateVolumeIcons() {
      if (audio.muted || audio.volume === 0) {
        volHighSvg?.classList.add('hidden');
        volMuteSvg?.classList.remove('hidden');
      } else {
        volHighSvg?.classList.remove('hidden');
        volMuteSvg?.classList.add('hidden');
      }
    }
  }

  // Download button: show feedback when clicked and revert when local download begins
  if (downloadBtn) {
    downloadBtn.addEventListener('click', (e) => {
      if (!downloadLabel) return;
      if (downloadBtn.dataset.localBlob === 'true') return;

      // Prevent duplicate downloads if already in progress
      if (downloadBtn.classList.contains('downloading-active')) {
        e.preventDefault();
        return;
      }

      // Prevent default browser navigation so we can handle it cleanly
      e.preventDefault();

      const originalText = getDownloadText();
      downloadLabel.textContent = isFr ? 'Téléchargement en cours...' : isEn ? 'Downloading...' : 'Descargando...';
      downloadBtn.classList.add('downloading-active');

      // Generate a unique token for this download attempt
      const token = 'dl_token_' + Date.now();

      // Read the current href dynamically and append the token without permanently mutating the button's href
      try {
        const currentHref = downloadBtn.getAttribute('href') || '#';
        const url = new URL(currentHref, window.location.origin);
        url.searchParams.set('downloadToken', token);
        
        // Start the attachment in an isolated frame so the result view and audio element stay mounted.
        const downloadFrame = document.createElement('iframe');
        downloadFrame.hidden = true;
        downloadFrame.title = '';
        downloadFrame.src = url.toString();
        document.body.appendChild(downloadFrame);
        window.setTimeout(() => downloadFrame.remove(), 60000);
      } catch (err) {
        console.error('Failed to trigger download:', err);
      }

      // Poll cookies to detect when the browser receives the file headers and starts the download
      const checkInterval = setInterval(() => {
        if (document.cookie.includes(token)) {
          clearInterval(checkInterval);
          // Revert the button text and state
          downloadLabel.textContent = originalText;
          downloadBtn.classList.remove('downloading-active');
          // Clean up the cookie by expiring it
          document.cookie = `${token}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;`;
        }
      }, 150);

      // Safety timeout: revert after 30 seconds if anything goes wrong or cookies are blocked
      setTimeout(() => {
        clearInterval(checkInterval);
        if (downloadBtn.classList.contains('downloading-active')) {
          downloadLabel.textContent = originalText;
          downloadBtn.classList.remove('downloading-active');
        }
      }, 30000);
    });
  }
});
