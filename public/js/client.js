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
      
      // Simulate progress loader up to 90% while fetching
      let progress = 0;
      let infoData = null;
      let fetchFinished = false;
      let errorOccurred = false;
      
      const progressInterval = setInterval(() => {
        if (progress < 90) {
          progress += 2;
        } else if (fetchFinished) {
          progress += 5;
        }
        
        if (progress > 100) progress = 100;
        
        progressBarFill.style.width = `${progress}%`;
        progressPercent.textContent = `${progress}%`;
        
        // Rotate status text based on progress
        if (progress < 25) {
          loadingStatus.textContent = statusSteps[0];
        } else if (progress < 55) {
          loadingStatus.textContent = statusSteps[1];
        } else if (progress < 85) {
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
            
            // Set download href
            downloadBtn.href = `/api/download?id=${infoData.id}&title=${encodeURIComponent(infoData.title)}`;
            downloadBtn.setAttribute('download', `${sanitizeFilename(infoData.title)}.mp3`);

            // Show "preparing" state on download button if cache not ready
            if (!cacheReady) {
              downloadBtn.classList.add('preparing');
              if (downloadLabel) downloadLabel.textContent = preparingText;
            }
            
            // Transition to Result view
            stateLoading.classList.remove('active');
            stateResult.classList.add('active');
          }, 300);
        }
      }, 50);

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
        audio.play().then(() => {
          setPlayLoading(false);
          playSvg?.classList.add('hidden');
          pauseSvg?.classList.remove('hidden');
        }).catch(err => {
          setPlayLoading(false);
          playSvg?.classList.remove('hidden');
          pauseSvg?.classList.add('hidden');
          console.log('Audio playback failed', err);
        });
      } else {
        audio.pause();
        playSvg?.classList.remove('hidden');
        pauseSvg?.classList.add('hidden');
      }
    });

    // When audio can start playing, remove loading indicator
    audio.addEventListener('canplay', () => {
      if (isAudioLoading) {
        setPlayLoading(false);
        playSvg?.classList.add('hidden');
        pauseSvg?.classList.remove('hidden');
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
      // Update slider visual progress
      const percent = (audio.duration && audio.duration !== Infinity) ? (audio.currentTime / audio.duration) * 100 : 0;
      timeline.style.background = `linear-gradient(to right, #C4593D ${percent}%, rgba(44,40,36,0.1) ${percent}%)`;
    });
    
    // Seeker slider control
    timeline.addEventListener('input', () => {
      audio.currentTime = timeline.value;
      const percent = (audio.duration && audio.duration !== Infinity) ? (timeline.value / audio.duration) * 100 : 0;
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

  // Download button: show loading state when clicked if cache is not ready
  if (downloadBtn) {
    downloadBtn.addEventListener('click', (e) => {
      if (downloadBtn.classList.contains('preparing')) {
        e.preventDefault();
        // Show a subtle message that it's still preparing
        downloadBtn.classList.add('shake');
        setTimeout(() => downloadBtn.classList.remove('shake'), 500);
        return;
      }
    });
  }
});
