/* ═══════════════════════════════════════════════════════════════
   SAINS AR Hub — Training Overlay Engine
   Version: 1.0.0

   API:
     TrainingOverlay.init({ pageId, steps, autoShow })
     TrainingOverlay.show()
     TrainingOverlay.hide()
     TrainingOverlay.toggle()
     TrainingOverlay.goTo(stepIndex)
     TrainingOverlay.next()
     TrainingOverlay.prev()
     TrainingOverlay.isActive()
   ═══════════════════════════════════════════════════════════════ */
;(function () {
  'use strict';

  const STORAGE_PREFIX = 'sains-training-';
  const TOOLTIP_GAP = 14;
  const SCROLL_PADDING = 80;

  let _config = { pageId: '', steps: [], autoShow: false };
  let _currentStep = -1;
  let _isActive = false;
  let _els = {};

  function injectStyles() {
    if (document.getElementById('training-overlay-css')) return;
    const link = document.createElement('link');
    link.id = 'training-overlay-css';
    link.rel = 'stylesheet';
    link.href = '/training/training-styles.css';
    document.head.appendChild(link);
  }

  function buildDOM() {
    const toggle = document.createElement('button');
    toggle.className = 'training-toggle-btn';
    toggle.setAttribute('aria-label', 'Toggle Training Mode');
    toggle.innerHTML = '<span class="training-toggle-icon">\uD83C\uDF93</span><span class="training-toggle-label">Training Mode</span>';
    toggle.addEventListener('click', () => TrainingOverlay.toggle());

    const backdrop = document.createElement('div');
    backdrop.className = 'training-backdrop';
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) TrainingOverlay.hide(); });

    const spotlight = document.createElement('div');
    spotlight.className = 'training-spotlight';
    spotlight.style.display = 'none';

    const progress = document.createElement('div');
    progress.className = 'training-progress';
    progress.innerHTML = '<div class="training-progress-fill"></div>';

    const counter = document.createElement('div');
    counter.className = 'training-step-counter';

    const tooltip = document.createElement('div');
    tooltip.className = 'training-tooltip';
    tooltip.setAttribute('role', 'dialog');
    tooltip.setAttribute('aria-modal', 'true');
    tooltip.innerHTML = `
      <div class="training-arrow" style="display:none"></div>
      <div class="training-tooltip-header">
        <div class="training-step-badge">1</div>
        <div class="training-tooltip-title"></div>
        <button class="training-tooltip-close" aria-label="Close training">&times;</button>
      </div>
      <div class="training-tooltip-body"></div>
      <div class="training-tooltip-footer">
        <button class="training-nav-btn training-prev-btn" disabled>\u2190 Back</button>
        <span class="training-keyboard-hint">
          <span class="training-kbd">\u2190</span> <span class="training-kbd">\u2192</span> navigate \u00b7 <span class="training-kbd">Esc</span> close
        </span>
        <button class="training-nav-btn primary training-next-btn">Next \u2192</button>
      </div>
    `;

    document.body.appendChild(toggle);
    document.body.appendChild(backdrop);
    document.body.appendChild(spotlight);
    document.body.appendChild(progress);
    document.body.appendChild(counter);
    document.body.appendChild(tooltip);

    tooltip.querySelector('.training-tooltip-close').addEventListener('click', () => TrainingOverlay.hide());
    tooltip.querySelector('.training-prev-btn').addEventListener('click', () => TrainingOverlay.prev());
    tooltip.querySelector('.training-next-btn').addEventListener('click', () => TrainingOverlay.next());

    _els = { toggle, backdrop, spotlight, progress, counter, tooltip };
  }

  function renderDots() {
    const total = _config.steps.length;
    const maxDots = 20;
    let html = '<div class="step-dots">';
    if (total <= maxDots) {
      for (let i = 0; i < total; i++) {
        html += '<div class="step-dot" data-step="' + i + '" title="Step ' + (i+1) + ': ' + _config.steps[i].title + '"></div>';
      }
    }
    html += '</div><span class="training-step-text"></span>';
    _els.counter.innerHTML = html;
    _els.counter.querySelectorAll('.step-dot').forEach(dot => {
      dot.addEventListener('click', () => TrainingOverlay.goTo(parseInt(dot.dataset.step)));
    });
  }

  function updateDots() {
    _els.counter.querySelectorAll('.step-dot').forEach((d, i) => {
      d.classList.toggle('completed', i < _currentStep);
      d.classList.toggle('current', i === _currentStep);
    });
    const t = _els.counter.querySelector('.training-step-text');
    if (t) t.textContent = 'Step ' + (_currentStep + 1) + ' of ' + _config.steps.length;
  }

  function positionTooltip(targetEl, preferredPos) {
    const tooltip = _els.tooltip;
    const arrow = tooltip.querySelector('.training-arrow');

    if (!targetEl) {
      tooltip.classList.add('centered');
      arrow.style.display = 'none';
      _els.spotlight.style.display = 'none';
      return;
    }

    tooltip.classList.remove('centered');
    const tr = targetEl.getBoundingClientRect();
    const tip = tooltip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let pos = preferredPos || 'auto';
    if (pos === 'auto') {
      if (vh - tr.bottom >= tip.height + TOOLTIP_GAP + 20) pos = 'bottom';
      else if (tr.top >= tip.height + TOOLTIP_GAP + 20) pos = 'top';
      else if (vw - tr.right >= tip.width + TOOLTIP_GAP + 20) pos = 'right';
      else if (tr.left >= tip.width + TOOLTIP_GAP + 20) pos = 'left';
      else pos = 'bottom';
    }

    let top, left;
    arrow.className = 'training-arrow';
    arrow.style.display = 'block';

    switch (pos) {
      case 'bottom':
        top = tr.bottom + TOOLTIP_GAP; left = tr.left + (tr.width/2) - (tip.width/2);
        arrow.classList.add('arrow-top'); break;
      case 'top':
        top = tr.top - tip.height - TOOLTIP_GAP; left = tr.left + (tr.width/2) - (tip.width/2);
        arrow.classList.add('arrow-bottom'); break;
      case 'right':
        top = tr.top + (tr.height/2) - (tip.height/2); left = tr.right + TOOLTIP_GAP;
        arrow.classList.add('arrow-left'); break;
      case 'left':
        top = tr.top + (tr.height/2) - (tip.height/2); left = tr.left - tip.width - TOOLTIP_GAP;
        arrow.classList.add('arrow-right'); break;
    }

    left = Math.max(12, Math.min(left, vw - tip.width - 12));
    top = Math.max(12, Math.min(top, vh - tip.height - 12));
    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';
  }

  function positionSpotlight(targetEl) {
    if (!targetEl) { _els.spotlight.style.display = 'none'; return; }
    const r = targetEl.getBoundingClientRect();
    const pad = 6;
    _els.spotlight.style.display = 'block';
    _els.spotlight.style.top = (r.top - pad) + 'px';
    _els.spotlight.style.left = (r.left - pad) + 'px';
    _els.spotlight.style.width = (r.width + pad*2) + 'px';
    _els.spotlight.style.height = (r.height + pad*2) + 'px';
  }

  function scrollToTarget(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < SCROLL_PADDING || r.bottom > window.innerHeight - SCROLL_PADDING) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function activateTabForStep(step) {
    if (!step.activateTab) return;
    const tab = document.querySelector('.tab[data-tab="' + step.activateTab + '"]');
    if (tab) tab.click();
  }

  function renderStep(index) {
    if (index < 0 || index >= _config.steps.length) return;
    _currentStep = index;
    const step = _config.steps[index];
    activateTabForStep(step);

    const delay = step.activateTab ? 100 : 0;
    setTimeout(() => {
      const targetEl = step.target ? document.querySelector(step.target) : null;
      if (targetEl) scrollToTarget(targetEl);

      setTimeout(() => {
        const resolved = step.target ? document.querySelector(step.target) : null;
        _els.tooltip.querySelector('.training-step-badge').textContent = index + 1;
        _els.tooltip.querySelector('.training-tooltip-title').textContent = step.title;
        _els.tooltip.querySelector('.training-tooltip-body').innerHTML = step.content;
        _els.tooltip.querySelector('.training-tooltip-body').scrollTop = 0;

        const prevBtn = _els.tooltip.querySelector('.training-prev-btn');
        const nextBtn = _els.tooltip.querySelector('.training-next-btn');
        prevBtn.disabled = (index === 0);

        if (index === _config.steps.length - 1) {
          nextBtn.style.display = 'none';
          let fin = _els.tooltip.querySelector('.training-nav-finish');
          if (!fin) {
            fin = document.createElement('button');
            fin.className = 'training-nav-finish';
            fin.textContent = '\u2713 Complete Training';
            fin.addEventListener('click', () => { markCompleted(); TrainingOverlay.hide(); });
            _els.tooltip.querySelector('.training-tooltip-footer').appendChild(fin);
          }
          fin.style.display = '';
        } else {
          nextBtn.style.display = '';
          nextBtn.textContent = 'Next \u2192';
          const fin = _els.tooltip.querySelector('.training-nav-finish');
          if (fin) fin.style.display = 'none';
        }

        positionSpotlight(resolved);
        positionTooltip(resolved, step.position);
        _els.tooltip.classList.add('visible');
        _els.progress.querySelector('.training-progress-fill').style.width = ((index+1)/_config.steps.length*100) + '%';
        updateDots();
      }, 250);
    }, delay);
  }

  function markCompleted() {
    try {
      localStorage.setItem(STORAGE_PREFIX + _config.pageId + '-completed', 'true');
      localStorage.setItem(STORAGE_PREFIX + _config.pageId + '-completedAt', new Date().toISOString());
    } catch(e) {}
  }

  function isCompleted() {
    try { return localStorage.getItem(STORAGE_PREFIX + _config.pageId + '-completed') === 'true'; }
    catch(e) { return false; }
  }

  function onKeyDown(e) {
    if (!_isActive) return;
    if (e.key === 'Escape') { e.preventDefault(); TrainingOverlay.hide(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); TrainingOverlay.next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); TrainingOverlay.prev(); }
  }

  let _resizeTimer;
  function onResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (_isActive && _currentStep >= 0) {
        const step = _config.steps[_currentStep];
        const el = step.target ? document.querySelector(step.target) : null;
        positionSpotlight(el);
        positionTooltip(el, step.position);
      }
    }, 150);
  }

  const TrainingOverlay = {
    init(config) {
      _config = Object.assign({ pageId: 'default', steps: [], autoShow: false }, config);
      injectStyles();
      buildDOM();
      renderDots();
      document.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', onResize);
      if (_config.autoShow && !isCompleted()) {
        setTimeout(() => TrainingOverlay.show(), 1200);
      }
    },
    show() {
      if (_isActive) return;
      _isActive = true;
      _els.toggle.classList.add('active');
      _els.toggle.querySelector('.training-toggle-label').textContent = 'Exit Training';
      _els.backdrop.classList.add('visible');
      _els.progress.classList.add('visible');
      _els.counter.classList.add('visible');
      document.body.style.overflow = 'hidden';
      renderStep(_currentStep < 0 ? 0 : _currentStep);
    },
    hide() {
      if (!_isActive) return;
      _isActive = false;
      _els.toggle.classList.remove('active');
      _els.toggle.querySelector('.training-toggle-label').textContent = 'Training Mode';
      _els.backdrop.classList.remove('visible');
      _els.spotlight.style.display = 'none';
      _els.tooltip.classList.remove('visible');
      _els.progress.classList.remove('visible');
      _els.counter.classList.remove('visible');
      document.body.style.overflow = '';
    },
    toggle() { _isActive ? this.hide() : this.show(); },
    next() { if (_currentStep < _config.steps.length - 1) renderStep(_currentStep + 1); },
    prev() { if (_currentStep > 0) renderStep(_currentStep - 1); },
    goTo(i) { if (i >= 0 && i < _config.steps.length) renderStep(i); },
    isActive() { return _isActive; },
    resetProgress() {
      try {
        localStorage.removeItem(STORAGE_PREFIX + _config.pageId + '-completed');
        localStorage.removeItem(STORAGE_PREFIX + _config.pageId + '-completedAt');
      } catch(e) {}
      _currentStep = -1;
    }
  };

  window.TrainingOverlay = TrainingOverlay;
})();
