# Design Document: ConveTube YouTube to MP3 Converter (convetube.com)

**Date:** 2026-06-26
**Status:** Approved

---

## 1. Overview
ConveTube (`convetube.com`) is a premium YouTube to MP3 converter tool designed with an SEO-first approach. It combines a simple, high-performance tool page, a search-engine-optimized landing page, and a dynamic results page into a single-page app framework (rendered statically at build time via Astro for edge hosting on Cloudflare).

---

## 2. Architecture & URL Structure
The website uses Astro to pre-render static HTML. The routes are mapped explicitly to target keywords for Spanish and French search volumes.

```
/                         -> (ES) Target: "convertidor youtube", "convertidor de youtube a mp3"
/convertir-youtube-vers-mp3/ -> (FR) Target: "convertir youtube vers mp3"
/convertidor-de-youtube-a-mp3/ -> (ES) Target: "convertidor de youtube a mp3"
    └── convertir-videos-de-youtube-a-mp3/ -> (ES) Target: "convertir videos de youtube a mp3"
```

Each page includes:
- An HTML `lang` attribute corresponding to its language (`es` or `fr`).
- A canonical link (`<link rel="canonical" href="..." />`) pointing to its primary URL.
- Language switcher links in the header linking to other translation paths.

---

## 3. SEO Specifications (TDK)
Each page will have a custom Title, Description, and Heading structure.

### 3.1 Homepage (`/`)
* **Lang:** `es`
* **Title:** `Convertidor YouTube a MP3 Gratis | Descargar Música de YouTube - ConveTube`
* **Description:** `El mejor convertidor YouTube a MP3 gratis. Convierte videos de YouTube a MP3 en segundos con alta calidad. Fácil, rápido y sin registro en ConveTube.`
* **H1:** `Convertidor YouTube a MP3`

### 3.2 French Page (`/convertir-youtube-vers-mp3/`)
* **Lang:** `fr`
* **Title:** `Convertir YouTube vers MP3 Gratuit | Télécharger Vidéo YouTube - ConveTube`
* **Description:** `Convertir YouTube vers MP3 gratuitement et en haute qualité. Télécharger vos musiques et vidéos préférées de YouTube en quelques secondes sur ConveTube.`
* **H1:** `Convertir YouTube vers MP3`

### 3.3 Spanish Secondary Page (`/convertidor-de-youtube-a-mp3/`)
* **Lang:** `es`
* **Title:** `Convertidor de YouTube a MP3 en Alta Calidad | ConveTube`
* **Description:** `Usa el mejor convertidor de YouTube a MP3 online. Descarga audio MP3 de videos de YouTube de forma rápida, segura y totalmente gratis.`
* **H1:** `Convertidor de YouTube a MP3`

### 3.4 Spanish Tertiary Page (`/convertidor-de-youtube-a-mp3/convertir-videos-de-youtube-a-mp3/`)
* **Lang:** `es`
* **Title:** `Cómo Convertir Videos de YouTube a MP3 Paso a Paso | ConveTube`
* **Description:** `Guía y herramienta para convertir videos de YouTube a MP3. Descarga música y audio de YouTube a tu dispositivo móvil o PC con la mejor calidad.`
* **H1:** `Convertir Videos de YouTube a MP3`

---

## 4. UI & Styling (Aesthetics)
The design adopts a premium dark mode, matching the Antigravity/Gemini color scheme:
- **Palette:**
  - Deep blue/black backgrounds: `#0b0f19` and `#111827`
  - Subtle borders and cards: `#1f2937` with `backdrop-filter: blur(12px)`
  - Glowing gradients: `#6366f1` (Indigo) to `#3b82f6` (Blue) for buttons; hover transitions to `#8b5cf6` (Violet) to `#ec4899` (Pink)
- **Typography:** `Plus Jakarta Sans` or `Inter` via Google Fonts.
- **Header:** Features a brand logo and a language selector dropdown.
- **Footer:** Links to privacy policy, DMCA, terms, and internal back-links to home and parent pages.

---

## 5. Converter Logic & Interaction Flow
Since we are using simulated conversion (Option 1):
1. **User Action:** User enters a URL (validated to look like a YouTube URL) and clicks the convert button.
2. **Loading State:** The input fades out or locks, displaying a glowing, smooth animated progress loader (e.g., "Analizando vídeo...", "Extrayendo audio...", "Convirtiendo a MP3...").
3. **Results Display:**
   - Displays a mock card showing video details (thumbnail, duration, title based on the input link or a default high-quality title).
   - Shows a custom HTML5 audio player styled to match the dark theme, allowing the user to play a sample track.
   - Provides a download button that starts downloading a sample audio file.
   - Shows a "Convertir otro" (Convert another) button to reset the state.
