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
  const timeCurrent = document.getElementById('player-time-current');
  const timeTotal = document.getElementById('player-time-total');
  const timeline = document.getElementById('player-timeline');
  const volumeBtn = document.getElementById('player-volume-btn');
  const volHighSvg = volumeBtn?.querySelector('.vol-high-svg');
  const volMuteSvg = volumeBtn?.querySelector('.vol-mute-svg');
  const volumeSlider = document.getElementById('player-volume-slider');
  
  const downloadBtn = document.getElementById('download-btn');
  const convertAnotherBtn = document.getElementById('convert-another-btn');
  
  let videoDuration = 0; // Track duration from metadata API
  
  // Status text mapping based on language
  const isFr = window.location.pathname.includes('convertir-youtube-vers-mp3');
  const statusSteps = isFr 
    ? ['Analyse du lien...', 'Récupération de la piste...', 'Transcodage en MP3...', 'Finalisation...']
    : ['Analizando enlace...', 'Descargando flujo...', 'Convirtiendo a MP3...', 'Finalizando...'];
    
  const invalidUrlText = isFr 
    ? 'Veuillez saisir une URL YouTube valide.'
    : 'Por favor, introduce una URL de YouTube válida.';

  // YouTube URL regex
  const ytRegex = /^(?:https?:\/\/)?(?:www\.)?(?:m\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=)?([a-zA-Z0-9_-]{11})/;

  function formatTime(secs) {
    if (isNaN(secs) || secs === null || secs === undefined) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
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
            
            // Configure custom Audio Player source
            audio.src = `/api/stream?id=${infoData.id}`;
            audio.load();
            
            // Pre-populate slider and total time from metadata to prevent Infinity:NaN
            timeTotal.textContent = formatTime(videoDuration);
            timeline.max = videoDuration;
            timeline.value = 0;
            
            // Set download href with title query param
            downloadBtn.href = `/api/download?id=${infoData.id}&title=${encodeURIComponent(infoData.title)}`;
            downloadBtn.setAttribute('download', `${sanitizeFilename(infoData.title)}.mp3`);
            
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
    // Reset player
    audio.pause();
    audio.src = '';
    audio.currentTime = 0;
    playSvg?.classList.remove('hidden');
    pauseSvg?.classList.add('hidden');
    timeline.value = 0;
    timeCurrent.textContent = '0:00';
    timeTotal.textContent = '0:00';
    
    // Clear inputs
    input.value = '';
    progressBarFill.style.width = '0%';
    progressPercent.textContent = '0%';
    
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
      if (audio.paused) {
        audio.play().then(() => {
          playSvg?.classList.add('hidden');
          pauseSvg?.classList.remove('hidden');
        }).catch(err => console.log('Audio playback failed', err));
      } else {
        audio.pause();
        playSvg?.classList.remove('hidden');
        pauseSvg?.classList.add('hidden');
      }
    });
    
    // Loaded metadata event
    audio.addEventListener('loadedmetadata', () => {
      const duration = (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) ? audio.duration : videoDuration;
      timeTotal.textContent = formatTime(duration);
      timeline.max = duration;
    });
    
    // Time update progress track
    audio.addEventListener('timeupdate', () => {
      timeCurrent.textContent = formatTime(audio.currentTime);
      timeline.value = audio.currentTime;
    });
    
    // Seeker slider control
    timeline.addEventListener('input', () => {
      audio.currentTime = timeline.value;
    });
    
    // Reset on end
    audio.addEventListener('ended', () => {
      playSvg?.classList.remove('hidden');
      pauseSvg?.classList.add('hidden');
      timeline.value = 0;
      timeCurrent.textContent = '0:00';
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
});
