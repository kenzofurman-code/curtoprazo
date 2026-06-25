export const registerServiceWorker = () => {
  if (!('serviceWorker' in navigator)) return;

  if (import.meta.env.DEV) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        registration.unregister().then((ok) => {
          if (ok) {
            console.log('Service worker antigo removido em desenvolvimento.');
          }
        });
      }
    });
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => console.log('Service worker registrado:', registration))
      .catch((error) => console.error('Erro ao registrar service worker:', error));
  });
};
