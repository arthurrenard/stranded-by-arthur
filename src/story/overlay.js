// Cinematic DOM overlay (Builder F): subtitles + "Space to skip" + white lightning flash + a title card (v4).
// Used by the intro because the HUD (#hud) is hidden until the intro ends and the black #fade
// (z-index 50) would cover HUD subtitles. This overlay sits at z-index 55 (below the menus at 60).
// All DOM access happens lazily inside functions (node-safe import).
const CSS = `
#story-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 55; font-family: 'Avenir Next', 'Segoe UI', system-ui, sans-serif; }
#story-overlay .so-sub { position: absolute; left: 50%; bottom: 14vh; transform: translateX(-50%); max-width: min(820px, 86vw);
  text-align: center; font-size: clamp(17px, 2.1vw, 24px); line-height: 1.45; color: #f4efe3; letter-spacing: 0.02em;
  text-shadow: 0 2px 10px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.9); font-style: italic; opacity: 0; transition: opacity 0.6s ease; }
#story-overlay .so-sub.on { opacity: 1; }
#story-overlay .so-skip { position: absolute; right: 22px; bottom: 13vh; font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase;
  color: rgba(244,239,227,0.75); opacity: 0; transition: opacity 0.8s ease; }
#story-overlay .so-skip b { border: 1px solid rgba(244,239,227,0.5); border-radius: 4px; padding: 1px 6px; margin-right: 6px; font-weight: 600; }
#story-overlay .so-skip.on { opacity: 1; }
#story-overlay .so-flash { position: absolute; inset: 0; background: #dfe8ff; opacity: 0; mix-blend-mode: screen; }
#story-overlay .so-title { position: absolute; left: 50%; top: 38%; transform: translate(-50%, -50%); text-align: center; opacity: 0;
  transition: opacity 1.1s ease; color: #f6f1e4; text-shadow: 0 2px 18px rgba(0,0,0,0.9), 0 0 3px rgba(0,0,0,0.8); }
#story-overlay .so-title.on { opacity: 1; }
#story-overlay .so-title h1 { margin: 0; font-family: Georgia, 'Times New Roman', serif; font-weight: 600; font-size: clamp(30px, 5.2vw, 64px);
  letter-spacing: 0.22em; text-transform: uppercase; }
#story-overlay .so-title p { margin: 10px 0 0; font-size: clamp(13px, 1.4vw, 18px); letter-spacing: 0.3em; text-transform: uppercase; opacity: 0.85; }
`;

export function createOverlay() {
  let root = null, sub = null, skip = null, flashEl = null, title = null, subTimer = 0, titleTimer = 0;
  function ensure() {
    if (root) return true;
    if (typeof document === 'undefined') return false;
    if (!document.getElementById('story-overlay-css')) {
      const st = document.createElement('style');
      st.id = 'story-overlay-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    root = document.createElement('div');
    root.id = 'story-overlay';
    sub = document.createElement('div');
    sub.className = 'so-sub';
    skip = document.createElement('div');
    skip.className = 'so-skip';
    skip.innerHTML = '<b>Space</b>to skip';
    flashEl = document.createElement('div');
    flashEl.className = 'so-flash';
    title = document.createElement('div');
    title.className = 'so-title';
    root.append(flashEl, sub, skip, title);
    document.body.appendChild(root);
    return true;
  }
  return {
    /** Show a subtitle for `seconds` (call update(dt) every frame for auto-hide). */
    subtitle(text, seconds = 4) {
      if (!ensure()) return;
      sub.textContent = text;
      sub.classList.add('on');
      subTimer = seconds;
    },
    hideSubtitle() {
      subTimer = 0;
      sub?.classList.remove('on');
    },
    showSkip(on) {
      if (!ensure()) return;
      skip.classList.toggle('on', !!on);
    },
    /** White flash (lightning) of peak opacity `amount`, decaying over `seconds`. */
    flash(amount = 0.5, seconds = 0.3) {
      if (!ensure()) return;
      flashEl.style.transition = 'none';
      flashEl.style.opacity = String(amount);
      void flashEl.offsetWidth;
      flashEl.style.transition = `opacity ${seconds}s ease-out`;
      flashEl.style.opacity = '0';
    },
    /** Big centered title card ("DRIFTWOOD ISLE" / "day 3") for `seconds`, fading in and out via CSS. */
    titleCard(text, subText = '', seconds = 4) {
      if (!ensure()) return;
      title.replaceChildren();
      const h1 = document.createElement('h1');
      h1.textContent = text;
      title.appendChild(h1);
      if (subText) {
        const p = document.createElement('p');
        p.textContent = subText;
        title.appendChild(p);
      }
      title.classList.add('on');
      titleTimer = seconds;
    },
    hideTitle() {
      titleTimer = 0;
      title?.classList.remove('on');
    },
    update(dt) {
      if (subTimer > 0) {
        subTimer -= dt;
        if (subTimer <= 0) sub?.classList.remove('on');
      }
      if (titleTimer > 0) {
        titleTimer -= dt;
        if (titleTimer <= 0) title?.classList.remove('on');
      }
    },
  };
}
