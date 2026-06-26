# ConveTube SEO YouTube-to-MP3 Converter Implementation Plan

> **For Antigravity:** REQUIRED SUB-SKILL: Load executing-plans to implement this plan task-by-task.

**Goal:** Create a premium YouTube to MP3 converter web application (`convetube.com`) optimized for search engines (SEO) with Spanish and French routes, utilizing Astro on Cloudflare Pages, featuring a premium dark UI and a simulated interactive converter.

**Architecture:** We use Astro for server-side generation (SSG) to output static HTML containing full SEO content (TDK, h1/h2 headings, canonical URLs, and internal links) that crawlers can index without JS. Client-side interactivity is handled via Vanilla JS inside Astro component `<script>` blocks for maximum speed and simplicity.

**Tech Stack:** Astro, HTML5 Audio API, CSS Custom Properties, Cloudflare Pages.

---

## Proposed Changes

### Component 1: Project Initialization

#### [NEW] [package.json](file:///Users/xumingyue/Downloads/MyProjects/Goodparents/Convetube/package.json)
#### [NEW] [astro.config.mjs](file:///Users/xumingyue/Downloads/MyProjects/Goodparents/Convetube/astro.config.mjs)

*   **Step 1:** Initialize the Astro project in the current folder using `create-astro`.
    *   Command: `npx -y create-astro@latest ./ --template minimal --no-install --no-git --yes`
    *   Expected: Success output indicating project is scaffolded.
*   **Step 2:** Install dependencies (`astro`).
    *   Command: `npm install`
    *   Expected: Dependencies installed successfully.
*   **Step 3:** Commit project scaffolding.
    *   Command: `git add package.json astro.config.mjs src/ && git commit -m "chore: scaffold astro project"`

---

### Component 2: Global Layout & Assets

#### [NEW] [global.css](file:///Users/xumingyue/Downloads/MyProjects/Goodparents/Convetube/src/styles/global.css)
#### [NEW] [Layout.astro](file:///Users/xumingyue/Downloads/MyProjects/Goodparents/Convetube/src/layouts/Layout.astro)
#### [NEW] [Header.astro](file:///Users/xumingyue/Downloads/MyProjects/Goodparents/Convetube/src/components/Header.astro)
#### [NEW] [Footer.astro](file:///Users/xumingyue/Downloads/MyProjects/Goodparents/Convetube/src/components/Footer.astro)

*   **Step 1:** Create `src/styles/global.css` with CSS variables for deep-dark colors, typography, glassmorphism border utilities, and animations.
*   **Step 2:** Create `src/components/Header.astro` containing the logo and a language selector dropdown.
*   **Step 3:** Create `src/components/Footer.astro` containing copyright, DMCA notice link, and internal back-links to homepage `/`.
*   **Step 4:** Create `src/layouts/Layout.astro` importing the global CSS, header, and footer, and accepting `title`, `description`, `lang`, and `canonical` props.
*   **Step 5:** Verify compilation by running a local dev server task.
    *   Command: `npm run dev -- --port 4321` (Wait 1000ms, then inspect output)
*   **Step 6:** Commit layout components.
    *   Command: `git add src/styles/global.css src/layouts/Layout.astro src/components/Header.astro src/components/Footer.astro && git commit -m "feat: add global layouts, CSS, and navigation"`

---

### Component 3: The Interactive Converter Component

#### [NEW] [Converter.astro](file:///Users/xumingyue/Downloads/MyProjects/Goodparents/Convetube/src/components/Converter.astro)

*   **Step 1:** Create the HTML structure for the converter widget:
    *   Form input for pasting YouTube URL.
    *   Loading state with a progress bar and status steps ("Analizando...", "Convirtiendo...", etc.).
    *   Result state with mock video thumbnail, custom play/pause audio player controls, volume, seek bar, and download button.
*   **Step 2:** Write client-side JS in the component `<script>` tag:
    *   YouTube URL validation.
    *   3-second simulated progress animation.
    *   Audio playback hook to a public sample MP3 file (e.g. from `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3`).
    *   File download link download action.
*   **Step 3:** Commit converter component.
    *   Command: `git add src/components/Converter.astro && git commit -m "feat: implement interactive simulated converter component"`

---

### Component 4: SEO Pages Generation

#### [NEW] [index.astro](file:///Users/xumingyue/Downloads/MyProjects/Goodparents/Convetube/src/pages/index.astro)
#### [NEW] [convertir-youtube-vers-mp3.astro](file:///Users/xumingyue/Downloads/MyProjects/Goodparents/Convetube/src/pages/convertir-youtube-vers-mp3.astro)
#### [NEW] [convertidor-de-youtube-a-mp3.astro](file:///Users/xumingyue/Downloads/MyProjects/Goodparents/Convetube/src/pages/convertidor-de-youtube-a-mp3.astro)
#### [NEW] [convertir-videos-de-youtube-a-mp3.astro](file:///Users/xumingyue/Downloads/MyProjects/Goodparents/Convetube/src/pages/convertidor-de-youtube-a-mp3/convertir-videos-de-youtube-a-mp3.astro)

*   **Step 1:** Create `src/pages/index.astro` using `Layout.astro` and `Converter.astro`. Add rich Spanish SEO content (H1, H2 sections for features, H3 FAQs, and internal links pointing to other pages).
*   **Step 2:** Create `src/pages/convertir-youtube-vers-mp3.astro` (French). Add rich French SEO content and French translations for the converter texts.
*   **Step 3:** Create `src/pages/convertidor-de-youtube-a-mp3.astro` (Spanish secondary). Add Spanish SEO content.
*   **Step 4:** Create `src/pages/convertidor-de-youtube-a-mp3/convertir-videos-de-youtube-a-mp3.astro` (Spanish tertiary). Add Spanish SEO content and path back-links to `/convertidor-de-youtube-a-mp3/` and `/`.
*   **Step 5:** Commit pages.
    *   Command: `git add src/pages/ && git commit -m "feat: implement all SEO pages and routes"`

---

## Verification Plan

### Automated Verification
*   **Build check:** Run `npm run build` to verify that Astro builds the static directory perfectly with zero errors.
    *   Command: `npm run build`
    *   Expected: "Build finished in..." with zero compiler errors.
*   **SEO check:** Run a local script or command to inspect generated `.html` files in `dist/` directory to ensure they contain:
    *   A single `<h1>` tag per page.
    *   `<link rel="canonical"` matching their target URL.
    *   No empty `alt` attributes on `<img>` tags.
    *   Complete Title and Description in headers.

### Manual Verification
*   Open the dev server and test URL input validation.
*   Verify loading animation, custom audio player streaming, and download triggers.
*   Verify that clicking language dropdown links takes the user to the correct SEO directories.
