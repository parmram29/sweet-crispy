import { money, escapeHtml } from '../services/format.js';
import { waLink } from '../services/whatsapp.js';
import { footerHtml } from '../ui/footer.js';

export class HomePage {
  constructor({ menuStore, router }) {
    this.menuStore = menuStore;
    this.router = router;
    this.root = document.getElementById('page-home');

    this.root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'go-to-pay') this.router.goToPay(btn.dataset.section);
      if (btn.dataset.action === 'go-to') this.router.goTo(btn.dataset.page);
    });

    // Both homepage photo slots degrade to their illustration if no real
    // photo exists yet: drop files at public/images/hero-pizza.jpg and
    // public/images/kitchen.jpg and they appear automatically.
    this.bindPhotoFallback('hero-photo');
    this.bindPhotoFallback('story-photo');
  }

  bindPhotoFallback(imgId) {
    const img = document.getElementById(imgId);
    if (!img) return;
    const showFallback = () => {
      img.style.display = 'none';
      const fallback = img.nextElementSibling;
      if (fallback) fallback.style.display = 'flex';
    };
    // Module scripts are deferred, so the image may have already failed
    // before this listener attaches — check for that case explicitly.
    if (img.complete && img.naturalWidth === 0) showFallback();
    else img.addEventListener('error', showFallback, { once: true });
  }

  async onEnter() {
    await this.menuStore.load();
    document.getElementById('wa-float').href = waLink(this.menuStore.whatsapp, 'Hi Sweet & Crispy!');
    this.renderSignaturePicks();
    document.getElementById('home-footer').innerHTML = footerHtml(this.menuStore.whatsapp);
  }

  renderSignaturePicks() {
    const picks = this.menuStore.signaturePicks(6);
    // A slight, deterministic tilt per card (not random-on-every-render, which
    // would jitter on re-render) — small imperfection reads as handmade rather
    // than a stamped-out grid of identical tiles.
    const tilts = [-2, 1.5, -1, 2, -1.5, 1];
    document.getElementById('sig-grid').innerHTML = picks.map((i, idx) => `
      <div class="sig-card">
        <div class="tag">${i.category === 'pizza' ? '🍕 Pizza' : '🍽 Kitchen'}</div>
        <span class="sig-sticker hand" style="transform:rotate(${tilts[idx % tilts.length]}deg)">family favourite</span>
        <h4>${escapeHtml(i.name)}</h4>
        <p>${escapeHtml(i.description || '')}</p>
        <div class="sig-price">${money(i.price_ec)}${i.price_large_ec ? ' – ' + money(i.price_large_ec) : ''}</div>
      </div>`).join('');
  }
}
