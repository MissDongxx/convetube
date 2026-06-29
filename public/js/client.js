document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('convert-form');
  const input = document.getElementById('youtube-url');
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
  
  let videoDuration = 0;
  let currentVideoId = null;
  let cacheReady = false;
  let cachePollingTimer = null;
  let isAudioLoading = false;
  
  // Status text mapping based on language
  const isFr = window.location.pathname.includes('convertir-youtube-vers-mp3');
  const statusSteps = isFr 
    ? ['Analyse du lien...', 'Récupération de la piste...', 'Transcodage en MP3...', 'Finalisation...']
    : ['Analizando enlace...', 'Descargando flujo...', 'Convirtiendo a MP3...', 'Finalizando...'];
    
  const invalidUrlText = isFr 
    ? 'Veuillez saisir une URL YouTube valide.'
    : 'Por favor, introduce una URL de YouTube válida.';

  const preparingText = isFr ? 'Préparation...' : 'Preparando...';

  // YouTube URL regex
  const ytRegex = /^(?:https?:\/\/)?(?:www\.)?(?:m\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=)?([a-zA-Z0-9_-]{11})/;

  function formatTime(secs) {
    if (isNaN(secs) || secs === null || secs === undefined) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Poll cache status until ready
  function startCachePolling(videoId) {
    if (cachePollingTimer) clearInterval(cachePollingTimer);
    cacheReady = false;

    const poll = async () => {
      try {
        const resp = await fetch(`/api/cache-status?id=${videoId}`);
        const data = await resp.json();
        if (data.ready) {
          cacheReady = true;
          if (cachePollingTimer) clearInterval(cachePollingTimer);
          onCacheReady(videoId);
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
  function onCacheReady(videoId) {
    // Swap audio source to cached file for instant playback (supports seeking)
    if (audio && currentVideoId === videoId) {
      const currentTime = audio.currentTime;
      const wasPlaying = !audio.paused;

      audio.src = `/api/stream?id=${videoId}`;
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
    if (downloadBtn && currentVideoId === videoId) {
      downloadBtn.href = `/api/download?id=${videoId}&title=${encodeURIComponent(videoTitle.textContent)}`;
    }

    // Remove preparing indicator from download button
    if (downloadBtn) {
      downloadBtn.classList.remove('preparing');
      if (downloadLabel) downloadLabel.textContent = isFr ? 'Télécharger le MP3' : 'Descargar MP3';
    }
  }

  // Show loading state on play button
  function setPlayLoading(loading) {
    isAudioLoading = loading;
    if (loading) {
      playSvg?.classList.add('hidden');
      pauseSvg?.classList.add('hidden');
      loadingSvg?.classList.remove('hidden');
      playBtn?.classList.add('loading');
    } else {
      loadingSvg?.classList.add('hidden');
      playBtn?.classList.remove('loading');
    }
  }

  // Handle conversion submit
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = input.value.trim();
      const match = url.match(ytRegex);
      
      if (!match) {
        errorMsg.textContent = invalidUrlText;
        errorMsg.classList.add('visible');
        return;
      }
      
      errorMsg.classList.remove('visible');
      
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
            currentVideoId = infoData.id;
            startCachePolling(infoData.id);
            
            // Configure audio player source (streaming initially)
            audio.src = `/api/stream?id=${infoData.id}`;
            audio.preload = 'auto';
            audio.load();
            
            // Pre-populate slider and total time from metadata
            timeTotal.textContent = formatTime(videoDuration);
            timeline.max = videoDuration;
            timeline.value = 0;
            
            // Set download href — download works immediately via live streaming
            downloadBtn.href = `/api/download?id=${infoData.id}&title=${encodeURIComponent(infoData.title)}`;
            downloadBtn.setAttribute('download', `${sanitizeFilename(infoData.title)}.mp3`);
            
            // Transition to Result view
            stateLoading.classList.remove('active');
            stateResult.classList.add('active');
          }, 300);
        }
      }, 100);

      // Fetch metadata from backend
      try {
        const response = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
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

  // Reset function
  function resetUI() {
    // Stop cache polling
    if (cachePollingTimer) {
      clearInterval(cachePollingTimer);
      cachePollingTimer = null;
    }
    cacheReady = false;
    currentVideoId = null;
    isAudioLoading = false;

    // Reset player
    audio.pause();
    audio.src = '';
    audio.currentTime = 0;
    playSvg?.classList.remove('hidden');
    pauseSvg?.classList.add('hidden');
    loadingSvg?.classList.add('hidden');
    playBtn?.classList.remove('loading');
    timeline.value = 0;
    timeCurrent.textContent = '0:00';
    timeline.style.background = 'rgba(44,40,36,0.1)';
    timeTotal.textContent = '0:00';
    
    // Clear inputs
    input.value = '';
    progressBarFill.style.width = '0%';
    progressPercent.textContent = '0%';

    // Reset download button
    if (downloadBtn) {
      downloadBtn.classList.remove('preparing');
      if (downloadLabel) downloadLabel.textContent = isFr ? 'Télécharger le MP3' : 'Descargar MP3';
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
        setPlayLoading(true);
        audio.play().catch(err => {
          setPlayLoading(false);
          console.log('Audio playback failed', err);
        });
      } else {
        audio.pause();
      }
    });

    // Listen to native audio events to sync UI state instantly and eliminate flashing
    audio.addEventListener('play', () => {
      setPlayLoading(false);
      playSvg?.classList.add('hidden');
      pauseSvg?.classList.remove('hidden');
    });

    audio.addEventListener('pause', () => {
      setPlayLoading(false);
      playSvg?.classList.remove('hidden');
      pauseSvg?.classList.add('hidden');
    });

    // When audio can start playing, remove loading indicator
    audio.addEventListener('canplay', () => {
      if (isAudioLoading) {
        setPlayLoading(false);
      }
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
      playSvg?.classList.remove('hidden');
      pauseSvg?.classList.add('hidden');
      loadingSvg?.classList.add('hidden');
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

      // Prevent duplicate downloads if already in progress
      if (downloadBtn.classList.contains('downloading-active')) {
        e.preventDefault();
        return;
      }

      // Prevent default browser navigation so we can handle it cleanly
      e.preventDefault();

      const originalText = isFr ? 'Télécharger le MP3' : 'Descargar MP3';
      downloadLabel.textContent = isFr ? 'Téléchargement en cours...' : 'Descargando...';
      downloadBtn.classList.add('downloading-active');

      // Generate a unique token for this download attempt
      const token = 'dl_token_' + Date.now();

      // Read the current href dynamically and append the token without permanently mutating the button's href
      try {
        const currentHref = downloadBtn.getAttribute('href') || '#';
        const url = new URL(currentHref, window.location.origin);
        url.searchParams.set('downloadToken', token);
        
        // Trigger the download programmatically (browser starts download via attachment header)
        window.location.href = url.toString();
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
