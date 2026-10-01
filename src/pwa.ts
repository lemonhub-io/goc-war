// pwa.ts — service-worker registration + deferred install prompt.
// The #install-toggle button surfaces when the browser reports the app
// installable (beforeinstallprompt); on iOS — which never fires it — the
// button points at the share-sheet flow instead.

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function initPwa(): void {
  const btn = document.getElementById('install-toggle') as HTMLButtonElement | null;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone =
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  if (btn && !standalone) {
    if (isIOS) {
      btn.hidden = false;
      btn.addEventListener('click', () => {
        btn.textContent = 'SHARE ▸ ADD TO HOME SCREEN';
        setTimeout(() => (btn.textContent = 'INSTALL ▸'), 3200);
      });
    } else {
      let deferred: InstallPromptEvent | null = null;
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferred = e as InstallPromptEvent;
        btn.hidden = false;
      });
      btn.addEventListener('click', async () => {
        if (!deferred) return;
        deferred.prompt();
        await deferred.userChoice;
        deferred = null;
        btn.hidden = true;
      });
      window.addEventListener('appinstalled', () => {
        deferred = null;
        btn.hidden = true;
      });
    }
  }

  // register after load so the ~1.4MB precache doesn't race the scene boot
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js');
    });
  }
}
